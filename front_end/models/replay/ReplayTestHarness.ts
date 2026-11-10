// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import type {BrowserTestClient, ReplaySnapshot} from '../../../scripts/backdo/tests/BrowserTestProtocol.js';
import * as Common from '../../core/common/common.js';
import * as SDK from '../../core/sdk/sdk.js';
import * as Sources from '../../panels/sources/sources.js';
import * as TextEditor from '../../ui/components/text_editor/text_editor.js';

import {ReplayController} from './ReplayController.js';

/** 브라우저 안에서만 사용하는 통합 테스트 도우미. Node 테스트에는 직렬화 가능한 결과만 전달한다. */
class ReplayTestHarness implements BrowserTestClient {
  readonly #controller = ReplayController.instance();
  #pauseCount = 0;

  constructor() {
    this.#observeVisiblePauses();
  }

  ready(): boolean {
    return Boolean(this.#debuggerModel()?.target().model(SDK.RuntimeModel.RuntimeModel)?.defaultExecutionContext());
  }

  calibrationFinished(): boolean {
    return !this.#controller.calibrating && !this.#controller.busy &&
        !Sources.SourcesPanel.SourcesPanel.instance().element.inert &&
        (this.#controller.calibrated || Boolean(this.#controller.session.error));
  }

  isPaused(): boolean {
    return this.#debuggerModel()?.isPaused() ?? false;
  }

  pauseReason(): string|null {
    return this.#debuggerModel()?.debuggerPausedDetails()?.reason ?? null;
  }

  sourceIsVisible(source: string): boolean {
    const editor = Sources.SourcesPanel.SourcesPanel.instance().sourcesViewInternal.currentSourceFrame()?.textEditor;
    return Boolean(editor?.state.doc.toString().includes(source.trim()));
  }

  snapshot(): ReplaySnapshot {
    const frame = Sources.SourcesPanel.SourcesPanel.instance().sourcesViewInternal.currentSourceFrame();
    return {
      error: this.#controller.session.error,
      source: frame ? {url: frame.uiSourceCode().url(), text: frame.textEditor.state.doc.toString()} : null,
      highlight: this.#highlightedPosition(),
      messages: Common.Console.Console.instance()
                    .messages()
                    .map(message => message.text)
                    .filter(text => text.startsWith('BackDo:')),
      pauseCount: this.#pauseCount,
    };
  }

  #debuggerModel(): SDK.DebuggerModel.DebuggerModel|null {
    return SDK.TargetManager.TargetManager.instance().primaryPageTarget()?.model(SDK.DebuggerModel.DebuggerModel) ??
        null;
  }

  #highlightedPosition(): number[]|null {
    const editor = Sources.SourcesPanel.SourcesPanel.instance().sourcesViewInternal.currentSourceFrame()?.textEditor;
    const marker = editor?.shadowRoot?.querySelector('.cm-executionLine');
    if (!editor || !marker) {
      return null;
    }
    const offset = TextEditor.ExecutionPositionHighlighter.getHighlightedPosition(editor.state);
    if (offset === null) {
      return null;
    }
    const line = editor.state.doc.lineAt(offset);
    return [line.number - 1, offset - line.from];
  }

  #observeVisiblePauses(): void {
    SDK.TargetManager.TargetManager.instance().addModelListener(
        SDK.DebuggerModel.DebuggerModel, SDK.DebuggerModel.Events.DebuggerPaused, () => {
          // 같은 행에 다시 멈출 때도 새 정지를 기다리기 위한 이벤트 번호다. 실행 기록 개수가 아니다.
          this.#pauseCount++;
        });
  }
}

window.backdoTest = new ReplayTestHarness();
