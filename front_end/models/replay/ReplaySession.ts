// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {ExecutionHistory, type ExecutionPosition, type ReplayPlan} from './ExecutionHistory.js';

export type PauseDisposition = 'show'|'continue';

export type ExecutionCommand = 'resume'|'step-into'|'step-over'|'step-out'|'pause';

export interface RecordedPause {
  position: ExecutionPosition;
  depth: number;
  /** 사용자 브레이크포인트, debugger 문, 예외 등 화면에 표시해야 하는 정지 여부. */
  userVisible: boolean;
}

/** 기록과 재실행의 상태만 관리한다. CDP 연결, 프로세스 수명, 화면은 제어 계층이 담당한다. */
export class ReplaySession {
  readonly history = new ExecutionHistory();
  #replayPlan: ReplayPlan|null = null;
  #executionCommand: ExecutionCommand = 'step-into';
  #stepStartDepth = 0;
  #currentDepth = 0;
  #isAtRecordedPause = false;
  #failureReason: string|null = null;

  get replaying(): boolean {
    return Boolean(this.#replayPlan);
  }

  get error(): string|null {
    return this.#failureReason;
  }

  get canReverse(): boolean {
    return this.#isAtRecordedPause && !this.#failureReason && !this.#replayPlan && this.history.canReverse;
  }

  beginExecution(command: ExecutionCommand): void {
    if (this.#replayPlan || this.#failureReason) {
      throw new Error(this.#failureReason || 'Replay is in progress');
    }
    this.#executionCommand = command;
    this.#stepStartDepth = this.#currentDepth;
    this.#isAtRecordedPause = false;
  }

  beginReverse(): ExecutionPosition {
    if (!this.canReverse) {
      throw new Error('No previous recorded pause is available');
    }
    this.#replayPlan = this.history.previous();
    this.#isAtRecordedPause = false;
    return this.#replayPlan.target;
  }

  /** 위치를 기록하거나 재실행 경로와 대조한 뒤, 이 정지를 화면에 보여 줄지 반환한다. */
  recordPause(pause: RecordedPause): PauseDisposition {
    if (this.#failureReason) {
      return 'show';
    }
    this.#currentDepth = pause.depth;
    if (this.#replayPlan) {
      if (!this.#replayPlan.accept(pause.position)) {
        return 'continue';
      }
      this.history.commit(this.#replayPlan);
      this.#replayPlan = null;
      this.#isAtRecordedPause = true;
      return 'show';
    }
    this.history.record(pause.position);
    this.#isAtRecordedPause = this.#shouldShowPause(pause);
    return this.#isAtRecordedPause ? 'show' : 'continue';
  }

  /** 기록 대상 파일 밖의 정지에서는 직전 기록을 현재 위치로 간주하지 않는다. */
  unrecordedPause(): void {
    this.#isAtRecordedPause = false;
  }

  reset(): void {
    this.history.clear();
    this.#replayPlan = null;
    this.#failureReason = null;
    this.#isAtRecordedPause = false;
    this.#executionCommand = 'step-into';
    this.#stepStartDepth = 0;
    this.#currentDepth = 0;
  }

  fail(error: unknown): void {
    this.history.clear();
    this.#failureReason = error instanceof Error ? error.message : String(error);
    this.#replayPlan = null;
    this.#isAtRecordedPause = false;
  }

  #shouldShowPause(pause: RecordedPause): boolean {
    if (pause.userVisible) {
      return true;
    }
    switch (this.#executionCommand) {
      case 'pause':
      case 'step-into':
        return true;
      case 'step-over':
        return pause.depth <= this.#stepStartDepth;
      case 'step-out':
        return pause.depth < this.#stepStartDepth;
      case 'resume':
        return false;
    }
  }
}
