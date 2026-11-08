// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as Replay from './replay.js';

const {ExecutionHistory} = Replay.ExecutionHistory;

describe('ExecutionHistory', () => {
  const at = (lineNumber: number, columnNumber: number, hash = 'source-v1') =>
      ({url: 'file:///algorithm.js', hash, lineNumber, columnNumber});

  it('reverse after a for loop selects the final condition, including its column and fifth visit', () => {
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

  it('a break exit follows its actual predecessor, not a hardcoded loop condition', () => {
    const history = new ExecutionHistory();
    [at(2, 20), at(3, 4), at(4, 6), at(7, 2)].forEach(p => history.record(p));
    assert.deepEqual(history.previous().target, at(4, 6));
  });

  it('the full prefix and source version must agree before a replay can be committed', () => {
    const history = new ExecutionHistory();
    [at(0, 0), at(2, 20), at(6, 2)].forEach(p => history.record(p));
    assert.throws(() => history.previous().accept(at(0, 0, 'edited-source')), /diverged/);
    const plan = history.previous();
    plan.accept(at(0, 0));
    assert.throws(() => plan.accept(at(2, 27)), /diverged/);
    assert.throws(() => history.commit(plan), /incomplete/);
    assert.lengthOf(history, 3);
  });

  it('recording after reverse replaces the old future and does not retain mutable input objects', () => {
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

  it('unavailable history and capacity exhaustion fail explicitly without dropping the replay prefix', () => {
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
