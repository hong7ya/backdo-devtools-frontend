// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as Common from '../../core/common/common.js';
import * as SDK from '../../core/sdk/sdk.js';
import * as Protocol from '../../generated/protocol.js';

import {type ExecutionPosition, samePosition} from './ExecutionHistory.js';
import {REPLAY_RESPONSE_BUDGET_MS, REPLAY_TIME_LIMIT_MESSAGE} from './ReplayLimits.js';
import {ReplaySession} from './ReplaySession.js';
import {ReplayTiming} from './ReplayTiming.js';

// 30초는 응답 없는 복원을 끝내기 위한 초기 대기 정책이다. 진행이 있으면 다시 계산한다.
// 기록 보관 시간이나 복원 전체 소요 시간을 제한하는 값은 아니다.
const REPLAY_STALL_TIMEOUT_MS = 30_000;
// 실행은 계속 기록하되 사용량 화면 갱신은 초당 최대 10회로 묶는다.
const USAGE_NOTIFICATION_INTERVAL_MS = 100;

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
  RECORDING_CHANGED = 'RecordingChanged',
}

interface EventTypes {
  [Events.CHANGED]: void;
  [Events.RECORDING_CHANGED]: void;
}

/** 입력 경로와 관계없이 실행 위치를 기록한다. 프로세스 재시작 방법은 외부에서 주입한다. */
export class ReplayController extends Common.ObjectWrapper.ObjectWrapper<EventTypes> {
  static #instance: ReplayController;
  readonly session = new ReplaySession();
  #lastUsageNotification = 0;
  #timing = new ReplayTiming();
  #scriptsPrepared = false;
  #scriptExecutionBreakpoint: Protocol.Debugger.BreakpointId|null = null;
  #scriptFilter: (script: SDK.Script.Script) => boolean = () => true;
  #debuggerModel: SDK.DebuggerModel.DebuggerModel|null = null;
  #prepareTarget: (() => Promise<void>)|null = null;
  #connectToTarget: ((ws: string) => Promise<void>)|null = null;
  #restartTarget: (() => Promise<string>)|null = null;
  #listeners: Common.EventTarget.EventDescriptor[] = [];
  #recordingBreakpointIds = new Set<string>();
  #scripts = new Map<string, RecordedScript>();
  #consoleSources = new Map<string, Promise<string|null>>();
  #consoleInputs: ConsoleInput[] = [];
  #activeConsoleInput: number|null = null;
  #replayGeneration = 0;
  #replayInputCount = 0;
  #replayedPositions = 0;
  #progressListeners = new Set<() => void>();
  #lastPosition: ExecutionPosition|null = null;
  #isReplaying = false;
  #calibrationHandler: ((signal: AbortSignal) => Promise<number>)|null = null;
  #calibrationAbort: AbortController|null = null;
  #resolveReplay: (() => void)|null = null;
  #rejectReplay: ((error: Error) => void)|null = null;
  #refreshReplayTimeout: (() => void)|null = null;

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

  get calibrated(): boolean {
    return this.#timing.calibrated;
  }

  get estimatedReplayMs(): number|null {
    return this.session.history.length ? this.#timing.estimate(this.session.history.length) : null;
  }

  get calibrating(): boolean {
    return this.#calibrationAbort !== null;
  }

  setPreparationHandler(prepare: (() => Promise<void>)|null): void {
    this.#prepareTarget = prepare;
  }

  setScriptFilter(filter: (script: SDK.Script.Script) => boolean): void {
    this.#scriptFilter = filter;
  }

  setCalibrationHandler(measure: ((signal: AbortSignal) => Promise<number>)|null): void {
    this.#calibrationAbort?.abort();
    this.#calibrationAbort = null;
    this.#calibrationHandler = measure;
    this.#timing = new ReplayTiming();
    void this.#calibrateIfNeeded();
    this.#notifyStatusChanged();
  }

  get recordingUsage(): {positions: number, consoleInputs: number, breakpoints: number, pendingSources: number} {
    return {
      positions: this.session.history.length,
      consoleInputs: this.#consoleInputs.length,
      breakpoints: this.#recordingBreakpointIds.size,
      pendingSources: this.#consoleSources.size,
    };
  }

