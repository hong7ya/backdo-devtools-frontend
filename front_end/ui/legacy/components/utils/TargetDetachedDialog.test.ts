// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {createTarget} from '../../../../testing/EnvironmentHelpers.js';
import {describeWithMockConnection} from '../../../../testing/MockConnection.js';
import * as UI from '../../legacy.js';

import * as Utils from './utils.js';

describeWithMockConnection('대상 종료 안내', () => {
  it('교체 중인 대상만 안내를 생략하고 다른 연결 오류는 계속 표시한다', () => {
    const show = sinon.stub(UI.RemoteDebuggingTerminatedScreen.RemoteDebuggingTerminatedScreen, 'show');
    const replacing = new Utils.TargetDetachedDialog.TargetDetachedDialog(createTarget());
    const other = new Utils.TargetDetachedDialog.TargetDetachedDialog(createTarget());
    replacing.setRestarting(true);
    replacing.detached({reason: 'target_closed'});
    sinon.assert.notCalled(show);

    other.detached({reason: 'connection_lost'});
    sinon.assert.calledOnceWithExactly(show, 'connection_lost');
    show.resetHistory();
    replacing.setRestarting(false);
    replacing.detached({reason: 'connection_lost'});
    sinon.assert.calledOnceWithExactly(show, 'connection_lost');
  });
});
