// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/** 더미의 CDP 왕복 비용과 방문 기록 개수만 사용한다. 사용자 코드는 시간 측정에 참여하지 않는다. */
export class ReplayTiming {
  #roundTripMs: number|null = null;

  get calibrated(): boolean {
    return this.#roundTripMs !== null;
  }

  calibrate(roundTripMs: number): void {
    // 시계 해상도 때문에 0이 나오더라도 임의의 시간으로 대체하지 않는다.
    if (!Number.isFinite(roundTripMs) || roundTripMs <= 0) {
      throw new Error('CDP 왕복 시간을 측정하지 못했습니다. 새 세션에서 다시 시도해 주세요.');
    }
    this.#roundTripMs = roundTripMs;
  }

  estimate(positionCount: number): number|null {
    return this.#roundTripMs === null ? null : this.#roundTripMs * positionCount;
  }
}
