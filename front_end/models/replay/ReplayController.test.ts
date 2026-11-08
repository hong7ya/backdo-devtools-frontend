// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as SDK from '../../core/sdk/sdk.js';
import * as Protocol from '../../generated/protocol.js';
import {createTarget} from '../../testing/EnvironmentHelpers.js';
import {describeWithMockConnection, dispatchEvent} from '../../testing/MockConnection.js';

import * as Replay from './replay.js';

const controllers = new Set<Replay.ReplayController.ReplayController>();

describeWithMockConnection('공통 재실행 제어기', () => {
  afterEach(() => {
    for (const controller of controllers) {
      controller.dispose();
    }
    controllers.clear();
  });
  it('재시작 연동이 없어도 위치 기록을 유지하고 뒤로가기만 비활성화한다', async () => {
    const {controller, model, script} = prepare('node');
    await pause(model, script, 0);
    await pause(model, script, 1);
    assert.lengthOf(controller.session.history, 2);
    assert.strictEqual(controller.recordingUsage.positions, 2);
    assert.isNull(controller.session.error);
    assert.isFalse(controller.canReverse(model));
    assert.include(controller.status, '재시작 연동');
  });

  it('콘솔에서 입력한 익명 소스에 파일 경로 없이 일반 브레이크포인트를 설치한다', async () => {
    const {controller, model, script, target, expression} = prepare('page');
    recordConsoleCommand(target, expression);
    model.dispatchEventToListeners(SDK.DebuggerModel.Events.ParsedScriptSource, script);
    await pause(model, script, 0);
    await pause(model, script, 1);
    assert.strictEqual(controller.inputCount, 1);
    assert.lengthOf(controller.session.history, 2);
    assert.strictEqual(controller.currentPosition?.url, 'backdo-console:///1');
    assert.isNull(controller.session.error);
    const requests = (model.agent.invoke_setBreakpoint as sinon.SinonStub).getCalls();
    assert.lengthOf(requests, 2);
    assert.isTrue(requests.every(call => !('condition' in call.args[0])));
  });

  it('일시정지 중 콘솔 실행은 기존 지역 상태를 복원할 수 있다고 표시하지 않는다', async () => {
    const {controller, model, script, target} = prepare('node');
    await pause(model, script, 0);
    recordConsoleCommand(target, 'value = 2');
    assert.include(controller.session.error ?? '', '일시정지 중 콘솔');
    assert.isFalse(controller.canReverse(model));
  });

  it('복원 중 사용자가 콘솔 코드를 실행하면 성공으로 표시하지 않고 종료한다', async () => {
    const {controller, model, script, target} = prepare('node');
    controller.setRestartHandler(async () => 'ws://127.0.0.1:9229/new');
    sinon.stub(target.router()!.connection(), 'disconnect').resolves();
    await pause(model, script, 0);
    await pause(model, script, 1);
    const result = controller.reverse().then(() => null, error => error);
    recordConsoleCommand(target, 'value = 2');
    assert.include((await result).message, '복원 중 콘솔');
    assert.isFalse(controller.busy);
    assert.isFalse(controller.canReverse(model));
    assert.strictEqual(controller.recordingUsage.positions, 0);
  });

  it('콘솔 원문 용량 한도에 도달하면 원문과 위치를 함께 해제한다', () => {
    const {controller, target} = prepare('page');
    recordConsoleCommand(target, 'const first = 1;');
    assert.strictEqual(controller.inputCount, 1);
    recordConsoleCommand(target, 'x'.repeat(Replay.ReplayLimits.REPLAY_LIMITS.consoleBytes / 2 + 1));
    assert.strictEqual(controller.recordingUsage.consoleBytes, 0);
    assert.strictEqual(controller.recordingUsage.positions, 0);
    assert.include(controller.status, '실행 기록 한도');
    assert.include(controller.status, '세션을 다시 시작');
    assert.strictEqual(controller.inputCount, 0);
    assert.lengthOf(controller.session.history, 0);
  });

  it('실행 컨텍스트가 교체되면 이전 입력과 위치를 비우고 새 기록을 받는다', () => {
    const {controller, target, model} = prepare('page');
    recordConsoleCommand(target, 'const first = 1;');
    model.globalObjectCleared();
    assert.strictEqual(controller.inputCount, 0);
    assert.lengthOf(controller.session.history, 0);
    assert.isNull(controller.session.error);
    recordConsoleCommand(target, 'const next = 2;');
    assert.strictEqual(controller.inputCount, 1);
  });

  it('진행 중인 복원은 유지하고 진행이 멈춘 경우에만 대기를 종료한다', async () => {
    const clock = sinon.useFakeTimers();
    let finishConnect: (() => void)|undefined;
    try {
      const {controller, model, script, target} = prepare('node');
      controller.configure(() => new Promise<void>(resolve => {
        finishConnect = resolve;
      }));
      controller.setRestartHandler(async () => 'ws://127.0.0.1:9229/new');
      sinon.stub(target.router()!.connection(), 'disconnect').resolves();
      await pause(model, script, 0);
      await pause(model, script, 1);
      await pause(model, script, 0);
      await pause(model, script, 1);
      sinon.stub(model.agent, 'invoke_resume').resolves({getError: () => undefined});
      const result = controller.reverse().then(() => null, error => error);
      await clock.tickAsync(20_000);
      await pause(model, script, 0);
      await clock.tickAsync(20_000);
      assert.isTrue(controller.busy);
      assert.isNull(controller.session.error);
      await clock.tickAsync(10_001);
      assert.include((await result).message, '제한 시간');
      assert.isFalse(controller.busy);
      assert.isFalse(controller.canReverse(model));
    } finally {
      finishConnect?.();
      await clock.tickAsync(0);
      clock.restore();
    }
  });
});

