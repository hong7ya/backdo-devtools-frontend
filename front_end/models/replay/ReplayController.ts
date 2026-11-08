// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as Common from '../../core/common/common.js';
import * as SDK from '../../core/sdk/sdk.js';
import * as Protocol from '../../generated/protocol.js';

import {ReplaySession} from './ReplaySession.js';

const SESSION_REQUEST_TIMEOUT_MS = 15_000;
const REPLAY_TIMEOUT_MS = 30_000;

interface ManagedTarget {
  ws: string;
  entryURL: string;
}

export const enum Events {
  CHANGED = 'Changed',
}

interface EventTypes {
  [Events.CHANGED]: void;
}

/** 실행 관리기가 소유한 Node 프로세스에서 진입 파일의 실행 위치를 기록하고 재실행한다. */
export class ReplayController extends Common.ObjectWrapper.ObjectWrapper<EventTypes> {
  static #instance: ReplayController;
  readonly session = new ReplaySession();
  #sessionToken = '';
  #entryURL = '';
  #debuggerModel: SDK.DebuggerModel.DebuggerModel|null = null;
  #connectToTarget: ((ws: string) => Promise<void>)|null = null;
  #recordingBreakpointIds = new Set<string>();
  #recordablePositions = new Set<string>();
  #debuggerStatementPositions = new Set<string>();
  #hasRecordingBreakpoints = false;
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

  canReverse(model: SDK.DebuggerModel.DebuggerModel|null): boolean {
    return model === this.#debuggerModel && Boolean(model?.isPaused()) && !this.#isReplaying && this.session.canReverse;
  }

  get status(): string {
    if (this.session.error) {
      return `BackDo unavailable: ${this.session.error}`;
    }
    if (!this.#sessionToken) {
      return 'Start a managed Node session with out/Default/gen/scripts/backdo/debug.js to use BackDo';
    }
    if (this.#isReplaying) {
      return 'Replaying the process to the previous recorded position…';
    }
    return this.session.canReverse ? 'Go to the previous recorded position (restarts and re-executes the process)' :
                                     'No previous recorded position in the entry script';
  }

  async configure(token: string, connect: (ws: string) => Promise<void>): Promise<ManagedTarget> {
    this.#sessionToken = token;
    this.#connectToTarget = connect;
    const target = await this.#requestManagedTarget('session');
    this.#entryURL = target.entryURL;
    Common.Settings.Settings.instance().moduleSetting('breakpoints-active').addChangeListener(() => {
      if (!Common.Settings.Settings.instance().moduleSetting('breakpoints-active').get()) {
        this.fail(new Error('Breakpoints were disabled; start a new session to record a complete path'));
      }
    });
    return target;
  }