  canReverse(model: SDK.DebuggerModel.DebuggerModel|null): boolean {
    return Boolean(this.#restartTarget) && model === this.#debuggerModel && Boolean(model?.isPaused()) && !this.busy &&
        this.calibrated && this.session.canReverse;
  }

  get status(): string {
    if (this.session.error) {
      return `뒤로가기 사용 불가: ${this.session.error}`;
    }
    if (this.calibrating) {
      return '별도 더미 프로세스에서 CDP 응답 시간을 측정하고 있습니다.';
    }
    if (this.#isReplaying) {
      return '이전 실행 위치까지 다시 실행하고 있습니다.';
    }
    if (!this.#restartTarget) {
      return '실행 위치를 기록 중입니다. 뒤로가기는 프로세스 재시작 연동 후 사용할 수 있습니다.';
    }
    if (!this.#calibrationHandler) {
      return '별도 더미 프로세스의 측정 연동이 없어 뒤로가기를 사용할 수 없습니다.';
    }
    if (!this.calibrated) {
      return '최초 정지 후 CDP 응답 시간을 측정하면 사용할 수 있습니다.';
    }
    if (this.#debuggerModel?.isPaused() && this.session.history.length && !this.session.atRecordedPause) {
      return '현재 정지 위치는 실행 기록 대상이 아닙니다. Ignore List 설정을 확인해 주세요.';
    }
    return this.session.canReverse ? '프로세스를 다시 실행하여 직전 실행 위치로 이동' :
                                     '기록된 이전 실행 위치가 없습니다.';
  }

  configure(connect: (ws: string) => Promise<void>): void {
    this.#connectToTarget = connect;
  }

  dispose(): void {
    this.#releaseRecording();
    this.session.reset();
    Common.EventTarget.removeEventListeners(this.#listeners);
    this.#debuggerModel?.setPauseInterceptor(null);
    this.#debuggerModel?.setExecutionInterceptor(null);
    this.#debuggerModel?.setScriptExecutionPreparation(null);
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
    }
    Common.EventTarget.removeEventListeners(this.#listeners);
    this.#debuggerModel?.setScriptExecutionPreparation(null);
    this.#debuggerModel = model;
    this.#scriptsPrepared = false;
    this.#scriptExecutionBreakpoint = null;
    this.#recordingBreakpointIds.clear();
    this.#scripts.clear();
    this.#consoleSources.clear();
    this.#activeConsoleInput = null;
    model.setPauseInterceptor(details => this.#handlePause(details));
    model.setExecutionInterceptor(command => this.#handleExecutionCommand(command));
    model.setScriptExecutionPreparation(script => this.#prepareScriptExecution(script));
    this.#observeTarget(model);
    if (!Common.Settings.Settings.instance().moduleSetting('breakpoints-active').get()) {
      this.fail(new Error('브레이크포인트를 활성화한 새 세션에서 기록을 시작하세요.'));
    }
    this.#notifyStatusChanged();
  }

  async #calibrateIfNeeded(): Promise<void> {
    const measure = this.#calibrationHandler;
    if (!measure || this.calibrating || this.calibrated || this.session.error || !this.#debuggerModel?.isPaused() ||
        !this.session.history.length) {
      return;
    }
    const abort = new AbortController();
    this.#calibrationAbort = abort;
    this.#notifyStatusChanged();
    try {
      const roundTripMs = await measure(abort.signal);
      if (abort.signal.aborted) {
        return;
      }
      this.#timing.calibrate(roundTripMs);
      if ((this.estimatedReplayMs ?? 0) >= REPLAY_RESPONSE_BUDGET_MS) {
        this.fail(new Error(REPLAY_TIME_LIMIT_MESSAGE));
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        this.fail(error);
      }
    } finally {
      if (this.#calibrationAbort === abort) {
        this.#calibrationAbort = null;
        this.#notifyStatusChanged();
      }
    }
  }

  async reverse(): Promise<void> {
    if (!this.canReverse(this.#debuggerModel) || !this.#connectToTarget) {
      throw new Error(this.status);
    }
    const completion = this.#beginReplay();
    const userBreakpoints = SDK.UserBreakpoints.UserBreakpoints.instance();
    try {
      // 재실행 진행이 멈춘 연결도 대기 제한에 포함한다. 전체 재실행 시간은 제한하지 않는다.
      await Promise.race([
        (async () => {
          await userBreakpoints.setSuspended(true);
          if (!this.session.error) {
            await this.#restartAndReplay(completion.promise);
          }
        })(),
        completion.promise,
      ]);
    } catch (error) {
      this.fail(error);
      throw error;
    } finally {
      completion.clearTimeout();
      this.#resolveReplay = null;
      this.#rejectReplay = null;
      try {
        // 설정은 유지한 채 성공·실패 모두에서 중단점의 재적용 완료를 기다린다.
        await userBreakpoints.setSuspended(false);
      } catch (error) {
        this.fail(error);
        throw error;
      } finally {
        this.#isReplaying = false;
        this.#notifyProgress();
        this.#notifyStatusChanged();
      }
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
    this.#debuggerModel?.setScriptExecutionPreparation(null);
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
      void this.#calibrateIfNeeded();
      this.#notifyStatusChanged();
    }));
    this.#listeners.push(
        model.addEventListener(SDK.DebuggerModel.Events.DebuggerResumed, () => this.#notifyStatusChanged()));
    const consoleModel = model.target().model(SDK.ConsoleModel.ConsoleModel);
    if (consoleModel) {
      this.#listeners.push(consoleModel.addEventListener(SDK.ConsoleModel.Events.CommandWillBeEvaluated, event => {
        this.#recordConsoleInput(event.data);
      }));
    }
  }

  #recordConsoleInput(command: SDK.ConsoleModel.ConsoleCommand): void {
    if (this.session.error) {
      return;
    }
    if (this.#isReplaying) {
      this.fail(new Error('복원 중 콘솔에서 코드가 실행되어 뒤로가기를 중단했습니다. 새 세션에서 시작해 주세요.'));
      return;
    }
    if (this.#debuggerModel?.isPaused()) {
      // 일시정지 중 조회·수정은 기존 콘솔에 맡긴다. 수동 변경은 재실행 입력으로 저장하지 않는다.
      return;
    }
    const {expression, useCommandLineAPI, userGesture} = command;
    this.#activeConsoleInput = this.#consoleInputs.length;
    this.#consoleInputs.push({expression, useCommandLineAPI, userGesture, afterPosition: this.session.history.length});
    this.#notifyStatusChanged();
  }

