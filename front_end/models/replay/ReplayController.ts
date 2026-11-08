// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as Common from '../../core/common/common.js';
import * as SDK from '../../core/sdk/sdk.js';
import * as Protocol from '../../generated/protocol.js';

import {type ExecutionCommand, ReplaySession} from './ReplaySession.js';

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

/** Entry-script recording for a Node process owned by scripts/backdo/debug.mjs. */
export class ReplayController extends Common.ObjectWrapper.ObjectWrapper<EventTypes> {
  static #instance: ReplayController;
  readonly session = new ReplaySession();
  #token = '';
  #entryURL = '';
  #model: SDK.DebuggerModel.DebuggerModel|null = null;
  #connect: ((ws: string) => Promise<void>)|null = null;
  #breakpoints = new Set<string>();
  #locations = new Set<string>();
  #debuggerStatements = new Set<string>();
  #initialized = false;
  #busy = false;
  #complete: (() => void)|null = null;
  #reject: ((error: Error) => void)|null = null;

  static instance(): ReplayController {
    this.#instance ??= new ReplayController();
    return this.#instance;
  }

  get busy(): boolean {
    return this.#busy;
  }

  canReverse(model: SDK.DebuggerModel.DebuggerModel|null): boolean {
    return model === this.#model && Boolean(model?.isPaused()) && !this.#busy && this.session.canReverse;
  }

  get status(): string {
    if (this.session.error) {
      return `BackDo unavailable: ${this.session.error}`;
    }
    if (!this.#token) {
      return 'Start a managed Node session with scripts/backdo/debug.mjs to use BackDo';
    }
    if (this.#busy) {
      return 'Replaying the process to the previous recorded position…';
    }
    return this.session.canReverse ? 'Go to the previous recorded position (restarts and re-executes the process)' :
                                     'No previous recorded position in the entry script';
  }

  async configure(token: string, connect: (ws: string) => Promise<void>): Promise<ManagedTarget> {
    this.#token = token;
    this.#connect = connect;
    const target = await this.#request('session');
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
    this.#model = model;
    this.#breakpoints = new Set();
    this.#locations = new Set();
    this.#debuggerStatements = new Set();
    this.#initialized = false;
    model.setPauseInterceptor(details => this.#paused(details));
    model.setExecutionInterceptor(command => this.#command(command));
    model.addEventListener(SDK.DebuggerModel.Events.ScriptSourceWasEdited, () => {
      this.fail(new Error('The source was edited; start a new session'));
    });
    model.addEventListener(SDK.DebuggerModel.Events.DebuggerPaused, () => {
      // Resolve after the normal SDK event, so the final call frame reaches Sources.
      if (this.#busy && !this.session.replaying && !this.session.error) {
        queueMicrotask(() => this.#complete?.());
      }
      this.#changed();
    });
    model.addEventListener(SDK.DebuggerModel.Events.DebuggerResumed, () => this.#changed());
    if (!Common.Settings.Settings.instance().moduleSetting('breakpoints-active').get()) {
      this.fail(new Error('Enable breakpoints and start a new managed session'));
    }
    this.#changed();
  }

  async #request(operation: 'session'|'restart'): Promise<ManagedTarget> {
    const response = await fetch(`/__backdo/${operation}`, {
      method: operation === 'restart' ? 'POST' : 'GET',
      headers: {'X-BackDo-Session': this.#token},
      signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || `BackDo session request failed (${response.status})`);
    }
    const ws = new URL(result.ws);
    if (ws.protocol !== 'ws:' || ws.hostname !== '127.0.0.1' || typeof result.entryURL !== 'string') {
      throw new Error('Invalid local target connection');
    }
    return result as ManagedTarget;
  }

  async #install(script: SDK.Script.Script): Promise<void> {
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
        this.#debuggerStatements.add(key);
      }
      if (this.#locations.has(key)) {
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
      this.#breakpoints.add(breakpoint.breakpointId);
      this.#locations.add(key);
    }
    this.#initialized = true;
  }

  async #paused(details: SDK.DebuggerModel.DebuggerPausedDetails): Promise<boolean> {
    if (this.session.error) {
      return false;
    }
    try {
      const frame = details.callFrames[0];
      if (!frame || frame.script.sourceURL !== this.#entryURL) {
        if (this.#busy) {
          await this.#resume();
          return true;
        }
        this.session.unrecordedPause();
        this.#changed();
        return false;
      }
      const initial = !this.#initialized;
      if (initial) {
        await this.#install(frame.script);
      }
      const {lineNumber, columnNumber} = frame.location();
      const key = `${lineNumber}:${columnNumber}`;
      if (!this.#locations.has(key)) {
        throw new Error('This pause is not a reproducible breakpoint position; start a new session');
      }
      const userVisible = initial || this.#debuggerStatements.has(key) ||
          details.breakpointIds.some(id => !this.#breakpoints.has(id)) ||
          details.reason === Protocol.Debugger.PausedEventReason.Exception ||
          details.reason === Protocol.Debugger.PausedEventReason.PromiseRejection;
      const publish = this.session.accept({
        position: {url: frame.script.sourceURL, hash: frame.script.hash, lineNumber, columnNumber},
        depth: details.callFrames.length,
        userVisible,
      });
      if (!publish) {
        await this.#resume();
        return true;
      }
      this.#changed();
      return false;
    } catch (error) {
      this.fail(error);
      return false;
    }
  }

  #command(command: SDK.DebuggerModel.ExecutionCommand): boolean {
    if (this.#busy) {
      return true;
    }
    if (this.session.error) {
      return false;
    }
    if (command === 'skip-pauses') {
      this.fail(new Error('Skipping pauses interrupts recording; start a new session'));
      return false;
    }
    this.session.command(command as ExecutionCommand);
    this.#changed();
    if (command === 'pause') {
      void this.#model?.agent.invoke_pause();
    } else {
      void this.#resume().catch(error => this.fail(error));
    }
    return true;
  }

  async #resume(): Promise<void> {
    const response = await this.#model?.agent.invoke_resume({terminateOnResume: false});
    if (response?.getError()) {
      throw new Error(response.getError());
    }
  }