  attach(target: SDK.Target.Target): void {
    const model = target.model(SDK.DebuggerModel.DebuggerModel);
    if (!model) {
      throw new Error('The target does not provide a debugger');
    }
    this.#debuggerModel = model;
    this.#recordingBreakpointIds = new Set();
    this.#recordablePositions = new Set();
    this.#debuggerStatementPositions = new Set();
    this.#hasRecordingBreakpoints = false;
    model.setPauseInterceptor(details => this.#handlePause(details));
    model.setExecutionInterceptor(command => this.#handleExecutionCommand(command));
    model.addEventListener(SDK.DebuggerModel.Events.ScriptSourceWasEdited, () => {
      this.fail(new Error('The source was edited; start a new session'));
    });
    model.addEventListener(SDK.DebuggerModel.Events.DebuggerPaused, () => {
      // SDK가 최종 정지를 알린 뒤 완료한다. 에디터 준비는 화면 계층에서 별도로 기다린다.
      if (this.#isReplaying && !this.session.replaying && !this.session.error) {
        queueMicrotask(() => this.#resolveReplay?.());
      }
      this.#notifyStatusChanged();
    });
    model.addEventListener(SDK.DebuggerModel.Events.DebuggerResumed, () => this.#notifyStatusChanged());
    if (!Common.Settings.Settings.instance().moduleSetting('breakpoints-active').get()) {
      this.fail(new Error('Enable breakpoints and start a new managed session'));
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
      this.#notifyStatusChanged();
    }
  }

  fail(error: unknown): void {
    if (this.session.error) {
      return;
    }
    this.session.fail(error);
    this.#rejectReplay?.(new Error(this.session.error ?? 'Replay failed'));
    this.#debuggerModel?.setExecutionInterceptor(null);
    this.#debuggerModel?.setPauseInterceptor(null);
    for (const breakpointId of this.#recordingBreakpointIds) {
      void this.#debuggerModel?.agent.invoke_removeBreakpoint({breakpointId: breakpointId as Protocol.Debugger.BreakpointId});
    }
    this.#recordingBreakpointIds.clear();
    Common.Console.Console.instance().error(`BackDo: ${this.session.error}`);
    if (this.#isReplaying) {
      void this.#debuggerModel?.agent.invoke_pause();
    }
    this.#notifyStatusChanged();
  }

  #beginReplay(): {promise: Promise<void>, clearTimeout: () => void} {
    this.session.beginReverse();
    this.#isReplaying = true;
    this.#notifyStatusChanged();
    const promise = new Promise<void>((resolve, reject) => {
      this.#resolveReplay = resolve;
      this.#rejectReplay = reject;
    });
    const timeout = setTimeout(() => {
      this.fail(new Error('Replay timed out before reaching the recorded position'));
    }, REPLAY_TIMEOUT_MS);
    return {promise, clearTimeout: () => clearTimeout(timeout)};
  }

  async #restartAndReplay(completed: Promise<void>): Promise<void> {
    await this.#debuggerModel?.target().router()?.connection().disconnect();
    const target = await this.#requestManagedTarget('restart');
    if (this.session.error) {
      throw new Error(this.session.error);
    }
    if (target.entryURL !== this.#entryURL) {
      throw new Error('The managed entry script changed');
    }
    await this.#connectToTarget?.(target.ws);
    await completed;
  }

  async #requestManagedTarget(operation: 'session'|'restart'): Promise<ManagedTarget> {
    const response = await fetch(`/__backdo/${operation}`, {
      method: operation === 'restart' ? 'POST' : 'GET',
      headers: {'X-BackDo-Session': this.#sessionToken},
      signal: AbortSignal.timeout(SESSION_REQUEST_TIMEOUT_MS),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || `BackDo session request failed (${response.status})`);
    }
    const ws = new URL(result.ws);
    if (ws.protocol !== 'ws:' || ws.hostname !== '127.0.0.1' || typeof result.entryURL !== 'string') {
      throw new Error('Invalid local target connection');
    }
    return {ws: result.ws, entryURL: result.entryURL};
  }

  async #installRecordingBreakpoints(script: SDK.Script.Script): Promise<void> {
    const model = script.debuggerModel;
    const result = await model.agent.invoke_getPossibleBreakpoints({
      start: {scriptId: script.scriptId, lineNumber: script.lineOffset, columnNumber: script.columnOffset},
      end: {scriptId: script.scriptId, lineNumber: script.endLine, columnNumber: script.endColumn},
      restrictToFunction: false,
    });
    if (result.getError()) {
      throw new Error(result.getError());
    }
    for (const location of result.locations) {
      const key = `${location.lineNumber}:${location.columnNumber ?? 0}`;
      if (location.type === Protocol.Debugger.BreakLocationType.DebuggerStatement) {
        this.#debuggerStatementPositions.add(key);
      }
      if (this.#recordablePositions.has(key)) {
        continue;
      }
      const breakpoint = await model.agent.invoke_setBreakpoint({location});
      if (breakpoint.getError()) {
        throw new Error(breakpoint.getError());
      }
      const actual = breakpoint.actualLocation;
      if (actual.lineNumber !== location.lineNumber || actual.columnNumber !== location.columnNumber) {
        throw new Error('The runtime moved a recording breakpoint to a different position');
      }
      this.#recordingBreakpointIds.add(breakpoint.breakpointId);
      this.#recordablePositions.add(key);
    }
    this.#hasRecordingBreakpoints = true;
  }

  async #handlePause(details: SDK.DebuggerModel.DebuggerPausedDetails): Promise<boolean> {
    if (this.session.error) {
      return false;
    }
    try {
      const frame = details.callFrames[0];
      if (!frame || frame.script.sourceURL !== this.#entryURL) {
        if (this.#isReplaying) {
          await this.#resumeExecution();
          return true;
        }
        this.session.unrecordedPause();
        this.#notifyStatusChanged();
        return false;
      }
      const initial = !this.#hasRecordingBreakpoints;
      if (initial) {
        await this.#installRecordingBreakpoints(frame.script);
      }
      const {lineNumber, columnNumber} = frame.location();
      const key = `${lineNumber}:${columnNumber}`;
      if (!this.#recordablePositions.has(key)) {
        throw new Error('This pause is not a reproducible breakpoint position; start a new session');
      }
      const hitUserBreakpoint = details.breakpointIds.some(id => !this.#recordingBreakpointIds.has(id));
      const pausedOnException = details.reason === Protocol.Debugger.PausedEventReason.Exception ||
          details.reason === Protocol.Debugger.PausedEventReason.PromiseRejection;
      const userVisible = initial || this.#debuggerStatementPositions.has(key) || hitUserBreakpoint || pausedOnException;
      const disposition = this.session.recordPause({
        position: {url: frame.script.sourceURL, hash: frame.script.hash, lineNumber, columnNumber},
        depth: details.callFrames.length,
        userVisible,
      });
      if (disposition === 'continue') {
        await this.#resumeExecution();
        return true;
      }
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
    if (this.session.error) {
      return false;
    }
    if (command === 'skip-pauses') {
      this.fail(new Error('Skipping pauses interrupts recording; start a new session'));
      return false;
    }
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
  }

  #notifyStatusChanged(): void {
    this.dispatchEventToListeners(Events.CHANGED);
  }
}
