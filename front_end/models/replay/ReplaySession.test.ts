// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as Replay from './replay.js';

describe('재실행 세션', () => {
  const {ReplaySession} = Replay.ReplaySession;
  const pause = (lineNumber: number, depth = 1, userVisible = false) => ({
    position: {url: 'file:///entry.js', hash: 'v1', lineNumber, columnNumber: 0},
    depth,
    userVisible,
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

  it('Step over로 건너뛴 내부 실행은 경로에만 남기고 호출 전 위치로 돌아간다', () => {
    const session = new ReplaySession();
    session.recordPause(pause(0, 2));
    session.beginExecution('step-over');
    assert.strictEqual(session.recordPause(pause(1, 3)), 'continue');
    assert.strictEqual(session.recordPause(pause(2, 2)), 'show');
    assert.lengthOf(session.history, 3);
    assert.deepEqual(session.beginReverse(), pause(0).position);
    assert.strictEqual(session.recordPause(pause(0, 2)), 'show');
    assert.lengthOf(session.history, 1);
    session.beginExecution('step-into');
    assert.strictEqual(session.recordPause(pause(1, 3)), 'show');
    assert.deepEqual(session.beginReverse(), pause(0).position);
  });

  it('Step out 후 빠져나온 함수의 마지막 실행 위치부터 되짚고 중첩 호출은 건너뛴다', () => {
    const session = new ReplaySession();
    session.recordPause(pause(0, 3));
    session.beginExecution('step-out');
    assert.strictEqual(session.recordPause(pause(1, 3)), 'continue');
    assert.strictEqual(session.recordPause(pause(2, 2)), 'show');
    session.beginExecution('step-out');
    assert.strictEqual(session.recordPause(pause(3, 2)), 'continue');
    assert.strictEqual(session.recordPause(pause(4, 1)), 'show');
    assert.deepEqual(session.beginReverse(), pause(3).position);
    assert.strictEqual(session.recordPause(pause(0, 3)), 'continue');
    assert.strictEqual(session.recordPause(pause(1, 3)), 'continue');
    assert.strictEqual(session.recordPause(pause(2, 2)), 'continue');
    assert.strictEqual(session.recordPause(pause(3, 2)), 'show');
    assert.deepEqual(session.beginReverse(), pause(2).position);
    assert.strictEqual(session.recordPause(pause(0, 3)), 'continue');
    assert.strictEqual(session.recordPause(pause(1, 3)), 'continue');
    assert.strictEqual(session.recordPause(pause(2, 2)), 'show');
    session.beginExecution('step-over');
    assert.strictEqual(session.recordPause(pause(5, 4, true)), 'show');
    session.beginExecution('step-out');
    assert.strictEqual(session.recordPause(pause(6, 4)), 'continue');
    assert.strictEqual(session.recordPause(pause(8, 5)), 'continue');
    assert.strictEqual(session.recordPause(pause(7, 3)), 'show');
    assert.deepEqual(session.beginReverse(), pause(6).position);
  });

  it('재실행 경로가 달라지면 실패 이유만 남기고 이력을 해제한다', () => {
    const session = new ReplaySession();
    session.recordPause(pause(0));
    session.recordPause(pause(1, 1, true));
    session.beginReverse();
    assert.throws(() => session.recordPause(pause(9)), /diverged/);
    session.fail(new Error('다른 실행 경로'));
    assert.strictEqual(session.error, '다른 실행 경로');
    assert.isFalse(session.canReverse);
    assert.lengthOf(session.history, 0);
    assert.throws(() => session.beginExecution('resume'), /다른 실행 경로/);
  });

  it('내부 재개를 사용자 명령과 구분하고 각 기록 위치에 원래 명령을 연결한다', () => {
    const session = new ReplaySession();
    session.recordPause(pause(0, 2));
    const step = session.beginExecution('step-over');
    session.recordDispatch('step-over', 'user');
    session.recordPause(pause(1, 3));
    session.recordDispatch('step-out', 'internal');
    session.recordPause(pause(2, 2));
    const resume = session.beginExecution('resume');
    session.recordDispatch('resume', 'user');
    session.recordPause(pause(3, 2));
    session.recordDispatch('resume', 'internal');
    session.recordPause(pause(4, 2, true));

    assert.deepEqual(session.commands, [step, resume]);
    const records = session.history.records;
    assert.strictEqual(records[1].context?.dispatch?.origin, 'user');
    assert.strictEqual(records[2].context?.userCommand, step);
    assert.strictEqual(records[2].context?.dispatch?.command, 'step-out');
    assert.strictEqual(records[2].context?.dispatch?.origin, 'internal');
    assert.strictEqual(records[4].context?.dispatch?.userCommand, resume);
    assert.deepEqual(session.beginReverse(), pause(3, 2).position);
  });

  it('복원 시 명령을 경계 순서대로 재생하고 버린 미래 명령은 새 분기에 남기지 않는다', () => {
    const session = new ReplaySession();
    session.recordPause(pause(0));
    const resume = session.beginExecution('resume');
    session.recordPause(pause(1));
    session.recordPause(pause(2, 1, true));
    session.beginExecution('step-over');
    session.recordPause(pause(3));
    session.beginReverse();
    assert.isNull(session.takeReplayCommand(0));
    session.recordPause(pause(0));
    assert.strictEqual(session.takeReplayCommand(1), resume);
    assert.isNull(session.takeReplayCommand(1));
    session.recordPause(pause(1));
    assert.strictEqual(session.recordPause(pause(2)), 'show');
    assert.deepEqual(session.commands, [resume]);
    assert.strictEqual(session.currentCommand, resume);
    const stepInto = session.beginExecution('step-into');
    assert.strictEqual(stepInto.sequence, 1);
    assert.strictEqual(stepInto.afterPosition, 3);
  });

  it('같은 위치의 예외 정지에서 누른 Resume는 다음 위치 검증 후 이어받는다', () => {
    const session = new ReplaySession();
    session.recordPause(pause(0));
    const step = session.beginExecution('step-over');
    session.showUserPause(1, true);
    const resume = session.beginExecution('resume');
    session.recordPause(pause(1));
    session.recordPause(pause(2, 1, true));
    session.beginReverse();
    session.recordPause(pause(0));
    assert.strictEqual(session.takeReplayCommand(1), step);
    assert.strictEqual(session.currentCommand, step);
    assert.strictEqual(session.recordPause(pause(1)), 'show');
    assert.strictEqual(session.currentCommand, resume);
    assert.deepEqual(session.commands, [step, resume]);
  });

  it('재생 중 실행 경계를 지난 Step은 마지막 명령으로 대체하지 않고 실패한다', () => {
    const session = new ReplaySession();
    session.recordPause(pause(0));
    session.beginExecution('step-over');
    session.recordPause(pause(1));
    session.beginExecution('resume');
    session.recordPause(pause(2));
    session.recordPause(pause(3, 1, true));
    session.beginReverse();
    session.recordPause(pause(0));
    session.recordPause(pause(1));
    assert.throws(() => session.takeReplayCommand(2), /실행 경계를 지나쳤습니다/);
  });

  it('첫 위치를 만든 Pause는 그 위치 검증으로 소비하고 이후 명령은 실제 재생한다', () => {
    const session = new ReplaySession();
    const initialPause = session.beginExecution('pause');
    assert.strictEqual(session.recordPause(pause(0)), 'show');
    const resume = session.beginExecution('resume');
    session.recordPause(pause(1));
    session.recordPause(pause(2, 1, true));

    assert.deepEqual(session.beginReverse(), pause(1).position);
    assert.strictEqual(session.recordPause(pause(0)), 'continue');
    assert.strictEqual(session.currentCommand, initialPause);
    assert.strictEqual(session.takeReplayCommand(1), resume);
    assert.strictEqual(session.recordPause(pause(1)), 'show');

    assert.deepEqual(session.beginReverse(), pause(0).position);
    assert.strictEqual(session.recordPause(pause(0)), 'show');
    assert.deepEqual(session.commands, [initialPause]);
    session.beginExecution('step-over');
    assert.strictEqual(session.recordPause(pause(1)), 'show');
    assert.deepEqual(session.beginReverse(), pause(0).position);
    assert.strictEqual(session.recordPause(pause(0)), 'show');
  });

  it('기록 대상 밖의 정지와 재실행 중에는 뒤로가기를 허용하지 않는다', () => {
    const session = new ReplaySession();
    session.recordPause(pause(0));
    session.recordPause(pause(1));
    session.unrecordedPause();
    assert.isFalse(session.canReverse);
    session.recordPause(pause(2, 1, true));
    session.beginReverse();
    assert.isFalse(session.canReverse);
    assert.throws(() => session.beginExecution('resume'), /in progress/);
  });

  it('사용자 명령 전의 초기화는 숨겨 기록하고 첫 debugger에서 바로 앞 위치로 돌아간다', () => {
    const session = new ReplaySession();
    assert.strictEqual(session.recordPause(pause(0)), 'continue');
    assert.strictEqual(session.recordPause(pause(1)), 'continue');
    assert.strictEqual(session.recordPause(pause(2, 1, true)), 'show');
    assert.isEmpty(session.commands);
    assert.deepEqual(session.beginReverse(), pause(1).position);
    assert.strictEqual(session.recordPause(pause(0)), 'continue');
    assert.strictEqual(session.recordPause(pause(1)), 'show');
    assert.isNull(session.currentCommand);
    assert.isTrue(session.canReverse);
  });
});
