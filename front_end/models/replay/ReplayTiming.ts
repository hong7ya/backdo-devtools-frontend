// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/** 최초 위치 복원으로 준비 비용을 측정하고, 이후 실제 실행·복원 시간을 재사용한다. */
export class ReplayTiming {
  #activeSince: number|null = null;
  #activeMs = 0;
  #overheadMs: number|null = null;
  #recordedMs: number|null = null;

  get calibrated(): boolean {
    return this.#overheadMs !== null;
  }

  get estimatedMs(): number|null {
    if (this.#overheadMs === null) {
      return null;
    }
    return this.#overheadMs + (this.#recordedMs ?? this.#elapsedMs());
  }

  startExecution(): void {
    // 같은 재개 요청에 중복 호출되어도 구간의 시작점을 바꾸지 않는다.
    this.#activeSince ??= performance.now();
  }

  pauseExecution(): void {
    this.#activeMs = this.#elapsedMs();
    this.#activeSince = null;
  }

  cancelPendingExecution(): void {
    // 콘솔 입력 사이의 대기는 다음 입력의 재실행 비용으로 옮기지 않는다. 완료된 구간은 유지한다.
    this.#activeSince = null;
  }

  recordSetup(elapsedMs: number): void {
    // 실행 중 설치한 지점은 실행 시간에 이미 포함된다. 사용자 정지 중 준비한 비용만 더한다.
    // 최초 준비는 측정용 복원에 포함된다. 측정 이후 새 소스가 추가된 경우만 더한다.
    if (this.#overheadMs !== null && this.#activeSince === null && this.#recordedMs === null) {
      this.#overheadMs += elapsedMs;
    }
  }

  beginReplay(): void {
    this.pauseExecution();
    this.#recordedMs = this.#activeMs;
    this.#activeMs = 0;
  }

  finishReplay(totalMs: number): void {
    if (this.#recordedMs === null) {
      return;
    }
    this.pauseExecution();
    // 클릭부터 최종 화면 표시까지의 실측에서 실행 구간을 빼면 재시작·연결·표시 비용이 남는다.
    // 고정 비용은 관측한 최대값을 유지한다. 다음 세션에서 새로 측정한다.
    const observedOverheadMs = Math.max(0, totalMs - this.#activeMs);
    this.#overheadMs = this.#overheadMs === null ? observedOverheadMs : Math.max(this.#overheadMs, observedOverheadMs);
    this.#recordedMs = null;
    // 현재 activeMs는 복원한 경로의 실측이다. 버린 미래 경로의 실행 시간도 함께 버린다.
  }

  #elapsedMs(): number {
    return this.#activeMs + (this.#activeSince === null ? 0 : performance.now() - this.#activeSince);
  }
}
