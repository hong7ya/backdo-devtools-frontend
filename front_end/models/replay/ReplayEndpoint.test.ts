// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as Replay from './replay.js';

describe('디버거 연결 주소', () => {
  it('파일 경로나 실행 명령 없이 포트 번호만 받는다', () => {
    assert.deepEqual(Replay.ReplayEndpoint.readConnectionRequest(new URL('https://backdo.site/js_app.html?port=9229')), {port: 9229});
  });

  it('기존 ws 직접 연결을 포트 조회보다 우선한다', () => {
    assert.deepEqual(Replay.ReplayEndpoint.readConnectionRequest(new URL('https://backdo.site/js_app.html?port=9229&ws=127.0.0.1:9229/id')), {
      ws: 'ws://127.0.0.1:9229/id',
    });
  });

  it('기존 보안 WebSocket 주소도 유지한다', () => {
    assert.deepEqual(Replay.ReplayEndpoint.readConnectionRequest(new URL('https://backdo.site/devtools_app.html?wss=host.test/debugger')), {
      ws: 'wss://host.test/debugger',
    });
  });

  it('연결 인자가 없으면 기존 내장 연결을 사용한다', () => {
    assert.isNull(Replay.ReplayEndpoint.readConnectionRequest(new URL('https://backdo.site/devtools_app.html')));
  });

  it('범위를 벗어나거나 숫자가 아닌 포트를 거절한다', () => {
    for (const port of ['', '0', '65536', '9229.1', '../file.js']) {
      assert.throws(() => Replay.ReplayEndpoint.readConnectionRequest(new URL(`https://backdo.site/js_app.html?port=${port}`)), /포트/);
    }
  });

  it('디버거 주소에 인증 정보나 다른 프로토콜을 허용하지 않는다', () => {
    for (const ws of ['https://localhost:9229/id', 'ws://user:password@localhost:9229/id']) {
      assert.throws(() => Replay.ReplayEndpoint.validateWebSocketURL(ws), /WebSocket/);
    }
  });
});
