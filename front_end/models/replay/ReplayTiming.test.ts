// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as Replay from './replay.js';

describe('CDP 왕복과 기록 개수 기반 예산', () => {
  it('측정 전에는 예상 시간을 만들지 않고 측정 후에는 방문 횟수만 곱한다', () => {
    const timing = new Replay.ReplayTiming.ReplayTiming();
    assert.isNull(timing.estimate(100));
    timing.calibrate(0.5);
    assert.isTrue(timing.calibrated);
    assert.strictEqual(timing.estimate(6000), 3000);
    assert.strictEqual(timing.estimate(5999), 2999.5, '복원으로 버린 미래 기록의 비용도 줄어야 한다');
  });

  it('유효하지 않은 측정값은 임의 기본값으로 대체하지 않는다', () => {
    const timing = new Replay.ReplayTiming.ReplayTiming();
    for (const value of [0, -1, NaN, Infinity]) {
      assert.throws(() => timing.calibrate(value), /측정하지 못했습니다/);
    }
    assert.isNull(timing.estimate(10));
  });
});