  async reverse(): Promise<void> {
    if (!this.canReverse(this.#model) || !this.#connect) {
      throw new Error(this.status);
    }
    this.session.beginReverse();
    this.#busy = true;
    this.#changed();
    let timer: ReturnType<typeof setTimeout>|undefined;
    const completed = new Promise<void>((resolve, reject) => {
      this.#complete = resolve;
      this.#reject = reject;
      timer = setTimeout(() => this.fail(new Error('Replay timed out before reaching the recorded position')), 30_000);
    });
    // Attach a handler immediately, including while the process request is pending.
    void completed.catch(() => {});
    try {
      await this.#model?.target().router()?.connection().disconnect();
      const target = await this.#request('restart');
      if (this.session.error) {
        throw new Error(this.session.error);
      }
      if (target.entryURL !== this.#entryURL) {
        throw new Error('The managed entry script changed');
      }
      await this.#connect(target.ws);
      await completed;
    } catch (error) {
      this.fail(error);
      throw error;
    } finally {
      clearTimeout(timer);
      this.#complete = null;
      this.#reject = null;
      this.#busy = false;
      this.#changed();
    }
  }

  fail(error: unknown): void {
    if (this.session.error) {
      return;
    }
    this.session.fail(error);
    this.#reject?.(new Error(this.session.error ?? 'Replay failed'));
    this.#model?.setExecutionInterceptor(null);
    this.#model?.setPauseInterceptor(null);
    for (const breakpointId of this.#breakpoints) {
      void this.#model?.agent.invoke_removeBreakpoint({breakpointId: breakpointId as Protocol.Debugger.BreakpointId});
    }
    this.#breakpoints.clear();
    Common.Console.Console.instance().error(`BackDo: ${this.session.error}`);
    if (this.#busy) {
      void this.#model?.agent.invoke_pause();
    }
    this.#changed();
  }

  #changed(): void {
    this.dispatchEventToListeners(Events.CHANGED);
  }
}
