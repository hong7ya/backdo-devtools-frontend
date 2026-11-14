// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as Common from '../../core/common/common.js';
import * as SDK from '../../core/sdk/sdk.js';
import * as Protocol from '../../generated/protocol.js';

import {type ExecutionPosition, samePosition} from './ExecutionHistory.js';
import {ScriptScope} from './RecordingScope.js';
import {REPLAY_RESPONSE_BUDGET_MS, REPLAY_TIME_LIMIT_MESSAGE} from './ReplayLimits.js';
import {ReplaySession} from './ReplaySession.js';
import {ReplayTiming} from './ReplayTiming.js';

// 30초는 응답 없는 복원을 끝내기 위한 초기 대기 정책이다. 진행이 있으면 다시 계산한다.
// 기록 보관 시간이나 복원 전체 소요 시간을 제한하는 값은 아니다.
const REPLAY_STALL_TIMEOUT_MS = 30_000;
// 실행은 계속 기록하되 사용량 화면 갱신은 초당 최대 10회로 묶는다.
const USAGE_NOTIFICATION_INTERVAL_MS = 100;

interface ConsoleInput {
  type: 'console';
  expression: string;
  useCommandLineAPI: boolean;
  userGesture: boolean;
  exception?: string;
  callFrame?: {
    index: number,
    inlineFrameIndex: number,
    functionName: string,
    position: ExecutionPosition,
  };
}

interface RecordedScript {
  url: string;
  positions: Set<string>;
  debuggerStatements: Set<string>;
}

interface ScopeChange {
  /** 이 개수의 실행 위치를 지난 뒤에만 범위를 넓힌다. */
  afterPosition: number;
  sources: string[];
  /** 새 파일에 실제로 멈춰 추가했다면, 재생에서도 이 진입점을 기다린다. */
  entry?: ExecutionPosition;
  inputCount: number;
}

type StepCommand = 'step-into'|'step-over'|'step-out';

interface RecordedStep {
  afterPosition: number;
  command: StepCommand;
  depth: number;
}

export type BrowserInput = {
  type: 'mouse',
  params: Protocol.Input.DispatchMouseEventRequest,
}|{type: 'key', params: Protocol.Input.DispatchKeyEventRequest}|{type: 'navigate', url: string}|
    {type: 'reload', ignoreCache?: boolean, scriptToEvaluateOnLoad?: string}|{type: 'history', offset: number}|
    {type: 'touch', enabled: boolean}|{type: 'viewport', width: number, height: number, deviceScaleFactor: number};

type RecordedInput = (ConsoleInput|BrowserInput)&{
  afterPosition: number,
  afterInputs: number[],
  sequence: number,
  document: number,
  loaded: boolean,
  paused: boolean,
};

