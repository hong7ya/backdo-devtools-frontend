// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as Replay from './replay.js';

describe('재실행 세션', () => {
  const {ReplaySession} = Replay.ReplaySession;
  const pause = (lineNumber: number, depth = 1, userVisible = false) => ({
    position: {url: 'file:///entry.js', hash: 'v1', lineNumber, columnNumber: 0}, depth, userVisible,
  });

  it('Resume 중간 위치를 기록하고 복원할 때 최종 정지만 화면에 전달한다', () => {
    const session = new ReplaySession();
    assert.strictEqual(session.recordPause(pause(0, 1, true)), 'show');
    session.beginExecution('resume');
    assert.strictEqual(session.recordPause(pause(1)), 'continue');
    assert.strictEqual(session.recordPause(pause(2, 1, true)), 'show');
    assert.deepEqual(session.beginReverse(), pause(1).position);
    assert.strictEqual(session.recordPause(pause(0, 1, true)), 'continue');
    assert.strictEqual(session.recordPause(pause(1)), 'show');
    assert.isTrue(session.canReverse);
    assert.lengthOf(session.history, 2);
    assert.deepEqual(session.beginReverse(), pause(0).position);
    assert.strictEqual(session.recordPause(pause(0, 1, true)), 'show');
    assert.isFalse(session.canReverse);
  });

  it('Step over로 중첩 호출을 건너뛰면서 내부 실행 위치도 기록한다', () => {
    const session = new ReplaySession();
    session.recordPause(pause(0, 2));
    session.beginExecution('step-over');
    assert.strictEqual(session.recordPause(pause(1, 3)), 'continue');
    assert.strictEqual(session.recordPause(pause(2, 2)), 'show');
    assert.deepEqual(session.beginReverse(), pause(1).position);
  });

  it('Step out은 호출자에서 멈추고 사용자 브레이크포인트는 중첩 호출에서도 지킨다', () => {
    const session = new ReplaySession();
    session.recordPause(pause(0, 3));
    session.beginExecution('step-out');
    assert.strictEqual(session.recordPause(pause(1, 3)), 'continue');
    assert.strictEqual(session.recordPause(pause(2, 2)), 'show');
    session.beginExecution('step-over');
    assert.strictEqual(session.recordPause(pause(3, 4, true)), 'show');
  });

  it('재실행 경로가 달라지면 기존 이력을 유지한 채 실패 처리한다', () => {
    const session = new ReplaySession();
    session.recordPause(pause(0));
    session.recordPause(pause(1));
    session.beginReverse();
    assert.throws(() => session.recordPause(pause(9)), /diverged/);
    session.fail(new Error('다른 실행 경로'));
    assert.strictEqual(session.error, '다른 실행 경로');
    assert.isFalse(session.canReverse);
    assert.lengthOf(session.history, 2);
    assert.throws(() => session.beginExecution('resume'), /다른 실행 경로/);
  });

  it('기록 대상 밖의 정지와 재실행 중에는 뒤로가기를 허용하지 않는다', () => {
    const session = new ReplaySession();
    session.recordPause(pause(0));
    session.recordPause(pause(1));
    session.unrecordedPause();
    assert.isFalse(session.canReverse);
    session.recordPause(pause(2));
    session.beginReverse();
    assert.isFalse(session.canReverse);
    assert.throws(() => session.beginExecution('resume'), /in progress/);
  });
});
