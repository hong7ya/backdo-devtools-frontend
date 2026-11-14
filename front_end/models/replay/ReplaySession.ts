// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {
  type ExecutionCommand,
  type ExecutionDispatch,
  ExecutionHistory,
  type ExecutionPosition,
  type RecordedCommand,
  type ReplayPlan,
} from './ExecutionHistory.js';

export type PauseDisposition = 'show'|'continue';

export type {ExecutionCommand} from './ExecutionHistory.js';

export interface RecordedPause {
  position: ExecutionPosition;
  depth: number;
  /** 사용자 브레이크포인트, debugger 문, 예외 등 화면에 표시해야 하는 정지 여부. */
  userVisible: boolean;
  reason?: string;
}

/** 기록과 재실행의 상태만 관리한다. CDP 연결, 프로세스 수명, 화면은 제어 계층이 담당한다. */
export class ReplaySession {
  readonly history = new ExecutionHistory();
  #replayPlan: ReplayPlan|null = null;
  #commands: RecordedCommand[] = [];
  #commandCursor = 0;
  #currentCommand: RecordedCommand|null = null;
  #dispatch: ExecutionDispatch|null = null;
  #auxiliaryPause = false;
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

  get atRecordedPause(): boolean {
    return this.#isAtRecordedPause;
  }

  get commands(): readonly RecordedCommand[] {
    return this.#commands;
  }

  get currentCommand(): RecordedCommand|null {
    return this.#currentCommand;
  }

