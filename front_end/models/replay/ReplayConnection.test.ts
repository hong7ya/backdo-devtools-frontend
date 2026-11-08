// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {describeWithEnvironment} from '../../testing/EnvironmentHelpers.js';

import * as Replay from './replay.js';

describeWithEnvironment('브라우저와 Node의 공통 연결', () => {
  it('기존 ws 주소는 추가 조회나 재시작 연동 없이 사용한다', async () => {
    const connection = new Replay.ReplayConnection.ReplayConnection(new Replay.ReplayController.ReplayController());
    for (const kind of ['node', 'page'] as const) {
      assert.strictEqual(await connection.resolve({ws: 'ws://127.0.0.1:9229/id'}, kind), 'ws://127.0.0.1:9229/id');
    }
  });

  it('포트 조회 계약에 파일 경로와 실행 명령을 포함하지 않는다', async () => {
    const connection = new Replay.ReplayConnection.ReplayConnection(new Replay.ReplayController.ReplayController());
    const discover = sinon.stub().resolves('ws://127.0.0.1:9333/id');
    const restart = sinon.stub().rejects();
    connection.setLifecycle({discover, restart});
    assert.strictEqual(await connection.resolve({port: 9333}, 'node'), 'ws://127.0.0.1:9333/id');
    sinon.assert.calledOnceWithExactly(discover, 9333, 'node');
    sinon.assert.notCalled(restart);
  });

  it('포트 조회 연동이 없으면 임의 서버 주소를 호출하지 않는다', async () => {
    const connection = new Replay.ReplayConnection.ReplayConnection(new Replay.ReplayController.ReplayController());
    const fetch = sinon.stub(window, 'fetch').rejects();
    const result = await connection.resolve({port: 9229}, 'node').then(() => null, error => error);
    assert.include(result.message, '포트 조회 연동');
    sinon.assert.notCalled(fetch);
  });

  it('새 주소를 반영해도 현재 탭과 다른 쿼리 및 history 상태를 유지한다', () => {
    const replace = sinon.stub(history, 'replaceState');
    Replay.ReplayEndpoint.replaceConnectionAddress('ws://127.0.0.1:9229/new-id');
    const [state, , address] = replace.firstCall.args;
    const result = new URL(String(address));
    assert.strictEqual(result.origin, location.origin);
    assert.strictEqual(result.pathname, location.pathname);
    assert.strictEqual(result.searchParams.get('ws'), '127.0.0.1:9229/new-id');
    assert.strictEqual(state, history.state);
  });
});
