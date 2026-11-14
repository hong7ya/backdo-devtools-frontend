// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/** 프로세스가 바뀌어도 비교할 수 있는 위치 정보다. scriptId나 런타임 객체 ID는 기록하지 않는다. */
export interface ExecutionPosition {
  readonly url: string;
  readonly hash: string;
  readonly lineNumber: number;
  readonly columnNumber: number;
}

export function samePosition(left: ExecutionPosition, right: ExecutionPosition): boolean {
  return left.url === right.url && left.hash === right.hash && left.lineNumber === right.lineNumber &&
      left.columnNumber === right.columnNumber;
}

function describe(position: ExecutionPosition): string {
  return `${position.url}:${position.lineNumber + 1}:${position.columnNumber + 1}`;
}

/** 목표 줄과 방문 횟수뿐 아니라, 처음부터 목표까지 모든 위치의 순서를 비교한다. */
export class ReplayPlan {
  readonly positions: readonly ExecutionPosition[];
  #nextIndex = 0;

  constructor(positions: readonly ExecutionPosition[]) {
    if (!positions.length) {
      throw new Error('No previous recorded position');
    }
    this.positions =
        Object.freeze(positions.map(position => Object.isFrozen(position) ? position : Object.freeze({...position})));
  }

  get target(): ExecutionPosition {
    return this.positions[this.positions.length - 1];
  }

  get complete(): boolean {
    return this.#nextIndex === this.positions.length;
  }

  accept(position: ExecutionPosition): boolean {
    const expected = this.positions[this.#nextIndex];
    if (!expected || !samePosition(expected, position)) {
      throw new Error(
          `Replay diverged at event ${this.#nextIndex + 1}: expected ${expected ? describe(expected) : 'end'}, ` +
          `received ${describe(position)} (source version included in comparison)`);
    }
    this.#nextIndex++;
    return this.complete;
  }
}

/** 실행 위치를 기록한다. Console 명령 완료는 같은 위치를 한 번 더 남기며 실제 입력은 제어 계층이 재생한다. */
export class ExecutionHistory {
  #positions: ExecutionPosition[] = [];
  #reverseTargets: number[] = [];

  get length(): number {
    return this.#positions.length;
  }

  get canReverse(): boolean {
    return this.#previousIndex !== undefined;
  }

  get #previousIndex(): number|undefined {
    const last = this.#reverseTargets.at(-1);
    return last === this.#positions.length - 1 ? this.#reverseTargets.at(-2) : last;
  }

  record(position: ExecutionPosition, reverseTarget = true): void {
    if (!position.url || !position.hash || !Number.isInteger(position.lineNumber) || position.lineNumber < 0 ||
        !Number.isInteger(position.columnNumber) || position.columnNumber < 0) {
      throw new Error('Cannot record an unstable or invalid source position');
    }
    this.#positions.push(Object.freeze({...position}));
    if (reverseTarget) {
      this.markCurrentAsReverseTarget();
    }
  }

  /** 같은 실행 위치에 별도 사용자 정지가 오면 중복 기록 없이 목적지로 남긴다. */
  markCurrentAsReverseTarget(): void {
    const index = this.#positions.length - 1;
    if (index >= 0 && this.#reverseTargets.at(-1) !== index) {
      this.#reverseTargets.push(index);
    }
  }

  clear(): void {
    this.#positions = [];
    this.#reverseTargets = [];
  }

  previous(): ReplayPlan {
    const index = this.#previousIndex;
    if (index === undefined) {
      throw new Error('No previous recorded position');
    }
    // 건너뛴 위치도 재실행 순서 검증에는 필요하므로 목표까지의 원본 경로를 유지한다.
    return new ReplayPlan(this.#positions.slice(0, index + 1));
  }

  commit(plan: ReplayPlan): void {
    if (!plan.complete) {
      throw new Error('Cannot commit an incomplete replay');
    }
    // 복원 후 Resume·Step을 실행하면 복원 지점부터 새로운 실행 이력을 기록한다.
    this.#positions = [...plan.positions];
    this.#reverseTargets = this.#reverseTargets.filter(index => index < this.#positions.length);
  }
}
