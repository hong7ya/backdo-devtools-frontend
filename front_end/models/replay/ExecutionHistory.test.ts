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

  it('목표까지의 전체 위치 순서와 소스 버전이 일치해야 복원을 확정한다', () => {
    const history = new ExecutionHistory();
    [at(0, 0), at(2, 20), at(6, 2)].forEach(p => history.record(p));
    assert.throws(() => history.previous().accept(at(0, 0, 'edited-source')), /diverged/);
    const plan = history.previous();
    plan.accept(at(0, 0));
    assert.throws(() => plan.accept(at(2, 27)), /diverged/);
    assert.throws(() => history.commit(plan), /incomplete/);
    assert.lengthOf(history, 3);
  });

  it('복원 후에는 새로운 이력을 기록하고 입력 객체의 외부 변경을 차단한다', () => {
    const history = new ExecutionHistory();
    const position = at(0, 0);
    history.record(position);
    position.lineNumber = 99;
    history.record(at(1, 0));
    const plan = history.previous();
    assert.isTrue(plan.accept(at(0, 0)));
    history.commit(plan);
    history.record(at(9, 0));
    assert.lengthOf(history, 2);
    assert.deepEqual(history.previous().target, at(0, 0));
  });

  it('복원 계획은 이미 고정된 위치 객체를 재사용하고 명시적으로 기록을 비울 수 있다', () => {
    const history = new ExecutionHistory();
    history.record(at(0, 0));
    history.record(at(1, 0));
    const first = history.previous();
    const second = history.previous();
    assert.strictEqual(first.positions[0], second.positions[0]);
    history.clear();
    assert.lengthOf(history, 0);
    assert.isFalse(history.canReverse);
  });

  it('이력이 없거나 용량이 부족하면 앞선 기록을 버리지 않고 실패 처리한다', () => {
    const history = new ExecutionHistory(2);
    assert.isFalse(history.canReverse);
    assert.throws(() => history.previous(), /No previous/);
    assert.throws(() => history.record(at(0, 0, '')), /unstable/);
    history.record(at(0, 0));
    history.record(at(1, 0));
    assert.throws(() => history.record(at(2, 0)), /limit/);
    assert.lengthOf(history, 2);
  });
});
