// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as Replay from './replay.js';

describe('사용자 환경의 복원 시간 추정', () => {
  let clock: sinon.SinonFakeTimers;

  beforeEach(() => {
    clock = sinon.useFakeTimers();
  });

  afterEach(() => clock.restore());

  it('최초 복원 전에는 시간을 가정하지 않고 측정값이 생긴 뒤 그대로 사용한다', () => {
    const timing = new Replay.ReplayTiming.ReplayTiming();
    timing.recordSetup(200);
    assert.isNull(timing.estimatedMs);
    assert.isFalse(timing.calibrated);
    timing.beginReplay();
    timing.finishReplay(320);
    assert.strictEqual(timing.estimatedMs, 320);
    assert.isTrue(timing.calibrated);
  });

  it('사용자가 읽는 시간은 제외하고 자동 진행과 비동기 대기는 실측 그대로 포함한다', () => {
    const timing = calibratedTiming();
    clock.tick(60_000);
    assert.strictEqual(timing.estimatedMs, 400);
    timing.startExecution();
    clock.tick(400);
    timing.startExecution();
    clock.tick(400);
    timing.pauseExecution();
    assert.strictEqual(timing.estimatedMs, 1200);
    clock.tick(60_000);
    assert.strictEqual(timing.estimatedMs, 1200);
  });

  it('새 콘솔 입력 전의 대기는 버리고 이미 측정한 실행 비용은 유지한다', () => {
    const timing = calibratedTiming();
    timing.startExecution();
    clock.tick(100);
    timing.pauseExecution();
    timing.startExecution();
    clock.tick(60_000);
    timing.cancelPendingExecution();
    assert.strictEqual(timing.estimatedMs, 500);
  });

  it('복원한 경로의 실측으로 미래 비용을 버리고 관측한 느린 준비 비용으로 보정한다', () => {
    const timing = calibratedTiming();
    timing.startExecution();
    clock.tick(1000);
    timing.pauseExecution();
    timing.beginReplay();
    timing.startExecution();
    clock.tick(200);
    timing.pauseExecution();
    assert.strictEqual(timing.estimatedMs, 1400, '복원 중에는 기존 사용량이 유지되어야 한다');
    timing.finishReplay(700);
    assert.strictEqual(timing.estimatedMs, 700, '버린 미래 경로의 실행 비용도 제거되어야 한다');

    timing.beginReplay();
    timing.startExecution();
    clock.tick(100);
    timing.pauseExecution();
    timing.finishReplay(1000);
    assert.strictEqual(timing.estimatedMs, 1000, '준비 비용이 늘어난 실측도 다음 예측에 반영해야 한다');
  });

  it('측정 이후 새 지점의 준비 비용만 더하고 실행 중 비용은 중복 계산하지 않는다', () => {
    const timing = calibratedTiming();
    timing.recordSetup(200);
    timing.startExecution();
    clock.tick(100);
    timing.recordSetup(100);
    timing.pauseExecution();
    assert.strictEqual(timing.estimatedMs, 700);
  });

  function calibratedTiming(): Replay.ReplayTiming.ReplayTiming {
    const timing = new Replay.ReplayTiming.ReplayTiming();
    timing.beginReplay();
    timing.finishReplay(400);
    return timing;
  }
});
