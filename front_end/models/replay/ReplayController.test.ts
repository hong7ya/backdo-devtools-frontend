// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as SDK from '../../core/sdk/sdk.js';
import * as Protocol from '../../generated/protocol.js';
import {createTarget} from '../../testing/EnvironmentHelpers.js';
import {describeWithMockConnection} from '../../testing/MockConnection.js';

import * as Replay from './replay.js';

describeWithMockConnection('재실행 제어기', () => {
  it('새 연결이 응답하지 않아도 제한 시간이 지나면 작업 중 상태를 해제한다', async () => {
    const clock = sinon.useFakeTimers();
    try {
      const controller = new Replay.ReplayController.ReplayController();
      sinon.stub(window, 'fetch').callsFake(async () => new Response(JSON.stringify({
        ws: 'ws://127.0.0.1:9229/test', entryURL: 'file:///entry.js',
      })));
      await controller.configure('test', () => new Promise<void>(() => {}));
      const target = createTarget();
      const model = target.model(SDK.DebuggerModel.DebuggerModel)!;
      sinon.stub(target.router()!.connection(), 'disconnect').resolves();
      controller.attach(target);
      await model.pausedScript([], Protocol.Debugger.PausedEventReason.Other, undefined, []);
      for (const lineNumber of [0, 1]) {
        controller.session.recordPause({
          position: {url: 'file:///entry.js', hash: 'v1', lineNumber, columnNumber: 0},
          depth: 1, userVisible: true,
        });
      }
      const result = controller.reverse().then(() => null, error => error);
      await clock.tickAsync(30_001);
      assert.match((await result).message, /timed out/);
      assert.isFalse(controller.busy);
      assert.isFalse(controller.canReverse(model));
    } finally {
      clock.restore();
    }
  });
});
