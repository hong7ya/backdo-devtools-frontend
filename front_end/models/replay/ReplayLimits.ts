// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// 3초는 사용자가 정한 대기 기준이다. 더미 CDP 왕복 × 기록 개수에 적용하는 사전 제한이며,
// 사용자 코드 실행·재시작·화면 비용을 포함한 실제 복원 완료 시간의 보장값은 아니다.
export const REPLAY_RESPONSE_BUDGET_MS = 3_000;

export const REPLAY_TIME_LIMIT_MESSAGE =
    '예상 CDP 처리 시간이 3초에 도달해 빠른 뒤로가기를 위한 기록을 종료했습니다. 디버깅 세션을 다시 시작하고, ' +
    '입력 데이터나 반복 횟수를 줄여 원하는 위치까지 이동해 주세요.';

/**
 * 추가 기록의 상한이다. 브라우저 전체 힙의 바이트 수를 보장하는 값은 아니다.
 * 브라우저 공통 권장 용량은 없으며, 실제 지원 기기에서 측정해 조정해야 한다.
 * 근거: https://developer.chrome.com/docs/devtools/memory-problems#memory_bloat_how_much_is_too_much
 */
export const REPLAY_LIMITS = Object.freeze({
  // Chrome 156·macOS arm64에서 10만 위치의 배열은 약 3.11MiB, 복원 계획 포함 약 3.49MiB였다.
  // 이 값은 최후의 메모리 보호 상한이다. 실제 기록은 기기별 예상 CDP 처리 시간 3초에서도 종료한다.
  // 측정 조건과 제외 비용: scripts/backdo/README.md의 "측정 결과".
  positions: 100_000,
  // 정지 위치가 없는 준비 코드도 누적되므로 입력 개수를 별도로 제한한다.
  // 256개는 초기 정책값이며, 사용자 입력량의 실측에서 도출한 수치는 아니다.
  consoleInputs: 256,
  // 재실행에 필요한 원문을 무제한 붙잡지 않도록 정한 4MiB의 초기 예산이다.
  // 문자열.length × 2로 계산한다. 엔진의 실제 문자열 힙 사용량과 동일하지 않다.
  consoleBytes: 4 * 1024 * 1024,
  // 방문 횟수와 별개로 최초 설치·해제에 필요한 CDP 요청 수를 제한한다.
  // 2만 개는 초기 보호 정책이다. 2만 개의 서로 다른 지점 설치 성능은 아직 미검증이다.
  breakpoints: 20_000,
  // 소스 식별 요청과 결과 맵도 위치 기록 없이 증가할 수 있어 별도로 제한한다.
  // 콘솔 입력 상한과 같은 규모로 정한 초기 정책이며, 실제 최대 처리량을 의미하지 않는다.
  pendingSources: 256,
});

export const RECORDING_LIMIT_MESSAGE =
    '실행 기록 한도에 도달해 뒤로가기를 사용할 수 없습니다. 뒤로가기가 필요하면 디버깅 세션을 다시 시작하고, ' +
    '가능하면 실행 범위를 줄여 원하는 위치까지 이동해 주세요.';

export type RecordingUsage = Record<keyof typeof REPLAY_LIMITS, number>;
