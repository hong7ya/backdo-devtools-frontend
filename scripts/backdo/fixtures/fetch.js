// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// eslint-disable-next-line no-debugger -- Console 입력의 시작 정지를 명시한다.
debugger;

async function fetchExample() {
  const before = 1;
  await fetch(globalThis.endpoint);
  const total = before + 1;
  return total;
}
await fetchExample();
await fetchExample();
