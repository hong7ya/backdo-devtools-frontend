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
    this.positions = Object.freeze(
        positions.map(position => Object.isFrozen(position) ? position : Object.freeze({...position})));
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

/** 실행 위치만 기록한다. 지역 변수, 힙, 클로저, 반환값, 외부 입력은 저장하지 않는다. */
export class ExecutionHistory {
  #positions: ExecutionPosition[] = [];

  get length(): number {
    return this.#positions.length;
  }

  get canReverse(): boolean {
    return this.#positions.length > 1;
  }

  record(position: ExecutionPosition): void {
    if (!position.url || !position.hash || !Number.isInteger(position.lineNumber) || position.lineNumber < 0 ||
        !Number.isInteger(position.columnNumber) || position.columnNumber < 0) {
      throw new Error('Cannot record an unstable or invalid source position');
    }
    this.#positions.push(Object.freeze({...position}));
  }

  clear(): void {
    this.#positions = [];
  }

  previous(): ReplayPlan {
    if (!this.canReverse) {
      throw new Error('No previous recorded position');
    }
    return new ReplayPlan(this.#positions.slice(0, -1));
  }

  commit(plan: ReplayPlan): void {
    if (!plan.complete) {
      throw new Error('Cannot commit an incomplete replay');
    }
    // 복원 후 Resume·Step을 실행하면 복원 지점부터 새로운 실행 이력을 기록한다.
    this.#positions = [...plan.positions];
  }
}
