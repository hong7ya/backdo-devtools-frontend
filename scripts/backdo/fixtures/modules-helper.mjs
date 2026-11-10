// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

export function forExample() {
  debugger;  // 모듈 진입
  let total = 0;
  for (let i = 0; i < 4; i += 1) {
    const doubled = i * 2;
    total += doubled;
  }
  debugger;  // 반환 직전
  return total;
}
