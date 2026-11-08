// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

function delayDouble(value) {
  return new Promise(resolve => {
    setTimeout(() => {
      resolve(value * 2);
    }, 10);
  });
}

async function asyncExample() {
  let total = 0;
  for (let i = 0; i < 3; i += 1) {
    const doubled = await delayDouble(i);
    await Promise.resolve();
    total += doubled;
  }
  return total;
}
asyncExample();
