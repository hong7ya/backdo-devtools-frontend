// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// 기록량은 CDP 요청·응답 시간 × 방문 기록 수로 환산하며, 3초만을 기록 예산으로 사용한다.
// 사용자 코드 실행·재시작·화면 비용을 포함한 실제 복원 완료 시간의 보장값은 아니다.
export const REPLAY_RESPONSE_BUDGET_MS = 3_000;

export const REPLAY_TIME_LIMIT_MESSAGE =
    '예상 CDP 처리 시간이 3초에 도달해 빠른 뒤로가기를 위한 기록을 종료했습니다. 디버깅 세션을 다시 시작하고, ' +
    '입력 데이터나 반복 횟수를 줄여 원하는 위치까지 이동해 주세요.';