  #identifyConsoleSource(script: SDK.Script.Script): void {
    if (isInternalScript(script)) {
      return;
    }
    const index = this.#activeConsoleInput;
    if (index === null) {
      return;
    }
    const input = this.#consoleInputs[index];
    if (!input) {
      return;
    }
    // VM 번호와 scriptId는 재연결마다 달라진다. 원문이 일치하는 입력 순번으로 비교한다.
    const source = script.debuggerModel.agent.invoke_getScriptSource({scriptId: script.scriptId})
                       .then(
                           result => !result.getError() && result.scriptSource === input.expression ?
                               `backdo-console:///${index + 1}` :
                               null,
                           () => null);
    this.#consoleSources.set(script.scriptId, source);
    void source.then(url => {
      if (!url && this.#consoleSources.get(script.scriptId) === source) {
        this.#consoleSources.delete(script.scriptId);
      }
    });
  }

  #beginReplay(): {promise: Promise<void>, clearTimeout: () => void} {
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
    let timeout: ReturnType<typeof setTimeout>;
    this.#refreshReplayTimeout = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        this.fail(new Error('재실행 진행 없이 대기 제한 시간이 지났습니다. 연결과 대상 코드를 확인해 주세요.'));
      }, REPLAY_STALL_TIMEOUT_MS);
    };
    this.#refreshReplayTimeout();
    return {
      promise,
      clearTimeout: () => {
        this.#refreshReplayTimeout = null;
        clearTimeout(timeout);
      },
    };
  }

  async #restartAndReplay(completed: Promise<void>): Promise<void> {
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
    if (isInternalScript(script)) {
      return null;
    }
    const recorded = this.#scripts.get(script.scriptId);
    if (recorded) {
      return recorded;
    }
    let url = await this.#consoleSources.get(script.scriptId);
    if (!url && script.sourceURL && this.#scriptFilter(script)) {
      url = script.sourceURL;
    }
    if (!url) {
      return null;
    }
    const result = await this.#installRecordingBreakpoints(script, url);
    this.#scripts.set(script.scriptId, result);
    return result;
  }

  async #prepareRecordingScripts(): Promise<void> {
    const model = this.#debuggerModel;
    if (!model || this.#scriptsPrepared) {
      return;
    }
    this.#scriptsPrepared = true;
    const response = await model.agent.invoke_setInstrumentationBreakpoint({
      instrumentation: Protocol.Debugger.SetInstrumentationBreakpointRequestInstrumentation.BeforeScriptExecution,
    });
    if (response.getError()) {
      throw new Error(response.getError());
    }
    this.#scriptExecutionBreakpoint = response.breakpointId;
    // 이미 불러온 모듈은 최초 정지에서, 나중에 불러오는 모듈은 실행 직전에 준비한다.
    for (const script of model.scripts()) {
      await this.#recordedScript(script);
    }
  }

  async #prepareScriptExecution(script: SDK.Script.Script): Promise<void> {
    if (this.session.error || !this.#scriptsPrepared) {
      return;
    }
    try {
      await this.#recordedScript(script);
    } catch (error) {
      this.fail(error);
    }
  }

  async #installRecordingBreakpoints(script: SDK.Script.Script, url: string): Promise<RecordedScript> {
    const model = script.debuggerModel;
    const result = await model.agent.invoke_getPossibleBreakpoints({
      start: {scriptId: script.scriptId, lineNumber: script.lineOffset, columnNumber: script.columnOffset},
      end: {scriptId: script.scriptId, lineNumber: script.endLine, columnNumber: script.endColumn},
      restrictToFunction: false,
    });
    const error = result.getError();
    if (error) {
      throw new Error(`중단점 위치를 조회하지 못했습니다: ${url} (${error})`);
    }
    const positions = new Set<string>();
    const debuggerStatements = new Set<string>();
    const resolvedPositions = new Map<string, string>();
    for (const location of result.locations) {
      const requestedKey = positionKey(location);
      let actualKey = resolvedPositions.get(requestedKey);
      if (!actualKey) {
        // 앞선 후보가 이 위치로 보정되었다면 이미 설치한 중단점을 사용한다.
        actualKey = positions.has(requestedKey) ? requestedKey :
                                                  await this.#installRecordingBreakpoint(script, location, positions);
        resolvedPositions.set(requestedKey, actualKey);
      }
      if (location.type === Protocol.Debugger.BreakLocationType.DebuggerStatement) {
        debuggerStatements.add(actualKey);
      }
    }
    return {url, positions, debuggerStatements};
  }

  async #installRecordingBreakpoint(
      script: SDK.Script.Script, location: Protocol.Debugger.Location, positions: Set<string>): Promise<string> {
    const agent = script.debuggerModel.agent;
    const breakpoint = await agent.invoke_setBreakpoint({location});
    const error = breakpoint.getError();
    if (error) {
      throw new Error(error);
    }
    const {breakpointId, actualLocation} = breakpoint;
    const alreadyOwned = this.#recordingBreakpointIds.has(breakpointId);
    // 설치 후 검증이나 중복 제거가 실패해도 이 ID를 빠짐없이 정리한다.
    this.#recordingBreakpointIds.add(breakpointId);
    if (actualLocation.scriptId !== script.scriptId) {
      throw new Error('기록용 브레이크포인트가 다른 소스에 설치되었습니다.');
    }
    const actualKey = positionKey(actualLocation);
    if (positions.has(actualKey) && !alreadyOwned) {
      // 서로 다른 후보가 같은 위치로 모이면 추가 ID만 제거한다.
      const removed = await agent.invoke_removeBreakpoint({breakpointId});
      const removeError = removed.getError();
      if (removeError) {
        throw new Error(removeError);
      }
      this.#recordingBreakpointIds.delete(breakpointId);
    }
    positions.add(actualKey);
    this.#notifyUsageChanged();
    return actualKey;
  }

  async #handlePause(details: SDK.DebuggerModel.DebuggerPausedDetails): Promise<boolean> {
    if (this.session.error) {
      return false;
    }
    try {
      const generation = this.#replayGeneration;
      if (!this.#isReplaying && !this.session.history.length) {
        await this.#prepareTarget?.();
      }
      const frame = details.callFrames[0];
      const initial = frame && !this.#scripts.has(frame.script.scriptId);
      await this.#prepareRecordingScripts();
      // 시작 정지가 Ignore List의 모듈에 있어도 재시작의 기준점으로만 보관한다.
      const breakOnStart = String(details.reason) === 'Break on start';
      let script = frame && await this.#recordedScript(frame.script);
      if (!script && frame && breakOnStart && !isInternalScript(frame.script)) {
        script = {url: frame.script.sourceURL, positions: new Set(), debuggerStatements: new Set()};
      }
      if (generation !== this.#replayGeneration || this.session.error) {
        return false;
      }
      if (!frame || !script) {
        if (this.#isReplaying) {
          await this.#resumeExecution();
          return true;
        }
        this.session.unrecordedPause(details.callFrames.length);
        this.#notifyStatusChanged();
        return false;
      }
      const {lineNumber, columnNumber} = frame.location();
      const key = positionKey({lineNumber, columnNumber});
      const position = {url: script.url, hash: frame.script.hash, lineNumber, columnNumber};
      const hitRecordingBreakpoint = details.breakpointIds.some(id => this.#recordingBreakpointIds.has(id));
      // Node의 시작 정지는 일반 중단점이 없는 import 앞에도 오며, --inspect-brk 재시작으로 재현된다.
      if (!initial && !breakOnStart && !hitRecordingBreakpoint && !script.debuggerStatements.has(key)) {
        // XHR·예외 등은 같은 실행 위치에서 별도의 정지를 보낼 수 있다.
        // 복원 중에는 해제되는 사용자 정지를 실행 방문 횟수에 더하지 않는다.
        if (this.#isReplaying) {
          await this.#resumeExecution();
          return true;
        }
        this.session.showUserPause(
            details.callFrames.length, Boolean(this.#lastPosition && samePosition(this.#lastPosition, position)));
        this.#notifyStatusChanged();
        return false;
      }
      if (!script.positions.has(key) && !breakOnStart) {
        throw new Error('일반 브레이크포인트로 재현할 수 없는 정지 위치입니다.');
      }
      // 기록용 ID만 있는 일반 정지만 숨긴다. XHR·DOM·이벤트·예외·수동 정지는 보존한다.
      const onlyRecordingBreakpoint = details.reason === Protocol.Debugger.PausedEventReason.Other &&
          details.breakpointIds.length > 0 && details.breakpointIds.every(id => this.#recordingBreakpointIds.has(id));
      const disposition = this.session.recordPause({
        position,
        depth: details.callFrames.length,
        userVisible: Boolean(initial) || script.debuggerStatements.has(key) || !onlyRecordingBreakpoint,
      });
      this.#lastPosition = position;
      if (!this.#isReplaying && this.session.history.canReverse &&
          (this.#timing.estimate(this.session.history.length) ?? 0) >= REPLAY_RESPONSE_BUDGET_MS) {
        throw new Error(REPLAY_TIME_LIMIT_MESSAGE);
      }
      if (this.#isReplaying) {
        this.#replayedPositions++;
        if (!this.session.replaying) {
          this.#consoleInputs.splice(this.#replayInputCount);
        }
      }
      this.#notifyUsageChanged();
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
    if (this.busy) {
      return true;
    }
    if (this.session.error || !this.#scriptsPrepared) {
      return false;
    }
    if (command === 'skip-pauses') {
      this.fail(new Error('모든 정지 건너뛰기로 실행 기록이 끊겼습니다.'));
      return false;
    }
    const useNativeCommand = this.#debuggerModel?.isPaused() && !this.session.atRecordedPause;
    this.session.beginExecution(command);
    this.#notifyStatusChanged();
    if (useNativeCommand) {
      return false;
    }
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

  #releaseRecording(): void {
    this.#calibrationAbort?.abort();
    this.#calibrationAbort = null;
    this.#timing = new ReplayTiming();
    this.#replayGeneration++;
    this.session.history.clear();
    this.#consoleInputs = [];
    this.#consoleSources.clear();
    this.#scripts.clear();
    this.#activeConsoleInput = null;
    this.#lastPosition = null;
    this.#scriptsPrepared = false;
    if (this.#scriptExecutionBreakpoint) {
      void this.#debuggerModel?.agent.invoke_removeBreakpoint({breakpointId: this.#scriptExecutionBreakpoint});
      this.#scriptExecutionBreakpoint = null;
    }
    for (const breakpointId of this.#recordingBreakpointIds) {
      void this.#debuggerModel?.agent.invoke_removeBreakpoint(
          {breakpointId: breakpointId as Protocol.Debugger.BreakpointId});
    }
    this.#recordingBreakpointIds.clear();
    this.#notifyProgress();
  }

  #notifyProgress(): void {
    if (this.session.replaying) {
      this.#refreshReplayTimeout?.();
    }
    for (const resolve of this.#progressListeners) {
      resolve();
    }
    this.#progressListeners.clear();
  }

  #notifyUsageChanged(): void {
    const now = performance.now();
    // 내부 정지마다 패널 전체를 다시 그리지 않고 사용량만 최대 100ms마다 알린다.
    if (now - this.#lastUsageNotification < USAGE_NOTIFICATION_INTERVAL_MS) {
      return;
    }
    this.#lastUsageNotification = now;
    this.dispatchEventToListeners(Events.RECORDING_CHANGED);
  }

  #notifyStatusChanged(): void {
    this.dispatchEventToListeners(Events.CHANGED);
  }
}

/** 서버와 프론트가 공유하는 내부 소스 이름이다. 파일명·실행 완료 여부로 사용자 코드를 제외하지 않는다. */
function isInternalScript(script: SDK.Script.Script): boolean {
  return script.sourceURL.startsWith('backdo-internal:///');
}

function positionKey(location: {lineNumber: number, columnNumber?: number}): string {
  return `${location.lineNumber}:${location.columnNumber ?? 0}`;
}
