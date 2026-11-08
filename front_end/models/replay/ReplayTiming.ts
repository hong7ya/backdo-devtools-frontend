// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// 재시작과 최종 화면 표시를 아직 측정하지 못한 첫 복원의 초기 예산이다.
// 로컬 실측의 고정 비용 약 0.5초보다 여유 있게 잡은 정책값이며 모든 환경의 보장은 아니다.
const INITIAL_OVERHEAD_MS = 1_000;
// 동일 기기에서도 처리 시간이 달라지므로 실행 구간에 25%의 여유를 둔다.
// 통계적 신뢰구간이 아닌 초기 정책이다. 실측 조건은 scripts/backdo/README.md를 참고한다.
const EXECUTION_MARGIN = 1.25;

/** 이미 진행하는 자동 기록의 시간을 재사용한다. 사용자 코드나 상태를 추가로 실행·저장하지 않는다. */
export class ReplayTiming {
  #activeSince: number|null = null;
  #activeMs = 0;
  #overheadMs = INITIAL_OVERHEAD_MS;
  #recordedMs: number|null = null;

  get estimatedMs(): number {
    return this.#overheadMs + (this.#recordedMs ?? this.#elapsedMs()) * EXECUTION_MARGIN;
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
    if (this.#activeSince === null && this.#recordedMs === null) {
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
    this.#overheadMs = Math.max(this.#overheadMs, totalMs - this.#activeMs);
    this.#recordedMs = null;
    // 현재 activeMs는 복원한 경로의 실측이다. 버린 미래 경로의 실행 시간도 함께 버린다.
  }

  #elapsedMs(): number {
    return this.#activeMs + (this.#activeSince === null ? 0 : performance.now() - this.#activeSince);
  }
}
