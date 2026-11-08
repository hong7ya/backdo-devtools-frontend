// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

function fetchExample() {
  const before = 1;
  fetch(globalThis.endpoint);
  const total = before + 1;
  return total;
}
fetchExample();
