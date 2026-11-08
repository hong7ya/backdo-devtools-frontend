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
  idleMilliseconds: 30 * 60 * 1000,
});
