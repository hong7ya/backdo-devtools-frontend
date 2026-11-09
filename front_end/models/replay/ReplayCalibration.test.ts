// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {describeWithEnvironment} from '../../testing/EnvironmentHelpers.js';

import * as Replay from './replay.js';

describeWithEnvironment('사용자 연결과 분리한 CDP 측정', () => {
  it('사용자 포트를 더미로 잘못 전달해도 연결하거나 사용자 프로세스를 종료하지 않는다', async () => {
    const socket = sinon.spy(window, 'WebSocket');
    const dispose = sinon.stub().resolves();
    const result = await Replay.ReplayCalibration
                       .measureRoundTrip(
                           async () => ({ws: 'ws://localhost:9229/another-page', dispose}), 'ws://127.0.0.1:9229/user',
                           new AbortController().signal)
                       .then(() => null, error => error);
    assert.include(result.message, '별도 포트');
    sinon.assert.notCalled(socket);
    sinon.assert.notCalled(dispose);
  });

  it('세션 종료 후 늦게 생성된 더미도 정리하고 연결하지 않는다', async () => {
    const abort = new AbortController();
    const socket = sinon.spy(window, 'WebSocket');
    const dispose = sinon.stub().resolves();
    let created: (process: Replay.ReplayCalibration.CalibrationProcess) => void = () => {};
    const result = Replay.ReplayCalibration
                       .measureRoundTrip(
                           () => new Promise(resolve => {
                             created = resolve;
                           }),
                           'ws://127.0.0.1:9229/user', abort.signal)
                       .then(() => null, error => error);
    abort.abort();
    assert.include((await result).message, '취소');
    created({ws: 'ws://127.0.0.1:9333/dummy', dispose});
    await Promise.resolve();
    sinon.assert.calledOnce(dispose);
    sinon.assert.notCalled(socket);
  });

  it('더미 연결이 거절되어도 대기를 끝내고 소유한 더미를 정리한다', async () => {
    const dispose = sinon.stub().resolves();
    const result = await Replay.ReplayCalibration
                       .measureRoundTrip(
                           async () => ({ws: 'ws://127.0.0.1:0/dummy', dispose}), 'ws://127.0.0.1:9229/user',
                           new AbortController().signal)
                       .then(() => null, error => error);
    assert.instanceOf(result, Error);
    sinon.assert.calledOnce(dispose);
  });
});
