// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

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
