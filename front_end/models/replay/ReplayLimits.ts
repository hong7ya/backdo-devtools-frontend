// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/** 추가 기록의 상한이다. 브라우저 전체 힙의 바이트 수를 보장하는 값은 아니다. */
export const REPLAY_LIMITS = Object.freeze({
  positions: 100_000,
  consoleInputs: 256,
  consoleBytes: 4 * 1024 * 1024,
  breakpoints: 20_000,
  pendingSources: 256,
});

export const RECORDING_LIMIT_MESSAGE =
    '실행 기록 한도에 도달해 뒤로가기를 사용할 수 없습니다. 뒤로가기가 필요하면 디버깅 세션을 다시 시작하고, ' +
    '가능하면 실행 범위를 줄여 원하는 위치까지 이동해 주세요.';
