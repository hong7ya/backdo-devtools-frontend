// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/** Stable across processes; scriptId and runtime object IDs deliberately are not recorded. */
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

/** Compares every event, not just the final line or its visit count. */
export class ReplayPlan {
  readonly positions: readonly ExecutionPosition[];
  #nextIndex = 0;

  constructor(positions: readonly ExecutionPosition[]) {
    if (!positions.length) {
      throw new Error('No previous recorded position');
    }
    this.positions = Object.freeze(positions.map(position => Object.freeze({...position})));
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

/** Execution locations only: no locals, heap, closures, return values, or external inputs. */
export class ExecutionHistory {
  #positions: ExecutionPosition[] = [];
  readonly #limit: number;

  constructor(limit = 1_000_000) {
    this.#limit = limit;
  }

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
    if (this.#positions.length >= this.#limit) {
      throw new Error('Execution history limit reached; start a new debug session');
    }
    this.#positions.push(Object.freeze({...position}));
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
    // A subsequent Resume/Step records a new future from the restored position.
    this.#positions = [...plan.positions];
  }
}
