// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as Common from '../../core/common/common.js';
import * as SDK from '../../core/sdk/sdk.js';
import * as Protocol from '../../generated/protocol.js';

import type {ExecutionPosition} from './ExecutionHistory.js';
import type {TargetKind} from './ReplayEndpoint.js';
import {REPLAY_LIMITS} from './ReplayLimits.js';
import {ReplaySession} from './ReplaySession.js';

const REPLAY_TIMEOUT_MS = 30_000;

interface ConsoleInput {
  expression: string;
  useCommandLineAPI: boolean;
  userGesture: boolean;
  afterPosition: number;
}

interface RecordedScript {
  url: string;
  positions: Set<string>;
  debuggerStatements: Set<string>;
}

export const enum Events {
  CHANGED = 'Changed',
}

interface EventTypes {
  [Events.CHANGED]: void;
}

/** 입력 경로와 관계없이 실행 위치를 기록한다. 프로세스 재시작 방법은 외부에서 주입한다. */
export class ReplayController extends Common.ObjectWrapper.ObjectWrapper<EventTypes> {
  static #instance: ReplayController;
  readonly session = new ReplaySession();
  #kind: TargetKind = 'page';
  #entryURL = '';
  #debuggerModel: SDK.DebuggerModel.DebuggerModel|null = null;
  #connectToTarget: ((ws: string) => Promise<void>)|null = null;
  #restartTarget: (() => Promise<string>)|null = null;
  #listeners: Common.EventTarget.EventDescriptor[] = [];
  #recordingBreakpointIds = new Set<string>();
  #scripts = new Map<string, RecordedScript>();
  #consoleSources = new Map<string, Promise<string|null>>();
  #consoleInputs: ConsoleInput[] = [];
  #consoleBytes = 0;
  #idleTimer: ReturnType<typeof setTimeout>|undefined;
  #lastActivityAt = 0;
  #activeConsoleInput: number|null = null;
  #replayGeneration = 0;
  #replayInputCount = 0;
  #replayedPositions = 0;
  #progressListeners = new Set<() => void>();
  #lastPosition: ExecutionPosition|null = null;
  #isReplaying = false;
  #resolveReplay: (() => void)|null = null;
  #rejectReplay: ((error: Error) => void)|null = null;

  static instance(): ReplayController {
    this.#instance ??= new ReplayController();
    return this.#instance;
  }

  get busy(): boolean {
    return this.#isReplaying;
  }

  get currentPosition(): ExecutionPosition|null {
    return this.#lastPosition;
  }

  get inputCount(): number {
    return this.#consoleInputs.length;
  }

