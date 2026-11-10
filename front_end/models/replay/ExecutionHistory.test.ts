// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as Replay from './replay.js';

const {ExecutionHistory} = Replay.ExecutionHistory;

describe('실행 위치 기록', () => {
  const at = (lineNumber: number, columnNumber: number, hash = 'source-v1') =>
      ({url: 'file:///algorithm.js', hash, lineNumber, columnNumber});

  it('for 문 밖에서 되돌리면 다섯 번째이자 마지막인 조건식의 정확한 열로 이동한다', () => {
    const history = new ExecutionHistory();
    const condition = at(2, 20);
    const events = [at(2, 15), condition];
    for (let i = 0; i < 4; i++) {
      events.push(at(3, 20), at(4, 4), at(2, 27), condition);
    }
    events.push(at(6, 2));
    events.forEach(event => history.record(event));
    const plan = history.previous();
    assert.deepEqual(plan.target, condition);
    assert.lengthOf(plan.positions.filter(p => p.lineNumber === 2 && p.columnNumber === 20), 5);
    for (const [index, position] of events.slice(0, -1).entries()) {
      assert.strictEqual(plan.accept(position), index === events.length - 2);
    }
    history.commit(plan);
    assert.lengthOf(history, events.length - 1);
    assert.deepEqual(history.previous().target, at(2, 27));
  });

  it('break로 빠져나왔을 때 실제 직전 위치를 선택한다', () => {
    const history = new ExecutionHistory();
    [at(2, 20), at(3, 4), at(4, 6), at(7, 2)].forEach(p => history.record(p));
    assert.deepEqual(history.previous().target, at(4, 6));
  });

  it('기록한 소스 버전과 다르면 같은 위치도 복원 경로로 받아들이지 않는다', () => {
    const history = new ExecutionHistory();
    [at(0, 0), at(2, 20), at(6, 2)].forEach(p => history.record(p));
    const plan = history.previous();

    assert.throws(() => plan.accept(at(0, 0, 'edited-source')), /diverged/);
  });

  it('같은 소스라도 다음 실행 위치가 기록과 다르면 복원 경로를 거절한다', () => {
    const history = new ExecutionHistory();
    [at(0, 0), at(2, 20), at(6, 2)].forEach(p => history.record(p));
    const plan = history.previous();
    plan.accept(at(0, 0));

    assert.throws(() => plan.accept(at(2, 27)), /diverged/);
  });

  it('목표까지 도달하지 않은 복원의 확정을 거절하고 원래 기록을 유지한다', () => {
    const history = new ExecutionHistory();
    [at(0, 0), at(2, 20), at(6, 2)].forEach(p => history.record(p));
    const plan = history.previous();
    plan.accept(at(0, 0));

    assert.throws(() => history.commit(plan), /incomplete/);
    assert.lengthOf(history, 3);
  });

  it('입력 객체를 외부에서 변경해도 이미 기록한 위치는 바뀌지 않는다', () => {
    const history = new ExecutionHistory();
    const position = at(0, 0);
    history.record(position);
    history.record(at(1, 0));

    position.lineNumber = 99;

    assert.deepEqual(history.previous().target, at(0, 0));
  });

  it('복원 후 새 위치를 기록하면 버린 미래 대신 복원한 위치가 직전 방문이 된다', () => {
    const history = new ExecutionHistory();
    [at(0, 0), at(1, 0), at(2, 0)].forEach(position => history.record(position));
    const plan = history.previous();
    plan.accept(at(0, 0));
    plan.accept(at(1, 0));

    history.commit(plan);
    history.record(at(9, 0));

    assert.deepEqual(history.previous().positions, [at(0, 0), at(1, 0)]);
  });

  it('빈 기록과 유효하지 않은 위치를 거부한다', () => {
    const history = new ExecutionHistory();
    assert.isFalse(history.canReverse);
    assert.throws(() => history.previous(), /No previous/);
    assert.throws(() => history.record(at(0, 0, '')), /unstable/);
    assert.lengthOf(history, 0);
  });

  it('방문 횟수의 고정 상한 없이 이전 위치를 유지한다', () => {
    const history = new ExecutionHistory();
    // 과거 100,000회 상한을 한 번 넘어도 시간 예산과 무관한 개수 제한을 두지 않는다.
    for (let index = 0; index <= 100_000; index++) {
      history.record(at(index, 0));
    }
    assert.lengthOf(history, 100_001);
    assert.deepEqual(history.previous().target, at(99_999, 0));
  });
});