  beginExecution(command: ExecutionCommand): RecordedCommand {
    if (this.#replayPlan || this.#failureReason) {
      throw new Error(this.#failureReason || 'Replay is in progress');
    }
    this.#currentCommand = Object.freeze({
      sequence: this.#commands.length,
      afterPosition: this.history.length,
      command,
      depth: this.#currentDepth,
      fromAuxiliaryPause: this.#auxiliaryPause,
    });
    this.#commands.push(this.#currentCommand);
    this.#isAtRecordedPause = false;
    return this.#currentCommand;
  }

  /** 사용자 의도는 그대로 두고, 그 명령을 진행시키기 위해 실제로 보낸 실행을 연결한다. */
  recordDispatch(command: ExecutionCommand, origin: ExecutionDispatch['origin']): void {
    this.#dispatch = Object.freeze({
      command,
      origin,
      afterPosition: this.#replayPlan?.acceptedPositions ?? this.history.length,
      userCommand: this.#currentCommand,
    });
  }

  /** Resume도 Step과 같은 명시적 명령이다. 같은 경계의 명령은 발행 순서대로 한 번씩 소비한다. */
  takeReplayCommand(afterPosition: number): RecordedCommand|null {
    const command = this.#commands[this.#commandCursor];
    if (!this.#replayPlan || !command || command.afterPosition > afterPosition) {
      return null;
    }
    if (command.afterPosition < afterPosition) {
      throw new Error('재실행 중 사용자 명령의 실행 경계를 지나쳤습니다.');
    }
    this.#commandCursor++;
    this.#currentCommand = command;
    return command;
  }

  beginReverse(): ExecutionPosition {
    if (!this.canReverse) {
      throw new Error('No previous recorded pause is available');
    }
    this.#replayPlan = this.history.previous();
    this.#commandCursor = 0;
    this.#currentCommand = null;
    this.#dispatch = null;
    this.#auxiliaryPause = false;
    this.#isAtRecordedPause = false;
    return this.#replayPlan.target;
  }

  /** 위치를 기록하거나 재실행 경로와 대조한 뒤, 이 정지를 화면에 보여 줄지 반환한다. */
  recordPause(pause: RecordedPause): PauseDisposition {
    if (this.#failureReason) {
      return 'show';
    }
    this.#currentDepth = pause.depth;
    this.#auxiliaryPause = false;
    if (this.#replayPlan) {
      const index = this.#replayPlan.acceptedPositions;
      const expectedCommand = this.#replayPlan.records[index]?.context?.userCommand;
      const complete = this.#replayPlan.accept(pause.position);
      // 첫 위치를 만든 Pause와 복원 중 생략한 예외 정지의 Resume는 다시 보내지 않는다.
      // 연결된 위치가 일치한 경우에만 소비한다. Step은 실제 CDP 실행이 필요하다.
      while (expectedCommand && this.#commandCursor <= expectedCommand.sequence) {
        const command = this.#commands[this.#commandCursor];
        const initialPause = index === 0 && command.command === 'pause';
        const auxiliaryResume = command.command === 'resume' && command.fromAuxiliaryPause;
        if (command.afterPosition !== index || (!initialPause && !auxiliaryResume)) {
          break;
        }
        this.#currentCommand = command;
        this.#commandCursor++;
      }
      if (!complete) {
        return 'continue';
      }
      this.history.commit(this.#replayPlan);
      this.#replayPlan = null;
      this.#commands = this.#commands.filter(command => command.afterPosition < this.history.length);
      this.#currentCommand = this.history.records.at(-1)?.context?.userCommand ?? null;
      this.#dispatch = null;
      this.#isAtRecordedPause = true;
      return 'show';
    }
    this.#isAtRecordedPause = this.#shouldShowPause(pause);
    // Resume는 모든 기록 위치를, Step Out은 빠져나오는 함수의 실행 위치를 되짚는다.
    // Step Over가 건너뛴 함수 내부는 재실행 검증 경로에만 남긴다.
    const command = this.#currentCommand;
    const reverseTarget = this.#isAtRecordedPause || !command || command.command === 'resume' ||
        (command?.command === 'step-out' && pause.depth <= command.depth);
    this.history.record(pause.position, reverseTarget, {
      depth: pause.depth,
      reason: pause.reason ?? 'other',
      userVisible: pause.userVisible,
      shown: this.#isAtRecordedPause,
      userCommand: command,
      dispatch: this.#dispatch,
    });
    return this.#isAtRecordedPause ? 'show' : 'continue';
  }

  /** Console 명령 완료도 같은 실행 위치의 다음 상태다. 호출 깊이는 바뀌지 않는다. */
  recordConsoleInput(position: ExecutionPosition): void {
    this.#dispatch = null;
    this.recordPause({position, depth: this.#currentDepth, userVisible: true, reason: 'console-input'});
  }

  /** 같은 위치의 추가 사용자 정지는 표시하되 실행 위치를 중복 기록하지 않는다. */
  showUserPause(depth: number, atRecordedPosition: boolean): void {
    this.#auxiliaryPause = true;
    this.#currentDepth = depth;
    this.#isAtRecordedPause = atRecordedPosition;
    if (atRecordedPosition) {
      this.history.markCurrentAsReverseTarget();
    }
  }

  /** 기록 대상 파일 밖의 정지에서는 직전 기록을 현재 위치로 간주하지 않는다. */
  unrecordedPause(depth = this.#currentDepth): void {
    this.#auxiliaryPause = true;
    this.#isAtRecordedPause = false;
    this.#currentDepth = depth;
  }

  reset(): void {
    this.history.clear();
    this.#replayPlan = null;
    this.#failureReason = null;
    this.#isAtRecordedPause = false;
    this.#commands = [];
    this.#commandCursor = 0;
    this.#currentCommand = null;
    this.#dispatch = null;
    this.#auxiliaryPause = false;
    this.#currentDepth = 0;
  }

  fail(error: unknown): void {
    this.history.clear();
    this.#commands = [];
    this.#commandCursor = 0;
    this.#currentCommand = null;
    this.#dispatch = null;
    this.#auxiliaryPause = false;
    this.#failureReason = error instanceof Error ? error.message : String(error);
    this.#replayPlan = null;
    this.#isAtRecordedPause = false;
  }

  #shouldShowPause(pause: RecordedPause): boolean {
    if (pause.userVisible) {
      return true;
    }
    // 페이지 로드나 Console 실행은 사용자 Step 명령이 없어도 자연스럽게 진행한다.
    switch (this.#currentCommand?.command ?? 'resume') {
      case 'pause':
      case 'step-into':
        return true;
      case 'step-over':
        return pause.depth <= (this.#currentCommand?.depth ?? 0);
      case 'step-out':
        return pause.depth < (this.#currentCommand?.depth ?? 0);
      case 'resume':
        return false;
    }
  }
}