  canReverse(model: SDK.DebuggerModel.DebuggerModel|null): boolean {
    return Boolean(this.#restartTarget) && model === this.#debuggerModel && Boolean(model?.isPaused()) &&
        !this.#isReplaying && this.session.canReverse;
  }

  get status(): string {
    if (this.session.error) {
      return `뒤로가기 사용 불가: ${this.session.error}`;
    }
    if (this.#isReplaying) {
      return '이전 실행 위치까지 다시 실행하고 있습니다.';
    }
    if (!this.#restartTarget) {
      return '실행 위치를 기록 중입니다. 뒤로가기는 프로세스 재시작 연동 후 사용할 수 있습니다.';
    }
    return this.session.canReverse ? '프로세스를 다시 실행하여 직전 실행 위치로 이동' : '기록된 이전 실행 위치가 없습니다.';
  }

  configure(kind: TargetKind, connect: (ws: string) => Promise<void>): void {
    this.#kind = kind;
    this.#connectToTarget = connect;
  }

  dispose(): void {
    this.#releaseRecording();
    this.session.reset();
    Common.EventTarget.removeEventListeners(this.#listeners);
    this.#debuggerModel?.setPauseInterceptor(null);
    this.#debuggerModel?.setExecutionInterceptor(null);
  }

  setRestartHandler(restart: (() => Promise<string>)|null): void {
    this.#restartTarget = restart;
    this.#notifyStatusChanged();
  }

  attach(target: SDK.Target.Target): void {
    const model = target.model(SDK.DebuggerModel.DebuggerModel);
    if (!model) {
      throw new Error('디버거를 제공하지 않는 대상입니다.');
    }
    if (this.#debuggerModel && !this.#isReplaying) {
      this.#releaseRecording();
      this.session.reset();
      this.#entryURL = '';
    }
    Common.EventTarget.removeEventListeners(this.#listeners);
    this.#debuggerModel = model;
    this.#recordingBreakpointIds.clear();
    this.#scripts.clear();
    this.#consoleSources.clear();
    this.#activeConsoleInput = null;
    model.setPauseInterceptor(details => this.#handlePause(details));
    model.setExecutionInterceptor(command => this.#handleExecutionCommand(command));
    this.#observeTarget(model);
    if (!Common.Settings.Settings.instance().moduleSetting('breakpoints-active').get()) {
      this.fail(new Error('브레이크포인트를 활성화한 새 세션에서 기록을 시작하세요.'));
    }
    this.#notifyStatusChanged();
  }

  async reverse(): Promise<void> {
    if (!this.canReverse(this.#debuggerModel) || !this.#connectToTarget) {
      throw new Error(this.status);
    }
    const completion = this.#beginReplay();
    try {
      // 연결이 열린 뒤 응답이 오지 않는 경우도 제한 시간에 포함한다.
      await Promise.race([this.#restartAndReplay(completion.promise), completion.promise]);
    } catch (error) {
      this.fail(error);
      throw error;
    } finally {
      completion.clearTimeout();
      this.#resolveReplay = null;
      this.#rejectReplay = null;
      this.#isReplaying = false;
      this.#notifyProgress();
      this.#notifyStatusChanged();
    }
  }

  fail(error: unknown): void {
    if (this.session.error) {
      return;
    }
    this.session.fail(error);
    this.#rejectReplay?.(new Error(this.session.error ?? '재실행 실패'));
    this.#debuggerModel?.setExecutionInterceptor(null);
    this.#debuggerModel?.setPauseInterceptor(null);
    this.#releaseRecording();
    Common.Console.Console.instance().error(`BackDo: ${this.session.error}`);
    if (this.#isReplaying) {
      void this.#debuggerModel?.agent.invoke_pause();
    }
    this.#notifyProgress();
    this.#notifyStatusChanged();
  }

  #observeTarget(model: SDK.DebuggerModel.DebuggerModel): void {
    this.#listeners.push(model.addEventListener(SDK.DebuggerModel.Events.GlobalObjectCleared, () => {
      if (!this.#isReplaying) {
        this.#releaseRecording();
        this.session.reset();
        this.#entryURL = '';
        model.setPauseInterceptor(details => this.#handlePause(details));
        model.setExecutionInterceptor(command => this.#handleExecutionCommand(command));
        this.#notifyStatusChanged();
      }
    }));
    const breakpoints = Common.Settings.Settings.instance().moduleSetting('breakpoints-active');
    this.#listeners.push(breakpoints.addChangeListener(() => {
      if (!breakpoints.get()) {
        this.fail(new Error('브레이크포인트 비활성화로 실행 기록이 끊겼습니다.'));
      }
    }));
    this.#listeners.push(model.addEventListener(SDK.DebuggerModel.Events.ScriptSourceWasEdited, () => {
      this.fail(new Error('소스가 변경되었습니다. 새 세션에서 기록을 시작하세요.'));
    }));
    this.#listeners.push(model.addEventListener(SDK.DebuggerModel.Events.ParsedScriptSource, event => {
      this.#identifyConsoleSource(event.data);
    }));
    this.#listeners.push(model.addEventListener(SDK.DebuggerModel.Events.DebuggerPaused, () => {
      // SDK가 최종 정지를 알린 뒤 완료한다. 에디터 준비는 화면 계층에서 기다린다.
      if (this.#isReplaying && !this.session.replaying && !this.session.error) {
        queueMicrotask(() => this.#resolveReplay?.());
      }
      this.#notifyStatusChanged();
    }));
    this.#listeners.push(model.addEventListener(SDK.DebuggerModel.Events.DebuggerResumed, () => this.#notifyStatusChanged()));
    const consoleModel = model.target().model(SDK.ConsoleModel.ConsoleModel);
    if (consoleModel) {
      this.#listeners.push(consoleModel.addEventListener(SDK.ConsoleModel.Events.CommandWillBeEvaluated, event => {
        this.#recordConsoleInput(event.data);
      }));
    }
  }

  #recordConsoleInput(command: SDK.ConsoleModel.ConsoleCommand): void {
    if (this.session.error || this.#isReplaying) {
      return;
    }
    if (this.#debuggerModel?.isPaused()) {
      this.fail(new Error('일시정지 중 콘솔에서 실행한 코드는 복원할 수 없습니다. 새 실행 컨텍스트에서 시작하세요.'));
      return;
    }
    const {expression, useCommandLineAPI, userGesture} = command;
    const bytes = expression.length * 2;
    if (this.#consoleInputs.length >= REPLAY_LIMITS.consoleInputs ||
        this.#consoleBytes + bytes > REPLAY_LIMITS.consoleBytes) {
      this.fail(new Error('콘솔 입력 기록 한도에 도달했습니다. 새 실행 컨텍스트에서 시작하세요.'));
      return;
    }
    this.#consoleBytes += bytes;
    this.#touchActivity();
    this.#activeConsoleInput = this.#consoleInputs.length;
    this.#consoleInputs.push({expression, useCommandLineAPI, userGesture, afterPosition: this.session.history.length});
  }

  #identifyConsoleSource(script: SDK.Script.Script): void {
    const index = this.#activeConsoleInput;
    if (index === null) {
      return;
    }
    const input = this.#consoleInputs[index];
    if (!input) {
      return;
    }
    if (this.#consoleSources.size >= REPLAY_LIMITS.pendingSources) {
      this.fail(new Error('콘솔 소스 식별 한도에 도달했습니다.'));
      return;
    }
    // VM 번호와 scriptId는 재연결마다 달라진다. 원문이 일치하는 입력 순번으로 비교한다.
    const source = script.debuggerModel.agent.invoke_getScriptSource({scriptId: script.scriptId})
                       .then(result => !result.getError() && result.scriptSource === input.expression ?
                                 `backdo-console:///${index + 1}` : null, () => null);
    this.#consoleSources.set(script.scriptId, source);
    void source.then(url => {
      if (!url && this.#consoleSources.get(script.scriptId) === source) {
        this.#consoleSources.delete(script.scriptId);
      }
    });
  }

  #beginReplay(): {promise: Promise<void>, clearTimeout: () => void} {
    this.#touchActivity();
    this.session.beginReverse();
    this.#replayGeneration++;
    this.#isReplaying = true;
    this.#replayedPositions = 0;
    this.#replayInputCount = 0;
    this.#notifyStatusChanged();
    const promise = new Promise<void>((resolve, reject) => {
      this.#resolveReplay = resolve;
      this.#rejectReplay = reject;
    });
    const timeout = setTimeout(() => {
      this.fail(new Error('기록된 위치에 도달하기 전에 재실행 제한 시간이 지났습니다.'));
    }, REPLAY_TIMEOUT_MS);
    return {promise, clearTimeout: () => clearTimeout(timeout)};
  }

  async #restartAndReplay(completed: Promise<void>): Promise<void> {
    await this.#debuggerModel?.target().router()?.connection().disconnect();
    const ws = await this.#restartTarget?.();
    if (!ws || this.session.error) {
      throw new Error(this.session.error ?? '재시작한 대상의 연결 주소가 없습니다.');
    }
    await this.#connectToTarget?.(ws);
    if (this.session.error) {
      throw new Error(this.session.error);
    }
    // 콘솔 원문도 실행 입력이다. 변수·힙을 저장하지 않고 같은 순서로 다시 제출한다.
    const generation = this.#replayGeneration;
    void this.#replayConsoleInputs(generation).catch(error => {
      if (generation === this.#replayGeneration && this.session.replaying) {
        this.fail(error);
      }
    });
    await completed;
  }

  async #replayConsoleInputs(generation: number): Promise<void> {
    const runtime = this.#debuggerModel?.target().runtimeAgent();
    if (!runtime) {
      throw new Error('콘솔 코드를 실행할 대상이 없습니다.');
    }
    for (let index = 0; index < this.#consoleInputs.length; index++) {
      const input = this.#consoleInputs[index];
      await this.#waitForInputPosition(input.afterPosition, generation);
      if (generation !== this.#replayGeneration || !this.session.replaying || this.session.error) {
        return;
      }
      this.#activeConsoleInput = index;
      this.#replayInputCount = index + 1;
      const response = await runtime.invoke_evaluate({
        expression: input.expression,
        includeCommandLineAPI: input.useCommandLineAPI,
        userGesture: input.userGesture,
        objectGroup: 'console',
        replMode: true,
        awaitPromise: false,
      });
      // 직전 복원의 evaluate 응답은 다음 재시작에서 취소될 수 있다. 새 작업에는 섞지 않는다.
      if (generation !== this.#replayGeneration) {
        return;
      }
      if (response.getError() && this.session.replaying) {
        throw new Error(response.getError());
      }
    }
  }

  async #waitForInputPosition(position: number, generation: number): Promise<void> {
    while (generation === this.#replayGeneration && this.session.replaying && !this.session.error &&
           this.#replayedPositions < position) {
      await new Promise<void>(resolve => this.#progressListeners.add(resolve));
    }
    if (generation === this.#replayGeneration && this.session.replaying && this.#replayedPositions !== position) {
      throw new Error('콘솔 입력 시점이 기록된 실행 순서와 달라졌습니다.');
    }
  }

  async #recordedScript(script: SDK.Script.Script): Promise<RecordedScript|null> {
    const recorded = this.#scripts.get(script.scriptId);
    if (recorded) {
      return recorded;
    }
    let url = await this.#consoleSources.get(script.scriptId);
    if (!url && this.#kind === 'node' && this.#consoleInputs.length === 0 && !this.#entryURL && script.sourceURL) {
      // 사용자가 실행한 파일을 첫 정지에서 식별한다. 파일 경로나 명령을 요구하지 않는다.
      this.#entryURL = script.sourceURL;
    }
    if (!url && script.sourceURL && script.sourceURL === this.#entryURL) {
      url = script.sourceURL;
    }
    if (!url) {
      return null;
    }
    const result = await this.#installRecordingBreakpoints(script, url);
    this.#scripts.set(script.scriptId, result);
    return result;
  }

  async #installRecordingBreakpoints(script: SDK.Script.Script, url: string): Promise<RecordedScript> {
    const model = script.debuggerModel;
    const result = await model.agent.invoke_getPossibleBreakpoints({
      start: {scriptId: script.scriptId, lineNumber: script.lineOffset, columnNumber: script.columnOffset},
      end: {scriptId: script.scriptId, lineNumber: script.endLine, columnNumber: script.endColumn},
      restrictToFunction: false,
    });
    if (result.getError()) {
      throw new Error(result.getError());
    }
    const positions = new Set<string>();
    const debuggerStatements = new Set<string>();
    for (const location of result.locations) {
      const key = `${location.lineNumber}:${location.columnNumber ?? 0}`;
      if (location.type === Protocol.Debugger.BreakLocationType.DebuggerStatement) {
        debuggerStatements.add(key);
      }
      if (positions.has(key)) {
        continue;
      }
      if (this.#recordingBreakpointIds.size >= REPLAY_LIMITS.breakpoints) {
        throw new Error('기록용 브레이크포인트 한도에 도달했습니다.');
      }
      const breakpoint = await model.agent.invoke_setBreakpoint({location});
      if (breakpoint.getError()) {
        throw new Error(breakpoint.getError());
      }
      const actual = breakpoint.actualLocation;
      if (actual.lineNumber !== location.lineNumber || actual.columnNumber !== location.columnNumber) {
        throw new Error('런타임이 기록용 브레이크포인트 위치를 변경했습니다.');
      }
      this.#recordingBreakpointIds.add(breakpoint.breakpointId);
      positions.add(key);
    }
    return {url, positions, debuggerStatements};
  }

  async #handlePause(details: SDK.DebuggerModel.DebuggerPausedDetails): Promise<boolean> {
    if (this.session.error) {
      return false;
    }
    try {
      const generation = this.#replayGeneration;
      const frame = details.callFrames[0];
      const initial = frame && !this.#scripts.has(frame.script.scriptId);
      const script = frame && await this.#recordedScript(frame.script);
      if (generation !== this.#replayGeneration || this.session.error) {
        return false;
      }
      if (!frame || !script) {
        if (this.#isReplaying) {
          await this.#resumeExecution();
          return true;
        }
        this.session.unrecordedPause();
        this.#notifyStatusChanged();
        return false;
      }
      const {lineNumber, columnNumber} = frame.location();
      const key = `${lineNumber}:${columnNumber}`;
      if (!script.positions.has(key)) {
        throw new Error('일반 브레이크포인트로 재현할 수 없는 정지 위치입니다.');
      }
      const hitUserBreakpoint = details.breakpointIds.some(id => !this.#recordingBreakpointIds.has(id));
      const pausedOnException = details.reason === Protocol.Debugger.PausedEventReason.Exception ||
          details.reason === Protocol.Debugger.PausedEventReason.PromiseRejection;
      const position = {url: script.url, hash: frame.script.hash, lineNumber, columnNumber};
      const disposition = this.session.recordPause({
        position,
        depth: details.callFrames.length,
        userVisible: Boolean(initial) || script.debuggerStatements.has(key) || hitUserBreakpoint || pausedOnException,
      });
      this.#lastPosition = position;
      this.#touchActivity();
      if (this.#isReplaying) {
        this.#replayedPositions++;
        if (!this.session.replaying) {
          this.#consoleInputs.splice(this.#replayInputCount);
          this.#consoleBytes = this.#consoleInputs.reduce((sum, input) => sum + input.expression.length * 2, 0);
        }
      }
      if (disposition === 'continue') {
        await this.#resumeExecution();
        return true;
      }
      this.#notifyProgress();
      this.#notifyStatusChanged();
      return false;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  #handleExecutionCommand(command: SDK.DebuggerModel.ExecutionCommand): boolean {
    if (this.#isReplaying) {
      return true;
    }
    if (this.session.error || !this.#scripts.size) {
      return false;
    }
    if (command === 'skip-pauses') {
      this.fail(new Error('모든 정지 건너뛰기로 실행 기록이 끊겼습니다.'));
      return false;
    }
    this.#touchActivity();
    this.session.beginExecution(command);
    this.#notifyStatusChanged();
    if (command === 'pause') {
      void this.#debuggerModel?.agent.invoke_pause();
    } else {
      void this.#resumeExecution().catch(error => this.fail(error));
    }
    return true;
  }

  async #resumeExecution(): Promise<void> {
    const response = await this.#debuggerModel?.agent.invoke_resume({terminateOnResume: false});
    if (response?.getError()) {
      throw new Error(response.getError());
    }
    this.#notifyProgress();
  }

  #touchActivity(): void {
    this.#lastActivityAt = Date.now();
    this.#idleTimer ??= setTimeout(() => this.#expireIfIdle(), REPLAY_LIMITS.idleMilliseconds);
  }

  #expireIfIdle(): void {
    const remaining = REPLAY_LIMITS.idleMilliseconds - (Date.now() - this.#lastActivityAt);
    if (remaining > 0) {
      this.#idleTimer = setTimeout(() => this.#expireIfIdle(), remaining);
      return;
    }
    this.fail(new Error('30분 동안 실행·입력 활동이 없어 기록을 해제했습니다. 새 실행 컨텍스트에서 시작하세요.'));
  }

  #releaseRecording(): void {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = undefined;
    this.#replayGeneration++;
    this.session.history.clear();
    this.#consoleInputs = [];
    this.#consoleBytes = 0;
    this.#consoleSources.clear();
    this.#scripts.clear();
    this.#activeConsoleInput = null;
    this.#lastPosition = null;
    for (const breakpointId of this.#recordingBreakpointIds) {
      void this.#debuggerModel?.agent.invoke_removeBreakpoint({breakpointId: breakpointId as Protocol.Debugger.BreakpointId});
    }
    this.#recordingBreakpointIds.clear();
    this.#notifyProgress();
  }

  #notifyProgress(): void {
    for (const resolve of this.#progressListeners) {
      resolve();
    }
    this.#progressListeners.clear();
  }

  #notifyStatusChanged(): void {
    this.dispatchEventToListeners(Events.CHANGED);
  }
}