interface RecordingStart {
  position: ExecutionPosition;
  inputCount: number;
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
  #breakpointSources: () => string[] = () => [];
  #selectedSources = new Set<string>();
  #scopeChanges: ScopeChange[] = [];
  #scopeChangeIndex = 0;
  #scopeEntry: {change: ScopeChange, breakpointId: string}|null = null;
  #scriptScopes = new Map<string, ScriptScope>();
  #preparedScopeSizes = new Map<string, number>();
  #steps: RecordedStep[] = [];
  #pendingStep: RecordedStep|null = null;
  #pausedDetails: SDK.DebuggerModel.DebuggerPausedDetails|undefined;
  #pendingConsoleInputs: Array<RecordedInput&ConsoleInput> = [];
  #debuggerModel: SDK.DebuggerModel.DebuggerModel|null = null;
  #prepareTarget: (() => Promise<void>)|null = null;
  #connectToTarget: ((ws: string) => Promise<void>)|null = null;
  #restartTarget: (() => Promise<string>)|null = null;
  #listeners: Common.EventTarget.EventDescriptor[] = [];
  #recordingBreakpointIds = new Set<string>();
  #scripts = new Map<string, RecordedScript>();
  #consoleSources = new Map<string, Promise<string|null>>();
  #inputs: RecordedInput[] = [];
  #consoleInputByMessage = new WeakMap<SDK.ConsoleModel.ConsoleMessage, RecordedInput&ConsoleInput>();
  #completedInputs = new Set<number>();
  #inputCompletions = new Set<number>();
  #activeConsoleInput: number|null = null;
  #startURL: string|null = null;
  #recordingStart: RecordingStart|null = null;
  #document = 0;
  #documentLoaded = true;
  #documentEpoch = 0;
  #preparingPause = false;
  #pauseSequence = 0;
  #browserTouchEnabled = false;
  #browserViewport: Extract<BrowserInput, {type: 'viewport'}>|null = null;
  #heldMouse = new Map<Protocol.Input.MouseButton, Protocol.Input.DispatchMouseEventRequest>();
  #heldKeys = new Map<string, Protocol.Input.DispatchKeyEventRequest>();
  #releaseHeldInputsOnExecution = false;
  #entryBreakpoint: Protocol.Debugger.BreakpointId|null = null;
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
    return this.#isReplaying || this.#pendingConsoleInputs.length > 0;
  }

  get busyLabel(): string {
    return this.#pendingConsoleInputs.length ? 'Console 실행 중' : '복원 중';
  }

  get currentPosition(): ExecutionPosition|null {
    return this.#lastPosition;
  }

  get inputCount(): number {
    return this.#inputs.length;
  }

  get browserTouchEnabled(): boolean {
    return this.#browserTouchEnabled;
  }

  get browserViewport(): {width: number, height: number, deviceScaleFactor: number}|null {
    if (!this.#browserViewport) {
      return null;
    }
    const {width, height, deviceScaleFactor} = this.#browserViewport;
    return {width, height, deviceScaleFactor};
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

  setBreakpointSourcesProvider(sources: () => string[]): void {
    this.#breakpointSources = sources;
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
      consoleInputs: this.#inputs.filter(input => input.type === 'console').length,
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
    if (this.#pendingConsoleInputs.length) {
      return 'Console 입력이 끝나면 실행 위치와 함께 기록합니다.';
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
    if (this.session.canReverse &&
        this.#inputs.some(
            input => input.type === 'console' && input.callFrame &&
                input.afterPosition === this.session.history.length - 1)) {
      return 'Console 입력 이전 상태로 복원';
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
    this.#debuggerModel?.setPauseInterceptor(null);
    this.#debuggerModel?.setExecutionInterceptor(null);
    this.#documentEpoch++;
    this.#debuggerModel = model;
    this.#pausedDetails = undefined;
    this.#browserTouchEnabled = false;
    this.#browserViewport = null;
    this.#scriptsPrepared = false;
    this.#scriptExecutionBreakpoint = null;
    this.#entryBreakpoint = null;
    this.#recordingBreakpointIds.clear();
    this.#scripts.clear();
    this.#scriptScopes.clear();
    this.#preparedScopeSizes.clear();
    this.#consoleSources.clear();
    this.#activeConsoleInput = null;
    this.#installInterceptors(model);
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

  recordBrowserInput(input: BrowserInput, completion?: Promise<void>): void {
    if (!this.#debuggerModel || this.busy) {
      return;
    }
    if (this.session.error) {
      if (input.type === 'touch' || input.type === 'viewport') {
        this.#applyInputState(input);
      }
      return;
    }
    if (input.type === 'touch' && this.#browserTouchEnabled === input.enabled) {
      return;
    }
    if (input.type === 'viewport' && this.#browserViewport && input.width === this.#browserViewport.width &&
        input.height === this.#browserViewport.height &&
        input.deviceScaleFactor === this.#browserViewport.deviceScaleFactor) {
      return;
    }
    const recorded = this.#appendInput(input, Boolean(completion));
    if (completion) {
      const generation = this.#replayGeneration;
      void completion.then(() => {
        if (generation === this.#replayGeneration) {
          this.#completeInput(recorded);
        }
      });
    }
    this.#applyInputState(input);
  }

  #appendInput(input: ConsoleInput|BrowserInput, pending = false): RecordedInput {
    this.#startURL ??=
        this.#debuggerModel?.target().model(SDK.ResourceTreeModel.ResourceTreeModel)?.mainFrame?.url ?? null;
    const recorded = {
      ...input,
      afterPosition: this.session.history.length,
      afterInputs: [...this.#inputCompletions],
      sequence: this.#inputs.length,
      document: this.#document,
      loaded: this.#documentLoaded,
      paused: this.#preparingPause || Boolean(this.#debuggerModel?.isPaused()),
    };
    this.#inputCompletions.clear();
    this.#inputs.push(recorded);
    if (!pending) {
      this.#completeInput(recorded);
    }
    return recorded;
  }

  #completeInput(input: RecordedInput): void {
    // 이동 ACK가 다음 입력보다 먼저 도착했다면 그 순서도 보존한다.
    // press/release/key ACK는 터치·일시정지 중 도착하지 않을 수 있어 장벽으로 쓰지 않는다.
    if (input.type === 'key' ||
        (input.type === 'mouse' && input.params.type !== Protocol.Input.DispatchMouseEventRequestType.MouseMoved) ||
        this.#inputs[input.sequence] !== input) {
      return;
    }
    if (this.#completedInputs.has(input.sequence)) {
      return;
    }
    this.#completedInputs.add(input.sequence);
    this.#inputCompletions.add(input.sequence);
    this.#notifyProgress();
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
      this.#calibrationAbort?.abort();
      this.#calibrationAbort = null;
      this.#preparingPause = false;
      if (model.target().type() === SDK.Target.Type.NODE && !this.#isReplaying) {
        this.#releaseRecording();
        this.session.reset();
      } else {
        // 새 문서는 같은 사용자 기록의 다음 구간이다. 문서에 속한 ID만 버린다.
        this.#documentEpoch++;
        this.#scripts.clear();
        this.#scriptScopes.clear();
        this.#preparedScopeSizes.clear();
        this.#pausedDetails = undefined;
        this.#consoleSources.clear();
        this.#activeConsoleInput = null;
        this.#recordingBreakpointIds.clear();
        if (this.#entryBreakpoint) {
          this.#recordingBreakpointIds.add(this.#entryBreakpoint);
        }
        this.#lastPosition = null;
        this.session.unrecordedPause();
      }
      this.#installInterceptors(model);
      this.#notifyProgress();
      this.#notifyStatusChanged();
    }));
    const resources = model.target().model(SDK.ResourceTreeModel.ResourceTreeModel);
    if (resources) {
      this.#listeners.push(resources.addEventListener(SDK.ResourceTreeModel.Events.WillReloadPage, event => {
        if (this.busy) {
          this.fail(new Error('복원 중 페이지를 새로고침하여 재실행을 중단했습니다.'));
          return;
        }
        if (!Common.Settings.Settings.instance().moduleSetting('breakpoints-active').get()) {
          return;
        }
        if (this.session.error) {
          // 실패한 실행은 이어 붙이지 않는다. 사용자가 페이지를 다시 로드하면 새 기록을 시작한다.
          this.#releaseRecording();
          this.session.reset();
          this.#installInterceptors(model);
          this.#documentLoaded = false;
          // 같은 대상의 viewport와 터치 설정은 새 문서에서도 그대로 적용된다.
          if (this.#browserViewport) {
            this.#appendInput(this.#browserViewport);
          }
          if (this.#browserTouchEnabled) {
            this.#appendInput({type: 'touch', enabled: true});
          }
        }
        this.recordBrowserInput({type: 'reload', ...(event.data ?? {})});
        this.#notifyStatusChanged();
      }));
      this.#listeners.push(resources.addEventListener(SDK.ResourceTreeModel.Events.FrameNavigated, event => {
        if (!event.data.isMainFrame()) {
          return;
        }
        this.#document++;
        this.#documentLoaded = event.data.backForwardCacheDetails.restoredFromCache === true;
        this.#notifyProgress();
      }));
      this.#listeners.push(resources.addEventListener(SDK.ResourceTreeModel.Events.Load, () => {
        this.#documentLoaded = true;
        this.#notifyProgress();
      }));
    }
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
      this.#listeners.push(consoleModel.addEventListener(SDK.ConsoleModel.Events.CommandEvaluated, event => {
        const input = this.#consoleInputByMessage.get(event.data.commandMessage);
        if (input) {
          input.exception = consoleExceptionMessage(event.data.exceptionDetails);
          this.#completeInput(input);
          this.#consoleInputByMessage.delete(event.data.commandMessage);
          this.#finishConsoleInputs();
        }
      }));
      this.#listeners.push(consoleModel.addEventListener(SDK.ConsoleModel.Events.CommandEvaluationFailed, event => {
        if (this.#consoleInputByMessage.has(event.data.commandMessage)) {
          this.fail(new Error(`Console 입력을 실행하지 못했습니다: ${event.data.error}`));
        }
      }));
    }
  }

  #installInterceptors(model: SDK.DebuggerModel.DebuggerModel): void {
    model.setPauseInterceptor(details => this.#handlePause(details));
    model.setExecutionInterceptor(command => this.#handleExecutionCommand(command));
    model.setScriptExecutionPreparation(script => this.#prepareScriptExecution(script));
  }

  #recordConsoleInput(command: SDK.ConsoleModel.ConsoleCommand): void {
    if (this.session.error) {
      return;
    }
    if (this.#isReplaying) {
      this.fail(new Error('복원 중 콘솔에서 코드가 실행되어 뒤로가기를 중단했습니다. 새 세션에서 시작해 주세요.'));
      return;
    }
    const model = this.#debuggerModel;
    let callFrame: ConsoleInput['callFrame'];
    if (model?.isPaused()) {
      const selected = model.selectedCallFrame();
      const frames = model.debuggerPausedDetails()?.callFrames ?? [];
      const ids = [...new Set(frames.map(frame => frame.id))];
      if (!selected || !this.session.atRecordedPause || !this.#lastPosition) {
        this.fail(new Error('기록되지 않은 정지에서 Console을 실행했습니다. 새 기록에서 시작해 주세요.'));
        return;
      }
      callFrame = {
        index: ids.indexOf(selected.id),
        inlineFrameIndex: selected.inlineFrameIndex,
        functionName: selected.functionName,
        position: this.#framePosition(selected),
      };
    }
    const {expression, useCommandLineAPI, userGesture} = command;
    if (!callFrame) {
      this.#activeConsoleInput = this.#inputs.length;
    }
    const input = this.#appendInput({type: 'console', expression, useCommandLineAPI, userGesture, callFrame}, true) as
            RecordedInput &
        ConsoleInput;
    if (callFrame) {
      // 연속 Enter도 제출 순서대로 각자의 상태 경계를 갖는다.
      input.afterPosition += this.#pendingConsoleInputs.length;
      this.#pendingConsoleInputs.push(input);
    }
    this.#consoleInputByMessage.set(command.commandMessage, input);
    this.#notifyStatusChanged();
  }

  #framePosition(frame: SDK.DebuggerModel.CallFrame): ExecutionPosition {
    const {lineNumber, columnNumber} = frame.location();
    return {
      url: this.#scriptScopes.get(frame.script.scriptId)?.url ?? frame.script.sourceURL,
      hash: frame.script.hash,
      lineNumber,
      columnNumber,
    };
  }

  #finishConsoleInputs(): void {
    while (this.#pendingConsoleInputs.length) {
      const input = this.#pendingConsoleInputs[0];
      if (!this.#completedInputs.has(input.sequence)) {
        break;
      }
      if (!this.#debuggerModel?.isPaused() || !this.session.atRecordedPause || !this.#lastPosition ||
          input.afterPosition !== this.session.history.length) {
        this.fail(new Error('Console 입력 중 실행 위치가 바뀌어 기록을 중단했습니다.'));
        return;
      }
      this.#pendingConsoleInputs.shift();
      this.session.recordConsoleInput(this.#lastPosition);
      if (!this.#finishRecordedPosition()) {
        return;
      }
    }
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
    const input = this.#inputs[index];
    if (!input || input.type !== 'console') {
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
    // 재시작으로 취소되는 이전 대상의 Console 응답은 새 재생에 반영하지 않는다.
    this.#consoleInputByMessage = new WeakMap();
    this.#isReplaying = true;
    this.#replayedPositions = 0;
    this.#selectedSources.clear();
    this.#scopeChangeIndex = 0;
    this.#scopeEntry = null;
    this.#pendingStep = null;
    this.#replayInputCount = 0;
    this.#document = 0;
    this.#documentLoaded = true;
    this.#browserTouchEnabled = false;
    this.#browserViewport = null;
    this.#heldMouse.clear();
    this.#heldKeys.clear();
    this.#releaseHeldInputsOnExecution = false;
    this.#completedInputs.clear();
    this.#inputCompletions.clear();
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
    const generation = this.#replayGeneration;
    const ws = await this.#restartTarget?.();
    if (generation !== this.#replayGeneration) {
      return;
    }
    if (!ws || this.session.error) {
      throw new Error(this.session.error ?? '재시작한 대상의 연결 주소가 없습니다.');
    }
    await this.#connectToTarget?.(ws);
    if (generation !== this.#replayGeneration) {
      return;
    }
    if (this.session.error) {
      throw new Error(this.session.error);
    }
    await this.#restoreStart();
    if (generation !== this.#replayGeneration || !this.session.replaying) {
      return;
    }
    // 콘솔 원문도 실행 입력이다. 변수·힙을 저장하지 않고 같은 순서로 다시 제출한다.
    void this.#replayInputs(generation).catch(error => {
      if (generation === this.#replayGeneration && this.session.replaying) {
        this.fail(error);
      }
    });
    await completed;
  }

  async #restoreStart(): Promise<void> {
    const start = this.#recordingStart;
    const model = this.#debuggerModel;
    if (!start || !model || model.target().type() === SDK.Target.Type.NODE) {
      return;
    }
    const generation = this.#replayGeneration;
    const {url, hash, lineNumber, columnNumber} = start.position;
    const breakpoint = await model.agent.invoke_setBreakpointByUrl({
      ...(url.startsWith('backdo-console:///') ? {scriptHash: hash} : {url}),
      lineNumber,
      columnNumber,
    });
    if (breakpoint.getError()) {
      throw new Error(breakpoint.getError());
    }
    if (generation !== this.#replayGeneration || !this.session.replaying) {
      await model.agent.invoke_removeBreakpoint({breakpointId: breakpoint.breakpointId});
      return;
    }
    this.#entryBreakpoint = breakpoint.breakpointId;
    this.#recordingBreakpointIds.add(breakpoint.breakpointId);
    if (this.#startURL && this.#startURL !== 'about:blank') {
      // 연결 전에 이미 열린 페이지가 있었다면 그것만 시작점으로 복원한다.
      // 이후 주소 입력·링크 클릭은 입력 로그에서 각각 한 번만 실행한다.
      this.#document = -1;
      this.#documentLoaded = false;
      const response = await model.target().pageAgent().invoke_navigate({url: this.#startURL});
      if (response.getError() || response.errorText) {
        throw new Error(response.getError() || response.errorText);
      }
    }
  }

  async #replayInputs(generation: number): Promise<void> {
    for (let index = 0; index < this.#inputs.length; index++) {
      const input = this.#inputs[index];
      await this.#waitForInput(input, generation);
      if (!this.#replayActive(generation)) {
        return;
      }
      const submitted = Promise.withResolvers<void>();
      const onSent = (): void => {
        if (input.type === 'console' && !input.callFrame) {
          this.#activeConsoleInput = index;
        }
        this.#replayInputCount = index + 1;
        for (const completed of input.afterInputs) {
          this.#inputCompletions.delete(completed);
        }
        this.#applyInputState(input);
        submitted.resolve();
        this.#notifyProgress();
      };
      if (input.type === 'console' && input.callFrame) {
        // 멈춘 프레임의 명령은 평가가 끝난 뒤에만 다음 상태로 진행한다.
        await this.#dispatchInput(input, generation, onSent);
        if (!this.#replayActive(generation)) {
          return;
        }
        this.#completeInput(input);
        if (!this.#lastPosition) {
          throw new Error('Console 입력을 재생할 정지 위치가 없습니다.');
        }
        this.session.recordConsoleInput(this.#lastPosition);
        if (!this.#finishRecordedPosition()) {
          return;
        }
        this.#notifyProgress();
        continue;
      }
      // 원본에서 완료된 입력만 장벽으로 삼는다. debugger 때문에 미완료였던
      // press/evaluate는 다음 release 등을 막지 않고 실제 전송 순서만 보존한다.
      void this.#dispatchInput(input, generation, onSent)
          .then(() => {
            if (generation === this.#replayGeneration) {
              this.#completeInput(input);
            }
          })
          .catch(error => {
            if (this.#replayActive(generation)) {
              this.fail(error);
            }
          })
          .finally(() => submitted.resolve());
      await submitted.promise;
    }
  }

  #replayActive(generation: number): boolean {
    return generation === this.#replayGeneration && this.session.replaying && !this.session.error;
  }

  async #waitForInput(input: RecordedInput, generation: number): Promise<void> {
    while (this.#replayActive(generation) &&
           ((!input.paused && this.#preparingPause && !this.#waitingForEntryInput(input) &&
             !(this.#scopeEntry && input.sequence < this.#scopeEntry.change.inputCount &&
               input.afterPosition === this.#replayedPositions)) ||
            input.afterInputs.some(index => !this.#completedInputs.has(index)) ||
            this.#replayedPositions < input.afterPosition || this.#document < input.document ||
            (input.loaded && !this.#documentLoaded))) {
      await new Promise<void>(resolve => this.#progressListeners.add(resolve));
    }
    if (this.#replayActive(generation) &&
        (this.#replayedPositions !== input.afterPosition || this.#document !== input.document)) {
      throw new Error('입력 시점이 기록된 문서·실행 순서와 달라졌습니다.');
    }
  }

  #waitingForEntryInput(input: RecordedInput): boolean {
    return Boolean(
        this.#entryBreakpoint && input.sequence < (this.#recordingStart?.inputCount ?? 0) &&
        input.afterPosition === 0 && input.document === this.#document && input.type !== 'console');
  }

  async #dispatchInput(input: RecordedInput, generation: number, onSent: () => void = () => {}): Promise<void> {
    const target = this.#debuggerModel?.target();
    const epoch = this.#documentEpoch;
    if (!target) {
      throw new Error('입력을 실행할 대상이 없습니다.');
    }
    if (this.#replayActive(generation) && this.#browserTouchEnabled && !input.paused && input.type === 'mouse' &&
        input.params.type === Protocol.Input.DispatchMouseEventRequestType.MousePressed) {
      // Chrome 133에서는 로드 직후 compositor 갱신 전 첫 터치가 누락될 수 있다.
      // 좌표계를 바꾸지 않는 화면 readback 완료를 기다리고 이미지 데이터는 버린다.
      const frame = await target.pageAgent().invoke_captureScreenshot({
        format: Protocol.Page.CaptureScreenshotRequestFormat.Jpeg,
        quality: 0,
        fromSurface: true,
        captureBeyondViewport: false,
      });
      if (frame.getError()) {
        throw new Error(frame.getError());
      }
      await this.#waitForInput(input, generation);
      if (!this.#replayActive(generation)) {
        return;
      }
    }
    if (input.type !== 'history') {
      onSent();
    }
    if (input.type === 'console') {
      let exceptionDetails: Protocol.Runtime.ExceptionDetails|undefined;
      let error: string|undefined;
      if (input.callFrame) {
        const {index, inlineFrameIndex, functionName, position} = input.callFrame;
        const frames = this.#pausedDetails?.callFrames ?? [];
        const frame = [...new Map(frames.map(frame => [frame.id, frame])).values()][index];
        if (!frame || !samePosition(this.#framePosition(frame), position)) {
          throw new Error('Console 입력의 호출 프레임이 원래 기록과 다릅니다.');
        }
        const selected = inlineFrameIndex ?
            new SDK.DebuggerModel.CallFrame(
                frame.debuggerModel, frame.script, frame.payload, inlineFrameIndex, functionName) :
            frame;
        const result = await selected.evaluate({
          expression: input.expression,
          objectGroup: 'console',
          includeCommandLineAPI: input.useCommandLineAPI,
          silent: false,
          returnByValue: false,
          generatePreview: false,
        });
        if ('error' in result) {
          error = result.error;
        } else {
          exceptionDetails = result.exceptionDetails;
          result.object?.release();
        }
      } else {
        const response = await target.runtimeAgent().invoke_evaluate({
          expression: input.expression,
          includeCommandLineAPI: input.useCommandLineAPI,
          userGesture: input.userGesture,
          objectGroup: 'console',
          replMode: true,
          awaitPromise: false,
          allowUnsafeEvalBlockedByCSP: false,
        });
        error = response.getError();
        exceptionDetails = response.exceptionDetails;
      }
      if (generation !== this.#replayGeneration) {
        return;
      }
      if (epoch !== this.#documentEpoch) {
        return;
      }
      if (error && this.session.replaying) {
        throw new Error(error);
      }
      const exception = consoleExceptionMessage(exceptionDetails);
      if (!this.session.replaying) {
        input.exception = exception;
      } else if (exception !== input.exception) {
        throw new Error(`Console 입력의 실행 결과가 달라졌습니다: ${exception ?? '기존 예외가 발생하지 않았습니다.'}`);
      }
      return;
    }
    let response: {getError(): string|undefined}|undefined;
    switch (input.type) {
      case 'mouse':
        response = await target.inputAgent().invoke_dispatchMouseEvent(input.params);
        break;
      case 'key':
        response = await target.inputAgent().invoke_dispatchKeyEvent(input.params);
        break;
      case 'navigate': {
        const navigation = await target.pageAgent().invoke_navigate({url: input.url});
        if (navigation.errorText && this.#replayActive(generation)) {
          throw new Error(navigation.errorText);
        }
        response = navigation;
        break;
      }
      case 'reload':
        response = await target.pageAgent().invoke_reload({
          ignoreCache: input.ignoreCache,
          scriptToEvaluateOnLoad: input.scriptToEvaluateOnLoad,
        });
        break;
      case 'history': {
        const history = await target.pageAgent().invoke_getNavigationHistory();
        if (!this.#replayActive(generation)) {
          return;
        }
        const entry = history.entries?.[history.currentIndex + input.offset];
        if (history.getError() || !entry) {
          throw new Error(history.getError() || '재생할 방문 기록이 없습니다.');
        }
        onSent();
        response = await target.pageAgent().invoke_navigateToHistoryEntry({entryId: entry.id});
        break;
      }
      case 'touch':
        await target.model(SDK.EmulationModel.EmulationModel)?.overrideEmulateTouch(input.enabled);
        break;
      case 'viewport':
        response = await target.emulationAgent().invoke_setDeviceMetricsOverride({
          width: input.width,
          height: input.height,
          deviceScaleFactor: input.deviceScaleFactor,
          mobile: false,
        });
        break;
    }
    if (response?.getError() && epoch === this.#documentEpoch && this.#replayActive(generation)) {
      throw new Error(response.getError());
    }
  }

  #applyInputState(input: ConsoleInput|BrowserInput): void {
    if (input.type === 'touch') {
      this.#browserTouchEnabled = input.enabled;
    } else if (input.type === 'viewport') {
      this.#browserViewport = input;
    } else if (input.type === 'mouse') {
      const button = input.params.button ?? Protocol.Input.MouseButton.None;
      if (input.params.type === Protocol.Input.DispatchMouseEventRequestType.MousePressed) {
        this.#heldMouse.set(button, input.params);
      } else if (input.params.type === Protocol.Input.DispatchMouseEventRequestType.MouseReleased) {
        this.#heldMouse.delete(button);
      }
      for (const [held, params] of this.#heldMouse) {
        this.#heldMouse.set(held, {...params, x: input.params.x, y: input.params.y});
      }
    } else if (input.type === 'key') {
      const key = input.params.code ?? String(input.params.windowsVirtualKeyCode);
      if (input.params.type === Protocol.Input.DispatchKeyEventRequestType.KeyUp) {
        this.#heldKeys.delete(key);
      } else if (input.params.type !== Protocol.Input.DispatchKeyEventRequestType.Char) {
        this.#heldKeys.set(key, input.params);
      }
    }
  }

  #finishInputReplay(): void {
    this.#inputs.splice(this.#replayInputCount);
    this.#completedInputs = new Set([...this.#completedInputs].filter(index => index < this.#inputs.length));
    this.#inputCompletions = new Set([...this.#inputCompletions].filter(index => index < this.#inputs.length));
    this.#releaseHeldInputsOnExecution = true;
    // 복원 지점 뒤의 Step과 범위 확장은 새 실행 분기에 이어 붙이지 않는다.
    this.#steps = this.#steps.filter(step => step.afterPosition < this.session.history.length);
    this.#scopeChanges = this.#scopeChanges.filter(change => change.afterPosition < this.session.history.length);
    this.#pendingStep = null;
  }

  #releaseHeldInputs(): void {
    if (!this.#releaseHeldInputsOnExecution) {
      return;
    }
    this.#releaseHeldInputsOnExecution = false;
    const releases: BrowserInput[] = [];
    const remainingKeys = new Map(this.#heldKeys);
    const modifiersForHeldKeys = (): number => [...remainingKeys.values()].reduce(
        (bits, params) => bits | keyModifierMask(params.code ?? ''), 0);
    let buttons = [...this.#heldMouse.keys()].reduce((bits, button) => bits | mouseButtonMask(button), 0);
    for (const [button, params] of this.#heldMouse) {
      buttons &= ~mouseButtonMask(button);
      releases.push({
        type: 'mouse',
        params: {
          ...params,
          type: Protocol.Input.DispatchMouseEventRequestType.MouseReleased,
          buttons,
          modifiers: modifiersForHeldKeys()
        }
      });
    }
    for (const [key, params] of this.#heldKeys) {
      remainingKeys.delete(key);
      const modifiers = modifiersForHeldKeys();
      releases.push(
          {type: 'key', params: {...params, type: Protocol.Input.DispatchKeyEventRequestType.KeyUp, modifiers}});
    }
    // 미래 조작을 재생하지 않는다. 현재 좌표에서 아직 눌린 입력만 새 분기의
    // 첫 입력으로 해제한다. 사용자가 이미 직접 해제했다면 Map에 남아 있지 않다.
    const generation = this.#replayGeneration;
    for (const release of releases) {
      const input = this.#appendInput(release, true);
      this.#applyInputState(release);
      void this.#dispatchInput(input, generation)
          .then(() => {
            if (generation === this.#replayGeneration) {
              this.#completeInput(input);
            }
          })
          .catch(error => {
            if (generation === this.#replayGeneration) {
              this.fail(error);
            }
          });
    }
  }

  async #scriptScope(script: SDK.Script.Script): Promise<ScriptScope|null> {
    if (isInternalScript(script)) {
      return null;
    }
    const cached = this.#scriptScopes.get(script.scriptId);
    if (cached) {
      return cached;
    }
    const epoch = this.#documentEpoch;
    const url = await this.#consoleSources.get(script.scriptId) ?? script.sourceURL;
    if (!url || epoch !== this.#documentEpoch || script.debuggerModel !== this.#debuggerModel) {
      return null;
    }
    const scope = await ScriptScope.create(script, url);
    if (epoch !== this.#documentEpoch || script.debuggerModel !== this.#debuggerModel) {
      return null;
    }
    this.#scriptScopes.set(script.scriptId, scope);
    return scope;
  }

  #selectSources(sources: string[], entry?: ExecutionPosition, inputCount = this.#inputs.length): void {
    const added = [...new Set(sources)].filter(source => !this.#selectedSources.has(source));
    if (!added.length) {
      return;
    }
    for (const source of added) {
      this.#selectedSources.add(source);
    }
    if (!this.#isReplaying) {
      this.#scopeChanges.push({afterPosition: this.session.history.length, sources: added, entry, inputCount});
    }
  }

  async #prepareScopeChanges(): Promise<void> {
    const model = this.#debuggerModel;
    if (!this.#isReplaying || !model) {
      return;
    }
    const generation = this.#replayGeneration;
    const epoch = this.#documentEpoch;
    while (this.#scopeChangeIndex < this.#scopeChanges.length) {
      const change = this.#scopeChanges[this.#scopeChangeIndex];
      if (change.afterPosition !== this.#replayedPositions) {
        return;
      }
      if (change.entry) {
        if (!this.#scopeEntry) {
          const {url, hash, lineNumber, columnNumber} = change.entry;
          const response = await model.agent.invoke_setBreakpointByUrl({
            ...(url.startsWith('backdo-console:///') ? {scriptHash: hash} : {url}),
            lineNumber,
            columnNumber,
          });
          if (generation !== this.#replayGeneration || epoch !== this.#documentEpoch || model !== this.#debuggerModel) {
            if (response.breakpointId) {
              void model.agent.invoke_removeBreakpoint({breakpointId: response.breakpointId});
            }
            return;
          }
          if (response.getError()) {
            throw new Error(response.getError());
          }
          this.#scopeEntry = {change, breakpointId: response.breakpointId};
          this.#recordingBreakpointIds.add(response.breakpointId);
        }
        return;
      }
      this.#selectSources(change.sources);
      this.#scopeChangeIndex++;
    }
  }

  async #recordedScript(script: SDK.Script.Script): Promise<RecordedScript|null> {
    const epoch = this.#documentEpoch;
    const scope = await this.#scriptScope(script);
    if (!scope?.hasSelectedSource(this.#selectedSources)) {
      return null;
    }
    const recorded = this.#scripts.get(script.scriptId);
    if (recorded && this.#preparedScopeSizes.get(script.scriptId) === this.#selectedSources.size) {
      return recorded;
    }
    try {
      const result = await this.#installRecordingBreakpoints(script, scope, epoch, recorded);
      if (epoch !== this.#documentEpoch || script.debuggerModel !== this.#debuggerModel) {
        return null;
      }
      this.#scripts.set(script.scriptId, result);
      this.#preparedScopeSizes.set(script.scriptId, this.#selectedSources.size);
      return result;
    } catch (error) {
      if (epoch !== this.#documentEpoch || script.debuggerModel !== this.#debuggerModel) {
        return null;
      }
      throw error;
    }
  }

  async #prepareRecordingScripts(refresh = false): Promise<void> {
    const model = this.#debuggerModel;
    if (!model || (this.#scriptsPrepared && !refresh)) {
      return;
    }
    if (!this.#scriptsPrepared) {
      this.#scriptsPrepared = true;
      const response = await model.agent.invoke_setInstrumentationBreakpoint({
        instrumentation: Protocol.Debugger.SetInstrumentationBreakpointRequestInstrumentation.BeforeScriptExecution,
      });
      if (response.getError()) {
        throw new Error(response.getError());
      }
      if (model !== this.#debuggerModel) {
        void model.agent.invoke_removeBreakpoint({breakpointId: response.breakpointId});
        return;
      }
      this.#scriptExecutionBreakpoint = response.breakpointId;
    }
    // 이미 불러온 모듈은 최초 정지에서, 나중에 불러오는 모듈은 실행 직전에 준비한다.
    const epoch = this.#documentEpoch;
    for (const script of model.scripts()) {
      if (epoch !== this.#documentEpoch || model !== this.#debuggerModel) {
        break;
      }
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

  async #installRecordingBreakpoints(
      script: SDK.Script.Script, scope: ScriptScope, epoch: number,
      previous?: RecordedScript): Promise<RecordedScript> {
    const url = scope.url;
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
    const positions = previous?.positions ?? new Set<string>();
    const debuggerStatements = previous?.debuggerStatements ?? new Set<string>();
    const resolvedPositions = new Map<string, string>();
    for (const location of result.locations) {
      if (epoch !== this.#documentEpoch || model !== this.#debuggerModel) {
        break;
      }
      if (!scope.includes(location, this.#selectedSources)) {
        continue;
      }
      const requestedKey = positionKey(location);
      let actualKey: string|null|undefined = resolvedPositions.get(requestedKey);
      if (!actualKey) {
        // 앞선 후보가 이 위치로 보정되었다면 이미 설치한 중단점을 사용한다.
        actualKey = positions.has(requestedKey) ?
            requestedKey :
            await this.#installRecordingBreakpoint(script, location, positions, epoch, scope);
        if (!actualKey) {
          continue;
        }
        resolvedPositions.set(requestedKey, actualKey);
      }
      if (location.type === Protocol.Debugger.BreakLocationType.DebuggerStatement) {
        debuggerStatements.add(actualKey);
      }
    }
    return {url, positions, debuggerStatements};
  }

  async #installRecordingBreakpoint(
      script: SDK.Script.Script, location: Protocol.Debugger.Location, positions: Set<string>, epoch: number,
      scope: ScriptScope): Promise<string|null> {
    const agent = script.debuggerModel.agent;
    const breakpoint = await agent.invoke_setBreakpoint({location});
    if (epoch !== this.#documentEpoch || script.debuggerModel !== this.#debuggerModel) {
      if (breakpoint.breakpointId) {
        void agent.invoke_removeBreakpoint({breakpointId: breakpoint.breakpointId});
      }
      return positionKey(location);
    }
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
    if (!scope.includes(actualLocation, this.#selectedSources)) {
      const removed = await agent.invoke_removeBreakpoint({breakpointId});
      if (removed.getError()) {
        throw new Error(removed.getError());
      }
      this.#recordingBreakpointIds.delete(breakpointId);
      return null;
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
    const generation = this.#replayGeneration;
    const inputCountAtPause = this.#inputs.length;
    const modelAtPause = this.#debuggerModel;
    if (!modelAtPause) {
      return false;
    }
    const epochAtPause = this.#documentEpoch;
    const pauseSequence = ++this.#pauseSequence;
    this.#preparingPause = true;
    try {
      if (!this.#isReplaying && !this.session.history.length) {
        await this.#prepareTarget?.();
      }
      if (epochAtPause !== this.#documentEpoch || modelAtPause !== this.#debuggerModel) {
        return true;
      }
      const frame = details.callFrames[0];
      this.#pausedDetails = details;
      if (this.#entryBreakpoint) {
        if (!details.breakpointIds.includes(this.#entryBreakpoint)) {
          await this.#resumeExecution();
          return true;
        }
        // 첫 정지 통지보다 먼저 보냈던 press/release를 모두 제출할 때까지
        // 이 시작점을 유지한다. 전송 지연 때문에 유일한 시작점을 지나치지 않는다.
        this.#notifyProgress();
        while (this.#replayActive(generation) && this.#replayInputCount < (this.#recordingStart?.inputCount ?? 0)) {
          await new Promise<void>(resolve => this.#progressListeners.add(resolve));
        }
        if (epochAtPause !== this.#documentEpoch || modelAtPause !== this.#debuggerModel ||
            !this.#replayActive(generation)) {
          return true;
        }
        const breakpointId = this.#entryBreakpoint;
        const removed = await this.#debuggerModel?.agent.invoke_removeBreakpoint({breakpointId});
        if (epochAtPause !== this.#documentEpoch || modelAtPause !== this.#debuggerModel) {
          return true;
        }
        if (removed?.getError()) {
          throw new Error(removed.getError());
        }
        this.#entryBreakpoint = null;
        this.#recordingBreakpointIds.delete(breakpointId);
      }
      let initial = frame && !this.#scripts.has(frame.script.scriptId);
      const scopeSize = this.#selectedSources.size;
      if (!this.#isReplaying && !this.session.history.length) {
        this.#selectSources(this.#breakpointSources());
      }
      await this.#prepareScopeChanges();
      const scope = frame && await this.#scriptScope(frame.script);
      if (frame && scope) {
        const location = frame.location();
        initial ||= !scope.includes(location, this.#selectedSources);
        const position = {
          url: scope.url,
          hash: frame.script.hash,
          lineNumber: location.lineNumber,
          columnNumber: location.columnNumber,
        };
        if (this.#isReplaying) {
          const pending = this.#scopeEntry;
          if (pending?.change.entry && samePosition(pending.change.entry, position)) {
            this.#notifyProgress();
            while (this.#replayActive(generation) && this.#replayInputCount < pending.change.inputCount) {
              await new Promise<void>(resolve => this.#progressListeners.add(resolve));
            }
            if (!this.#replayActive(generation)) {
              return true;
            }
            const removed = await modelAtPause.agent.invoke_removeBreakpoint({
              breakpointId: pending.breakpointId as Protocol.Debugger.BreakpointId,
            });
            if (epochAtPause !== this.#documentEpoch || modelAtPause !== this.#debuggerModel ||
                !this.#replayActive(generation)) {
              return true;
            }
            if (removed.getError()) {
              throw new Error(removed.getError());
            }
            this.#recordingBreakpointIds.delete(pending.breakpointId);
            this.#scopeEntry = null;
            this.#selectSources(pending.change.sources);
            this.#scopeChangeIndex++;
          }
        } else if (!scope.includes(location, this.#selectedSources) && this.#scriptFilter(frame.script)) {
          // 이 경로에는 실제 사용자 정지만 온다. 기록용 중단점은 선택된 위치에만 설치한다.
          this.#selectSources(
              [scope.sourceAt(location)], this.session.history.length ? position : undefined, inputCountAtPause);
        }
      }
      await this.#prepareRecordingScripts(scopeSize !== this.#selectedSources.size);
      // Node의 시작 정지는 재시작 기준점으로 보관한다.
      const breakOnStart = String(details.reason) === 'Break on start';
      let script = frame && scope?.includes(frame.location(), this.#selectedSources) ?
          await this.#recordedScript(frame.script) :
          null;
      if (!script && frame && breakOnStart && !isInternalScript(frame.script)) {
        script = {url: frame.script.sourceURL, positions: new Set(), debuggerStatements: new Set()};
      }
      if (epochAtPause !== this.#documentEpoch || modelAtPause !== this.#debuggerModel) {
        return true;
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
      if (!this.#isReplaying && !this.session.history.length) {
        this.#startURL ??=
            this.#debuggerModel?.target().model(SDK.ResourceTreeModel.ResourceTreeModel)?.mainFrame?.url ?? null;
        this.#recordingStart = {position, inputCount: inputCountAtPause};
      }
      const hitRecordingBreakpoint = details.breakpointIds.some(id => this.#recordingBreakpointIds.has(id));
      const hitStep = Boolean(this.#pendingStep) && details.reason === Protocol.Debugger.PausedEventReason.Step;
      // Node의 시작 정지는 일반 중단점이 없는 import 앞에도 오며, --inspect-brk 재시작으로 재현된다.
      if (!initial && !breakOnStart && !hitStep && !hitRecordingBreakpoint && !script.debuggerStatements.has(key)) {
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
      const disposition = this.session.recordPause({
        position,
        depth: details.callFrames.length,
        userVisible: Boolean(initial) || script.debuggerStatements.has(key) || !this.#isRecordingPause(details),
      });
      this.#lastPosition = position;
      if (!this.#isReplaying) {
        // pause 준비를 기다리는 동안 들어온 release도 현재 정지에 연결한다.
        for (const input of this.#inputs.slice(inputCountAtPause)) {
          input.afterPosition = this.session.history.length;
        }
      }
      if (!this.#finishRecordedPosition()) {
        return false;
      }
      if (disposition === 'continue') {
        await this.#flushInputsAtPause(generation);
        if (epochAtPause !== this.#documentEpoch || modelAtPause !== this.#debuggerModel ||
            generation !== this.#replayGeneration) {
          return true;
        }
        if (!this.#isReplaying || this.session.replaying) {
          await this.#continueExecution(details.callFrames.length);
          return true;
        }
        // Console 명령 완료가 목표였다면 같은 pause를 SDK에 표시한다.
      }
      this.#pendingStep = null;
      this.#notifyProgress();
      this.#notifyStatusChanged();
      return false;
    } catch (error) {
      if (epochAtPause !== this.#documentEpoch || modelAtPause !== this.#debuggerModel ||
          generation !== this.#replayGeneration) {
        return true;
      }
      this.fail(error);
      return false;
    } finally {
      if (epochAtPause === this.#documentEpoch && pauseSequence === this.#pauseSequence) {
        this.#preparingPause = false;
        this.#notifyProgress();
      }
    }
  }

  #isRecordingPause(details: SDK.DebuggerModel.DebuggerPausedDetails): boolean {
    if (!details.breakpointIds.length || !details.breakpointIds.every(id => this.#recordingBreakpointIds.has(id))) {
      return false;
    }
    if (details.reason === Protocol.Debugger.PausedEventReason.Other ||
        details.reason === Protocol.Debugger.PausedEventReason.Step) {
      return details.auxData === undefined;
    }
    // V8는 Step과 중단점이 겹치면 ambiguous로 보낸다. 다른 정지 이유가 섞이면 그대로 표시한다.
    const reasons = details.reason === Protocol.Debugger.PausedEventReason.Ambiguous ? details.auxData?.reasons : null;
    return Array.isArray(reasons) && reasons.length > 0 &&
        reasons.every(
            item => item !== null && typeof item === 'object' && item.auxData === undefined &&
                (item.reason === Protocol.Debugger.PausedEventReason.Other ||
                 item.reason === Protocol.Debugger.PausedEventReason.Step));
  }

  #finishRecordedPosition(): boolean {
    if (!this.#isReplaying && this.session.history.canReverse &&
        (this.#timing.estimate(this.session.history.length) ?? 0) >= REPLAY_RESPONSE_BUDGET_MS) {
      this.fail(new Error(REPLAY_TIME_LIMIT_MESSAGE));
      return false;
    }
    if (this.#isReplaying) {
      this.#replayedPositions++;
      if (!this.session.replaying) {
        this.#finishInputReplay();
      }
    }
    this.#notifyUsageChanged();
    return true;
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
    if (command !== 'pause') {
      this.#releaseHeldInputs();
    }
    this.session.beginExecution(command);
    this.#pendingStep = null;
    if (command === 'step-into' || command === 'step-over' || command === 'step-out') {
      const step = {
        afterPosition: this.session.history.length,
        command,
        depth: this.#debuggerModel?.debuggerPausedDetails()?.callFrames.length ?? 0,
      };
      this.#steps.push(step);
      this.#pendingStep = step;
    }
    this.#notifyStatusChanged();
    // 중단점을 추가한 뒤 실행하는 경우도 이 정지 경계부터 범위에 포함한다.
    const scopeSize = this.#selectedSources.size;
    this.#selectSources(this.#breakpointSources());
    const generation = this.#replayGeneration;
    void (async () => {
      if (scopeSize !== this.#selectedSources.size) {
        await this.#prepareRecordingScripts(true);
      }
      if (generation === this.#replayGeneration && !this.session.error) {
        await this.#sendExecution(command);
      }
    })().catch(error => {
      if (generation === this.#replayGeneration) {
        this.fail(error);
      }
    });
    return true;
  }

  async #sendExecution(command: SDK.DebuggerModel.ExecutionCommand): Promise<void> {
    const model = this.#debuggerModel;
    if (!model) {
      return;
    }
    // SDK의 소스맵 skipList와 native Step을 그대로 사용한다. 재귀 가로채기만 잠시 해제한다.
    const generation = this.#replayGeneration;
    model.setExecutionInterceptor(null);
    try {
      switch (command) {
        case 'step-into':
          await model.stepInto(this.#pausedDetails?.callFrames[0]);
          break;
        case 'step-over':
          await model.stepOver(this.#pausedDetails?.callFrames[0]);
          break;
        case 'step-out':
          await model.stepOut(this.#pausedDetails?.callFrames[0]);
          break;
        case 'pause':
          model.pause();
          break;
        default:
          await this.#resumeExecution();
      }
    } finally {
      if (generation === this.#replayGeneration && model === this.#debuggerModel && !this.session.error) {
        model.setExecutionInterceptor(next => this.#handleExecutionCommand(next));
      }
    }
  }

  async #continueExecution(depth: number): Promise<void> {
    if (this.#isReplaying) {
      const scopeSize = this.#selectedSources.size;
      await this.#prepareScopeChanges();
      if (scopeSize !== this.#selectedSources.size) {
        await this.#prepareRecordingScripts(true);
      }
      const step = this.#steps.find(item => item.afterPosition === this.#replayedPositions);
      if (step) {
        this.#pendingStep = step;
        await this.#sendExecution(step.command);
        return;
      }
    }
    if (this.#pendingStep) {
      const step = this.#pendingStep;
      const reached =
          step.command === 'step-into' || (step.command === 'step-over' ? depth <= step.depth : depth < step.depth);
      if (!reached) {
        // 기록용 중단점이 native Step을 끊었으면 호출 스택 밖으로 나가는 Step을 계속한다.
        await this.#sendExecution('step-out');
        return;
      }
      this.#pendingStep = null;
    }
    await this.#resumeExecution();
  }

  async #flushInputsAtPause(generation: number): Promise<void> {
    this.#notifyProgress();
    while (this.#replayActive(generation)) {
      const evaluating = this.#inputs.some(
          input => input.type === 'console' && input.callFrame && input.sequence < this.#replayInputCount &&
              !this.#completedInputs.has(input.sequence));
      const next = this.#inputs[this.#replayInputCount];
      const waiting = next?.paused && next.afterPosition === this.#replayedPositions &&
          next.document === this.#document && (!next.loaded || this.#documentLoaded);
      if (!evaluating && !waiting) {
        return;
      }
      await new Promise<void>(resolve => this.#progressListeners.add(resolve));
    }
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
    this.#inputs = [];
    this.#pendingConsoleInputs = [];
    this.#consoleInputByMessage = new WeakMap();
    this.#consoleSources.clear();
    this.#scripts.clear();
    this.#scriptScopes.clear();
    this.#preparedScopeSizes.clear();
    this.#selectedSources.clear();
    this.#scopeChanges = [];
    this.#scopeChangeIndex = 0;
    this.#scopeEntry = null;
    this.#steps = [];
    this.#pendingStep = null;
    this.#pausedDetails = undefined;
    this.#activeConsoleInput = null;
    this.#startURL = null;
    this.#recordingStart = null;
    this.#document = 0;
    this.#documentLoaded = true;
    this.#documentEpoch++;
    this.#heldMouse.clear();
    this.#heldKeys.clear();
    this.#releaseHeldInputsOnExecution = false;
    this.#completedInputs.clear();
    this.#inputCompletions.clear();
    this.#entryBreakpoint = null;
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

function consoleExceptionMessage(details?: Protocol.Runtime.ExceptionDetails): string|undefined {
  return details ? (details.exception?.description || details.text).split('\n')[0] : undefined;
}

function positionKey(location: {lineNumber: number, columnNumber?: number}): string {
  return `${location.lineNumber}:${location.columnNumber ?? 0}`;
}

function mouseButtonMask(button: Protocol.Input.MouseButton): number {
  switch (button) {
    case Protocol.Input.MouseButton.Left:
      return 1;
    case Protocol.Input.MouseButton.Right:
      return 2;
    case Protocol.Input.MouseButton.Middle:
      return 4;
    case Protocol.Input.MouseButton.Back:
      return 8;
    case Protocol.Input.MouseButton.Forward:
      return 16;
    default:
      return 0;
  }
}

function keyModifierMask(code: string): number {
  if (code.startsWith('Alt')) {
    return 1;
  }
  if (code.startsWith('Control')) {
    return 2;
  }
  if (code.startsWith('Meta')) {
    return 4;
  }
  if (code.startsWith('Shift')) {
    return 8;
  }
  return 0;
}
