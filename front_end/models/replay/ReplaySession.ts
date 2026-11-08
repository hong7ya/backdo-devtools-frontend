// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {ExecutionHistory, type ExecutionPosition, type ReplayPlan} from './ExecutionHistory.js';

export type ExecutionCommand = 'resume'|'step-into'|'step-over'|'step-out'|'pause';

export interface RecordedPause {
  position: ExecutionPosition;
  depth: number;
  /** A user breakpoint, debugger statement, exception, or explicit Pause request. */
  userVisible: boolean;
}

/** Pure state machine. The adapter owns CDP, process lifetime and presentation. */
export class ReplaySession {
  readonly history = new ExecutionHistory();
  #plan: ReplayPlan|null = null;
  #mode: ExecutionCommand = 'step-into';
  #depth = 0;
  #lastDepth = 0;
  #paused = false;
  #error: string|null = null;

  get replaying(): boolean {
    return Boolean(this.#plan);
  }

  get error(): string|null {
    return this.#error;
  }

  get canReverse(): boolean {
    return this.#paused && !this.#error && !this.#plan && this.history.canReverse;
  }

  command(command: ExecutionCommand): void {
    if (this.#plan || this.#error) {
      throw new Error(this.#error || 'Replay is in progress');
    }
    this.#mode = command;
    this.#depth = this.#lastDepth;
    this.#paused = false;
  }

  beginReverse(): ExecutionPosition {
    if (!this.canReverse) {
      throw new Error('No previous recorded pause is available');
    }
    this.#plan = this.history.previous();
    this.#paused = false;
    return this.#plan.target;
  }

  /** Returns true only for pauses that the frontend should display. */
  accept(pause: RecordedPause): boolean {
    if (this.#error) {
      return true;
    }
    this.#lastDepth = pause.depth;
    if (this.#plan) {
      if (!this.#plan.accept(pause.position)) {
        return false;
      }
      this.history.commit(this.#plan);
      this.#plan = null;
      this.#paused = true;
      return true;
    }
    this.history.record(pause.position);
    this.#paused = pause.userVisible || this.#mode === 'pause' || this.#mode === 'step-into' ||
        (this.#mode === 'step-over' && pause.depth <= this.#depth) ||
        (this.#mode === 'step-out' && pause.depth < this.#depth);
    return this.#paused;
  }

  /** A pause outside the recorded entry script cannot be the origin of a reverse step. */
  unrecordedPause(): void {
    this.#paused = false;
  }

  fail(error: unknown): void {
    this.#error = error instanceof Error ? error.message : String(error);
    this.#plan = null;
    this.#paused = false;
  }
}
