// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as Protocol from '../../generated/protocol.js';
import {createTarget} from '../../testing/EnvironmentHelpers.js';
import {describeWithMockConnection, setMockConnectionResponseHandler} from '../../testing/MockConnection.js';
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

  it('XHR·이벤트·타이머·CSP·예외 설정을 유지하고 새 대상에는 복원 완료 후 적용한다', async () => {
    const domManager = SDK.DOMDebuggerModel.DOMDebuggerManager.instance({forceNew: true});
    const eventManager = SDK.EventBreakpointsModel.EventBreakpointsManager.instance({forceNew: true});
    const target = createTarget();
    const model = target.model(SDK.DOMDebuggerModel.DOMDebuggerModel)!;
    const timers = target.model(SDK.EventBreakpointsModel.EventBreakpointsModel)!;
    sinon.stub(model, 'updateDOMBreakpointApplication').resolves();
    const xhrRemove = sinon.spy(model.agent, 'invoke_removeXHRBreakpoint');
    const eventRemove = sinon.spy(model.agent, 'invoke_removeEventListenerBreakpoint');
    const timerRemove = sinon.spy(timers.agent, 'invoke_removeInstrumentationBreakpoint');
    const csp = sinon.spy(model.agent, 'invoke_setBreakOnCSPViolation');
    const exceptions = sinon.spy(target.debuggerAgent(), 'invoke_setPauseOnExceptions');
    domManager.addXHRBreakpoint('/effect', true);
    domManager.addXHRBreakpoint('/disabled', false);
    const click = domManager.eventListenerBreakpoints().find(breakpoint => breakpoint.name === 'click')!;
    click.setEnabled(true);
    const timer = eventManager.eventListenerBreakpoints().find(breakpoint => breakpoint.name === 'setTimeout')!;
    timer.setEnabled(true);
    const violation = domManager.cspViolationBreakpoints()[0];
    violation.setEnabled(true);
    domManager.updateCSPViolationBreakpoints();
    Common.Settings.Settings.instance().moduleSetting('pause-on-uncaught-exception').set(true);
    const settings = Common.Settings.Settings.instance().createLocalSetting('xhr-breakpoints', []).get();
    const activation = SDK.UserBreakpoints.UserBreakpoints.instance();

    await activation.setSuspended(true);
    sinon.assert.calledWith(xhrRemove, {url: '/effect'});
    sinon.assert.calledWith(eventRemove, {eventName: 'click', targetName: '*'});
    sinon.assert.calledWith(timerRemove, {eventName: 'setTimeout'});
    assert.deepEqual(csp.lastCall.args[0], {violationTypes: []});
    assert.deepEqual(exceptions.lastCall.args[0], {state: Protocol.Debugger.SetPauseOnExceptionsRequestState.None});
    assert.isTrue(click.enabled());
    assert.isTrue(timer.enabled());
    assert.isTrue(violation.enabled());
    assert.deepEqual(Common.Settings.Settings.instance().createLocalSetting('xhr-breakpoints', []).get(), settings);

    const next = createTarget();
    const nextDOM = next.model(SDK.DOMDebuggerModel.DOMDebuggerModel)!;
    const nextTimers = next.model(SDK.EventBreakpointsModel.EventBreakpointsModel)!;
    sinon.stub(nextDOM, 'updateDOMBreakpointApplication').resolves();
    const setXHR = sinon.spy(nextDOM.agent, 'invoke_setXHRBreakpoint');
    const setEvent = sinon.spy(nextDOM.agent, 'invoke_setEventListenerBreakpoint');
    const setTimer = sinon.spy(nextTimers.agent, 'invoke_setInstrumentationBreakpoint');
    domManager.addXHRBreakpoint('/during-replay', true);
    sinon.assert.notCalled(setXHR);
    await activation.setSuspended(false);
    sinon.assert.calledWith(setXHR, {url: '/effect'});
    sinon.assert.calledWith(setXHR, {url: '/during-replay'});
    assert.isFalse(setXHR.calledWith({url: '/disabled'}));
    sinon.assert.calledWith(setEvent, {eventName: 'click', targetName: '*'});
    sinon.assert.calledWith(setTimer, {eventName: 'setTimeout'});
    assert.isTrue(Common.Settings.Settings.instance().moduleSetting('pause-on-uncaught-exception').get());
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
    const resolvePath = sinon.stub(dom, 'pushNodeByPathToFrontend').resolves(nextNode.id);
    sinon.stub(dom, 'nodeForId').returns(nextNode);
    const set = sinon.stub(model.agent, 'invoke_setDOMBreakpoint').resolves({getError: () => undefined});
    const remove = sinon.stub(model.agent, 'invoke_removeDOMBreakpoint').resolves({getError: () => undefined});
    const breakpoint = model.setDOMBreakpoint(node, Protocol.DOMDebugger.DOMBreakpointType.SubtreeModified);
    const settings = Common.Settings.Settings.instance().createLocalSetting('dom-breakpoints', []).get();
    const activation = SDK.UserBreakpoints.UserBreakpoints.instance();
    activation.register('test-dom', () => model.updateDOMBreakpointApplication());
    marker.resetHistory();
    await activation.setSuspended(true);
    assert.isTrue(breakpoint.enabled);
    sinon.assert.notCalled(marker);
    sinon.assert.calledWith(remove, {nodeId: 1, type: breakpoint.type});
    await activation.setSuspended(false);
    sinon.assert.calledWith(set, {nodeId: 2, type: breakpoint.type});
    assert.deepEqual(Common.Settings.Settings.instance().createLocalSetting('dom-breakpoints', []).get(), settings);
    await activation.setSuspended(true);
    resolvePath.resolves(null);
    const missingNode = await activation.setSuspended(false).then(() => null, error => error);
    assert.instanceOf(missingNode, AggregateError);
    assert.deepEqual(Common.Settings.Settings.instance().createLocalSetting('dom-breakpoints', []).get(), settings);
  });

  it('일부 종류의 적용이 실패해도 나머지 복구를 모두 기다리고 실패를 알린다', async () => {
    const activation = SDK.UserBreakpoints.UserBreakpoints.instance();
    const states: boolean[] = [];
    activation.register('failed', async () => {
      throw new Error('CDP 실패');
    });
    activation.register('working', async () => {
      states.push(activation.suspended);
    });
    const failure = await activation.setSuspended(true).then(() => null, error => error);
    assert.instanceOf(failure, AggregateError);
    const restoreFailure = await activation.setSuspended(false).then(() => null, error => error);
    assert.instanceOf(restoreFailure, AggregateError);
    assert.deepEqual(states, [true, false]);
    assert.isFalse(activation.suspended);
  });
});