function prepare(kind: Replay.ReplayEndpoint.TargetKind) {
  const controller = new Replay.ReplayController.ReplayController();
  controllers.add(controller);
  controller.configure(async () => {});
  const target = createTarget();
  const model = target.model(SDK.DebuggerModel.DebuggerModel)!;
  const scriptId = 'script' as Protocol.Runtime.ScriptId;
  const expression = 'debugger;\nconst value = 1;';
  const url = (kind === 'node' ? 'file:///user-cli.js' : '') as SDK.Script.Script['sourceURL'];
  const script = new SDK.Script.Script(
      model, scriptId, url, 0, 0, 1, 16, 1, 'hash', false, false, undefined, false, expression.length, null, null,
      null, null, null, null);
  sinon.stub(model.agent, 'invoke_getScriptSource').resolves({scriptSource: expression, getError: () => undefined});
  sinon.stub(model, 'scriptForId').returns(script);
  sinon.stub(model.agent, 'invoke_getPossibleBreakpoints').resolves({
    locations: [0, 1].map(lineNumber => ({scriptId, lineNumber, columnNumber: 0})), getError: () => undefined,
  });
  let id = 0;
  sinon.stub(model.agent, 'invoke_setBreakpoint').callsFake(async ({location}) => ({
    breakpointId: String(id++) as Protocol.Debugger.BreakpointId, actualLocation: location, getError: () => undefined,
  }));
  controller.attach(target);
  return {controller, target, model, script, expression};
}

function recordConsoleCommand(target: SDK.Target.Target, expression: string): void {
  dispatchEvent(target, 'Runtime.executionContextCreated', {
    context: {id: 1, origin: '', name: '', uniqueId: 'context', auxData: {isDefault: true}},
  });
  const context = target.model(SDK.RuntimeModel.RuntimeModel)!.defaultExecutionContext()!;
  target.model(SDK.ConsoleModel.ConsoleModel)!.dispatchEventToListeners(SDK.ConsoleModel.Events.CommandWillBeEvaluated, {
    executionContext: context, expression, useCommandLineAPI: true, userGesture: false,
  });
}

async function pause(model: SDK.DebuggerModel.DebuggerModel, script: SDK.Script.Script, lineNumber: number): Promise<void> {
  await model.pausedScript([{
    callFrameId: 'frame' as Protocol.Debugger.CallFrameId,
    functionName: '',
    location: {scriptId: script.scriptId, lineNumber, columnNumber: 0},
    url: script.sourceURL,
    scopeChain: [],
    this: {type: Protocol.Runtime.RemoteObjectType.Object},
  }], Protocol.Debugger.PausedEventReason.Other, undefined, []);
}
