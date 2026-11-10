// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// eslint-disable-next-line no-debugger -- Console 입력의 시작 정지를 명시한다.
debugger;

function breakpointExample(multiplier) {
  let total = 0;
  for (let i = 0; i < 4; i += 1) {
    const doubled = i * multiplier;
    total += doubled;
  }
  return total;
}
breakpointExample(2);

breakpointExample(3);
