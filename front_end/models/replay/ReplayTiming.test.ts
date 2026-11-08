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

  it('사용자가 멈춰 읽는 시간은 제외하고 자동 진행과 비동기 대기는 포함한다', () => {
    const timing = new Replay.ReplayTiming.ReplayTiming();
    const initial = timing.estimatedMs;
    clock.tick(60_000);
    assert.strictEqual(timing.estimatedMs, initial);
    timing.startExecution();
    clock.tick(400);
    timing.startExecution();
    clock.tick(400);
    timing.pauseExecution();
    const recorded = timing.estimatedMs;
    assert.strictEqual(recorded, initial + 800 * 1.25);
    clock.tick(60_000);
    assert.strictEqual(timing.estimatedMs, recorded);
  });

  it('새 콘솔 입력 전의 대기는 버리고 이미 측정한 실행 비용은 유지한다', () => {
    const timing = new Replay.ReplayTiming.ReplayTiming();
    timing.startExecution();
    clock.tick(100);
    timing.pauseExecution();
    const recorded = timing.estimatedMs;
    timing.startExecution();
    clock.tick(60_000);
    timing.cancelPendingExecution();
    assert.strictEqual(timing.estimatedMs, recorded);
  });

  it('복원한 경로의 실측으로 비용을 교체하고 느린 재시작도 다음 추정에 반영한다', () => {
    const timing = new Replay.ReplayTiming.ReplayTiming();
    timing.startExecution();
    clock.tick(1000);
    timing.pauseExecution();
    const before = timing.estimatedMs;
    timing.beginReplay();
    clock.tick(1400);
    timing.startExecution();
    clock.tick(200);
    timing.pauseExecution();
    assert.strictEqual(timing.estimatedMs, before, '복원 중에는 기존 사용량이 유지되어야 한다');
    timing.finishReplay(1600);
    assert.strictEqual(timing.estimatedMs, 1400 + 200 * 1.25);
    assert.isBelow(timing.estimatedMs, before, '버린 미래 경로의 실행 비용도 제거되어야 한다');
  });

  it('정지 중 브레이크포인트 준비 비용은 더하고 실행 중 비용은 중복 계산하지 않는다', () => {
    const timing = new Replay.ReplayTiming.ReplayTiming();
    const initial = timing.estimatedMs;
    timing.recordSetup(200);
    timing.startExecution();
    clock.tick(100);
    timing.recordSetup(100);
    timing.pauseExecution();
    assert.strictEqual(timing.estimatedMs, initial + 200 + 100 * 1.25);
  });
});
