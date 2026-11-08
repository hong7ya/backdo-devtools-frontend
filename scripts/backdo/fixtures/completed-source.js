// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

function runCompletedSource() {
  (0, eval)(`Math.abs(-1);
Math.abs(-2);
//# sourceURL=https://example.test/completed-source.js`);
}
runCompletedSource();
