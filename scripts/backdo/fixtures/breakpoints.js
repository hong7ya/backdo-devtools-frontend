// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

function breakpointExample() {
  let total = 0;
  for (let i = 0; i < 4; i += 1) {
    const doubled = i * 2;
    total += doubled;
  }
  return total;
}
breakpointExample();

breakpointExample();
