// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {describeWithEnvironment} from '../../testing/EnvironmentHelpers.js';

import * as Sources from './sources.js';

describeWithEnvironment('거꾸로가기 시간 예산 표시', () => {
  it('CDP 예상 시간만 3초 기준으로 표시하고 기록 종료 시 사용률을 비운다', () => {
    const toolbar = new Sources.ReplayToolbar.ReplayToolbar();
    const meter = toolbar.element.querySelector('[role="meter"]')!;

    toolbar.updateUsage(null, 1500);
    assert.strictEqual(meter.getAttribute('aria-valuenow'), '50');
    assert.include(meter.getAttribute('aria-valuetext') ?? '', 'CDP 처리 시간 예산 50.0%');

    toolbar.updateUsage('예상 CDP 처리 시간이 3초에 도달했습니다.', null);
    assert.strictEqual(meter.getAttribute('aria-valuenow'), '0');
    assert.strictEqual(meter.getAttribute('aria-valuetext'), '기록 종료 · 저장된 기록 해제');
  });
});
