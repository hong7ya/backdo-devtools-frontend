// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import type {BrowserTestClient, HistorySnapshot, ReplaySnapshot} from '../../../scripts/backdo/tests/BrowserTestProtocol.js';
import * as Common from '../../core/common/common.js';
import * as SDK from '../../core/sdk/sdk.js';
import * as Sources from '../../panels/sources/sources.js';

import {ReplayConnection} from './ReplayConnection.js';
import {ReplayController} from './ReplayController.js';

/** 브라우저 안에서만 사용하는 통합 테스트 도우미. Node 테스트에는 직렬화 가능한 결과만 전달한다. */
class ReplayTestHarness implements BrowserTestClient {
  readonly #controller = ReplayController.instance();
  readonly #originalDocument = document;
  readonly #originalTimeOrigin = performance.timeOrigin;
  readonly #originalHistoryLength = history.length;
  readonly #visiblePauses: number[][] = [];
  readonly #transitions: string[] = [];

  constructor() {
    history.replaceState({backdoTest: 'preserve'}, '');
    this.#observeVisiblePauses();
    this.#observeTransitions();
  }

  useTestLifecycle(): void {
    ReplayConnection.instance().setLifecycle({
      discover: (port, kind) => window.discoverBackDoTestTarget(port, kind),
      restart: target => window.restartBackDoTestTarget(target),
    });
  }

  ready(): boolean {
    return Boolean(this.#debuggerModel()?.target().model(SDK.RuntimeModel.RuntimeModel)?.defaultExecutionContext());
  }

  historyLength(): number {
    return this.#controller.session.history.length;
  }

  isPaused(): boolean {
    return this.#debuggerModel()?.isPaused() ?? false;
  }

  isPausedAtLine(lineNumber: number): boolean {
    return this.#debuggerModel()?.debuggerPausedDetails()?.callFrames[0]?.location().lineNumber === lineNumber;
  }

  previous(): HistorySnapshot {
    const history = this.#controller.session.history;
    return {target: history.previous().target, length: history.length};
  }

  replayFinished(previousLength: number): boolean {
    const reachedTarget = this.#controller.session.history.length === previousLength - 1;
    const failed = Boolean(this.#controller.session.error);
    return !this.#controller.busy && !document.body.inert && (reachedTarget || failed);
  }

  snapshot(): ReplaySnapshot {
    const position = this.#controller.currentPosition;
    return {
      error: this.#controller.session.error,
      position,
      highlight: this.#highlightedPosition(),
      messages: Common.Console.Console.instance().messages().map(message => message.text).filter(
          text => text.startsWith('BackDo:')),
      sameDocument: this.#originalDocument === document,
      sameTimeOrigin: this.#originalTimeOrigin === performance.timeOrigin,
      sameHistoryLength: this.#originalHistoryLength === history.length,
      historyState: history.state,
      ws: new URL(location.href).searchParams.get('ws'),
      visiblePauses: this.#visiblePauses,
      transitions: this.#transitions,
    };
  }

  #debuggerModel(): SDK.DebuggerModel.DebuggerModel|null {
    return SDK.TargetManager.TargetManager.instance().primaryPageTarget()?.model(SDK.DebuggerModel.DebuggerModel) ?? null;
  }

  #highlightedPosition(): number[]|null {
    const editor = Sources.SourcesPanel.SourcesPanel.instance().sourcesViewInternal.currentSourceFrame()?.textEditor;
    const token = editor?.shadowRoot?.querySelector('.cm-executionToken');
    if (!editor || !token) {
      return null;
    }
    const offset = editor.editor.posAtDOM(token, 0);
    const line = editor.state.doc.lineAt(offset);
    return [line.number - 1, offset - line.from];
  }

  #observeVisiblePauses(): void {
    SDK.TargetManager.TargetManager.instance().addModelListener(
        SDK.DebuggerModel.DebuggerModel, SDK.DebuggerModel.Events.DebuggerPaused, event => {
          const position = event.data.debuggerPausedDetails()?.callFrames[0]?.location();
          if (position) {
            this.#visiblePauses.push([position.lineNumber, position.columnNumber]);
          }
        });
  }

  #observeTransitions(): void {
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = (...args: Parameters<Document['startViewTransition']>) => {
      const transition = start(...args);
      void transition.ready.then(
          () => this.#transitions.push('ready'), () => this.#transitions.push('skipped'));
      return transition;
    };
  }
}

window.backdoTest = new ReplayTestHarness();
