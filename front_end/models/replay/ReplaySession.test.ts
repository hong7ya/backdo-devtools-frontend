// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as Replay from './replay.js';

describe('ReplaySession', () => {
  const {ReplaySession} = Replay.ReplaySession;
  const pause = (lineNumber: number, depth = 1, userVisible = false) => ({
    position: {url: 'file:///entry.js', hash: 'v1', lineNumber, columnNumber: 0}, depth, userVisible,
  });

  it('records hidden Resume pauses, then publishes only the replay destination', () => {
    const session = new ReplaySession();
    assert.isTrue(session.accept(pause(0, 1, true)));
    session.command('resume');
    assert.isFalse(session.accept(pause(1)));
    assert.isTrue(session.accept(pause(2, 1, true)));
    assert.deepEqual(session.beginReverse(), pause(1).position);
    assert.isFalse(session.accept(pause(0, 1, true)));
    assert.isTrue(session.accept(pause(1)));
    assert.isTrue(session.canReverse);
    assert.lengthOf(session.history, 2);
    assert.deepEqual(session.beginReverse(), pause(0).position);
    assert.isTrue(session.accept(pause(0, 1, true)));
    assert.isFalse(session.canReverse);
  });

  it('steps over nested calls while recording their positions', () => {
    const session = new ReplaySession();
    session.accept(pause(0, 2));
    session.command('step-over');
    assert.isFalse(session.accept(pause(1, 3)));
    assert.isTrue(session.accept(pause(2, 2)));
    assert.deepEqual(session.beginReverse(), pause(1).position);
  });

  it('steps out to a shallower stack and honors user breakpoints in nested calls', () => {
    const session = new ReplaySession();
    session.accept(pause(0, 3));
    session.command('step-out');
    assert.isFalse(session.accept(pause(1, 3)));
    assert.isTrue(session.accept(pause(2, 2)));
    session.command('step-over');
    assert.isTrue(session.accept(pause(3, 4, true)));
  });

  it('rejects diverging replay without replacing history', () => {
    const session = new ReplaySession();
    session.accept(pause(0));
    session.accept(pause(1));
    session.beginReverse();
    assert.throws(() => session.accept(pause(9)), /diverged/);
    session.fail(new Error('Different execution path'));
    assert.strictEqual(session.error, 'Different execution path');
    assert.isFalse(session.canReverse);
    assert.lengthOf(session.history, 2);
    assert.throws(() => session.command('resume'), /Different execution path/);
  });

  it('does not reverse from an unrecorded source or while replaying', () => {
    const session = new ReplaySession();
    session.accept(pause(0));
    session.accept(pause(1));
    session.unrecordedPause();
    assert.isFalse(session.canReverse);
    session.accept(pause(2));
    session.beginReverse();
    assert.isFalse(session.canReverse);
    assert.throws(() => session.command('resume'), /in progress/);
  });
});
