// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// eslint-disable-next-line no-debugger -- Console 입력의 시작 정지를 명시한다.
debugger;

function example() {
  let total = 0;
  if (false) {
    throw new Error('unreachable');
  }
  for (const value of [2, 4, 6, 8]) {
    total += value;
    if (value === 6) {
      break;
    }
  }
  return total;
}
example();
