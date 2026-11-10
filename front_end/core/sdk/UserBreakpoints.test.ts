// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as Protocol from '../../generated/protocol.js';
import {createTarget} from '../../testing/EnvironmentHelpers.js';
import {
  clearMockConnectionResponseHandler,
  describeWithMockConnection,
  setMockConnectionResponseHandler
} from '../../testing/MockConnection.js';
import * as Common from '../common/common.js';

import * as SDK from './sdk.js';

describeWithMockConnection('사용자 중단점의 일시 해제와 복구', () => {
  beforeEach(() => {
    setMockConnectionResponseHandler('Debugger.setPauseOnExceptions', () => ({}));
    setMockConnectionResponseHandler('DOMDebugger.setBreakOnCSPViolation', () => ({}));
    setMockConnectionResponseHandler('DOMDebugger.setXHRBreakpoint', () => ({}));
    setMockConnectionResponseHandler('DOMDebugger.removeXHRBreakpoint', () => ({}));
    setMockConnectionResponseHandler('DOMDebugger.setEventListenerBreakpoint', () => ({}));
    setMockConnectionResponseHandler('DOMDebugger.removeEventListenerBreakpoint', () => ({}));
    setMockConnectionResponseHandler('EventBreakpoints.setInstrumentationBreakpoint', () => ({}));
    setMockConnectionResponseHandler('EventBreakpoints.removeInstrumentationBreakpoint', () => ({}));
  });

  it('XHR 중단점을 잠시 해제해도 사용자의 활성·비활성 선택은 저장된 상태로 남는다', async () => {
    const manager = SDK.DOMDebuggerModel.DOMDebuggerManager.instance({forceNew: true});
    const model = createTarget().model(SDK.DOMDebuggerModel.DOMDebuggerModel)!;
    sinon.stub(model, 'updateDOMBreakpointApplication').resolves();
    const remove = sinon.spy(model.agent, 'invoke_removeXHRBreakpoint');
    manager.addXHRBreakpoint('/effect', true);
    manager.addXHRBreakpoint('/disabled', false);
    const setting = Common.Settings.Settings.instance().createLocalSetting('xhr-breakpoints', []);

    await SDK.UserBreakpoints.UserBreakpoints.instance().setSuspended(true);

    sinon.assert.calledWith(remove, {url: '/effect'});
    assert.deepEqual(setting.get(), [{url: '/effect', enabled: true}, {url: '/disabled', enabled: false}]);
  });

  it('교체된 대상의 XHR 중단점은 복원 중에는 설치하지 않고 완료 후 활성 항목만 적용한다', async () => {
    const manager = SDK.DOMDebuggerModel.DOMDebuggerManager.instance({forceNew: true});
    const original = createTarget().model(SDK.DOMDebuggerModel.DOMDebuggerModel)!;
    sinon.stub(original, 'updateDOMBreakpointApplication').resolves();
    manager.addXHRBreakpoint('/effect', true);
    manager.addXHRBreakpoint('/disabled', false);
    const activation = SDK.UserBreakpoints.UserBreakpoints.instance();
    await activation.setSuspended(true);
    original.target().dispose('대상 교체');
    const install = sinon.stub().returns({});
    clearMockConnectionResponseHandler('DOMDebugger.setXHRBreakpoint');
    setMockConnectionResponseHandler('DOMDebugger.setXHRBreakpoint', install);

    const next = createTarget().model(SDK.DOMDebuggerModel.DOMDebuggerModel)!;
    sinon.stub(next, 'updateDOMBreakpointApplication').resolves();

    sinon.assert.notCalled(install);

    await activation.setSuspended(false);

    sinon.assert.calledWith(install, {url: '/effect'});
    sinon.assert.neverCalledWith(install, {url: '/disabled'});
  });

  it('이벤트 중단점은 사용자 선택을 유지한 채 잠시 해제했다가 다시 적용한다', async () => {
    const manager = SDK.DOMDebuggerModel.DOMDebuggerManager.instance({forceNew: true});
    const model = createTarget().model(SDK.DOMDebuggerModel.DOMDebuggerModel)!;
    sinon.stub(model, 'updateDOMBreakpointApplication').resolves();
    const click = manager.eventListenerBreakpoints().find(breakpoint => breakpoint.name === 'click')!;
    click.setEnabled(true);
    const remove = sinon.spy(model.agent, 'invoke_removeEventListenerBreakpoint');
    const install = sinon.spy(model.agent, 'invoke_setEventListenerBreakpoint');
    const activation = SDK.UserBreakpoints.UserBreakpoints.instance();

    await activation.setSuspended(true);

    sinon.assert.calledWith(remove, {eventName: 'click', targetName: '*'});
    assert.isTrue(click.enabled());

    await activation.setSuspended(false);

    sinon.assert.calledWith(install, {eventName: 'click', targetName: '*'});
  });

  it('타이머 중단점은 사용자 선택을 유지한 채 잠시 해제했다가 다시 적용한다', async () => {
    const manager = SDK.EventBreakpointsModel.EventBreakpointsManager.instance({forceNew: true});
    const model = createTarget().model(SDK.EventBreakpointsModel.EventBreakpointsModel)!;
    const timer = manager.eventListenerBreakpoints().find(breakpoint => breakpoint.name === 'setTimeout')!;
    timer.setEnabled(true);
    const remove = sinon.spy(model.agent, 'invoke_removeInstrumentationBreakpoint');
    const install = sinon.spy(model.agent, 'invoke_setInstrumentationBreakpoint');
    const activation = SDK.UserBreakpoints.UserBreakpoints.instance();

    await activation.setSuspended(true);

    sinon.assert.calledWith(remove, {eventName: 'setTimeout'});
    assert.isTrue(timer.enabled());

    await activation.setSuspended(false);

    sinon.assert.calledWith(install, {eventName: 'setTimeout'});
  });

  it('CSP 정지는 저장한 위반 종류를 바꾸지 않고 일시 해제한다', async () => {
    const manager = SDK.DOMDebuggerModel.DOMDebuggerManager.instance({forceNew: true});
    const model = createTarget().model(SDK.DOMDebuggerModel.DOMDebuggerModel)!;
    sinon.stub(model, 'updateDOMBreakpointApplication').resolves();
    const violation = manager.cspViolationBreakpoints()[0];
    violation.setEnabled(true);
    manager.updateCSPViolationBreakpoints();
    const apply = sinon.spy(model.agent, 'invoke_setBreakOnCSPViolation');

    await SDK.UserBreakpoints.UserBreakpoints.instance().setSuspended(true);

    assert.deepEqual(apply.lastCall.args[0], {violationTypes: []});
    assert.isTrue(violation.enabled());
  });

  it('예외 정지를 일시 해제해도 사용자의 예외 설정은 유지한다', async () => {
    const target = createTarget();
    const setting = Common.Settings.Settings.instance().moduleSetting('pause-on-uncaught-exception');
    setting.set(true);
    const apply = sinon.spy(target.debuggerAgent(), 'invoke_setPauseOnExceptions');

    await SDK.UserBreakpoints.UserBreakpoints.instance().setSuspended(true);

    assert.deepEqual(apply.lastCall.args[0], {state: Protocol.Debugger.SetPauseOnExceptionsRequestState.None});
    assert.isTrue(setting.get());
  });

  it('DOM 중단점의 설정과 표시를 유지하고 변경된 nodeId로 다시 적용한다', async () => {
    const target = createTarget();
    const model = target.model(SDK.DOMDebuggerModel.DOMDebuggerModel)!;
    const dom = target.model(SDK.DOMModel.DOMModel)!;
    const document = {documentURL: 'https://backdo.test/'} as SDK.DOMModel.DOMDocument;
    sinon.stub(dom, 'existingDocument').returns(document);
    sinon.stub(dom, 'requestDocument').resolves(document);
    const marker = sinon.spy();
    const node = {id: 1, path: () => '0,HTML,0,BODY', setMarker: marker} as unknown as SDK.DOMModel.DOMNode;
    const nextNode = {...node, id: 2} as SDK.DOMModel.DOMNode;
    sinon.stub(dom, 'pushNodeByPathToFrontend').resolves(nextNode.id);
    sinon.stub(dom, 'nodeForId').returns(nextNode);
    const set = sinon.stub(model.agent, 'invoke_setDOMBreakpoint').resolves({getError: () => undefined});
    const remove = sinon.stub(model.agent, 'invoke_removeDOMBreakpoint').resolves({getError: () => undefined});
    const breakpoint = model.setDOMBreakpoint(node, Protocol.DOMDebugger.DOMBreakpointType.SubtreeModified);
    const setting = Common.Settings.Settings.instance().createLocalSetting('dom-breakpoints', []);
    const activation = SDK.UserBreakpoints.UserBreakpoints.instance();
    activation.register('test-dom', () => model.updateDOMBreakpointApplication());
    marker.resetHistory();

    await activation.setSuspended(true);

    assert.isTrue(breakpoint.enabled);
    sinon.assert.notCalled(marker);
    sinon.assert.calledWith(remove, {nodeId: 1, type: breakpoint.type});

    await activation.setSuspended(false);

    sinon.assert.calledWith(set, {nodeId: 2, type: breakpoint.type});
    assert.deepEqual(setting.get(), [{
                       url: 'https://backdo.test/',
                       path: '0,HTML,0,BODY',
                       type: Protocol.DOMDebugger.DOMBreakpointType.SubtreeModified,
                       enabled: true,
                     }]);
  });

  it('한 종류의 복구가 실패해도 나머지 중단점을 복구하고 오류를 알린다', async () => {
    const activation = SDK.UserBreakpoints.UserBreakpoints.instance();
    await activation.setSuspended(true);
    activation.register('failed', async () => {
      throw new Error('CDP 실패');
    });
    const restored = sinon.stub().resolves();
    activation.register('working', restored);

    const failure = await activation.setSuspended(false).then(() => null, error => error);

    assert.instanceOf(failure, AggregateError);
    sinon.assert.calledOnce(restored);
    assert.isFalse(activation.suspended);
  });
});
