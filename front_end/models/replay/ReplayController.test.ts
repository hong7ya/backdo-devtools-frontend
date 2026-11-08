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

  it('보정된 정지 좌표를 기록하고 재시작 후 후보가 달라도 같은 실제 위치로 돌아간다', async () => {
    const {controller, model, script} = prepare('node');
    const first = {lineNumber: 0, columnNumber: 7};
    const second = {lineNumber: 1, columnNumber: 6};
    const install = model.agent.invoke_setBreakpoint as sinon.SinonStub;
    install.onFirstCall().resolves({breakpointId: '0', actualLocation: {scriptId: script.scriptId, ...first}, getError: () => undefined});
    install.onSecondCall().resolves({breakpointId: '1', actualLocation: {scriptId: script.scriptId, ...second}, getError: () => undefined});
    controller.setCalibrationHandler(async () => 1);
    controller.setRestartHandler(async () => 'ws://127.0.0.1:9229/restarted');
    controller.configure(async () => {
      const restarted = prepare('node', controller);
      (restarted.model.agent.invoke_getPossibleBreakpoints as sinon.SinonStub).resolves({
        locations: [first, second].map(location => ({scriptId: restarted.script.scriptId, ...location})),
        getError: () => undefined,
      });
      await pause(restarted.model, restarted.script, first);
    });

    await pause(model, script, first);
    await pause(model, script, second);
    assert.isTrue(controller.canReverse(model));
    assert.deepInclude(controller.currentPosition, second);
    assert.deepInclude(controller.session.history.previous().target, first);
    await controller.reverse();
    assert.isNull(controller.session.error);
    assert.deepInclude(controller.currentPosition, first);
    assert.lengthOf(controller.session.history, 1);
  });

  it('보정된 위치로 다시 설치해도 실제 정지 순서가 달라지면 복원을 실패 처리한다', async () => {
    const prepared = prepare('node');
    const {controller, model, script} = prepared;
    await calibrate(prepared);
    await pause(model, script, 1);
    controller.configure(async () => {
      const restarted = prepare('node', controller);
      const changed = {scriptId: restarted.script.scriptId, lineNumber: 0, columnNumber: 7};
      (restarted.model.agent.invoke_setBreakpoint as sinon.SinonStub)
          .onFirstCall().resolves({breakpointId: '0', actualLocation: changed, getError: () => undefined});
      await pause(restarted.model, restarted.script, changed);
    });

    const error = await controller.reverse().then(() => null, error => error);
    assert.include(error.message, 'Replay diverged');
    assert.include(controller.status, 'Replay diverged');
    assert.lengthOf(controller.session.history, 0);
  });

  for (const sharedId of [false, true]) {
    it(`여러 후보가 같은 위치로 보정되면 ${sharedId ? '기존 ID를 보존한다' : '추가 ID만 제거한다'}`, async () => {
      const {controller, model, script} = prepare('node');
      const remove = model.agent.invoke_removeBreakpoint as sinon.SinonStub;
      const first = {scriptId: script.scriptId, lineNumber: 0, columnNumber: 7};
      const second = {scriptId: script.scriptId, lineNumber: 1, columnNumber: 6};
      (model.agent.invoke_getPossibleBreakpoints as sinon.SinonStub).resolves({
        locations: [
          {...first, columnNumber: 0}, {...first, columnNumber: 1}, first,
          {...first, columnNumber: 0}, {...second, columnNumber: 0},
        ],
        getError: () => undefined,
      });
      const install = model.agent.invoke_setBreakpoint as sinon.SinonStub;
      install.onCall(0).resolves({breakpointId: '0', actualLocation: first, getError: () => undefined});
      install.onCall(1).resolves({breakpointId: sharedId ? '0' : 'duplicate', actualLocation: first, getError: () => undefined});
      install.onCall(2).resolves({breakpointId: '1', actualLocation: second, getError: () => undefined});

      await pause(model, script, first);
      await pause(model, script, second);
      assert.isNull(controller.session.error);
      assert.lengthOf(controller.session.history, 2);
      assert.strictEqual(controller.recordingUsage.breakpoints, 2);
      assert.strictEqual(install.callCount, 3);
      assert.deepEqual(remove.getCalls().map(call => call.args[0].breakpointId), sharedId ? [] : ['duplicate']);

      controller.dispose();
      assert.sameMembers(
          remove.getCalls().map(call => call.args[0].breakpointId),
          sharedId ? ['script-execution', '0', '1'] : ['duplicate', 'script-execution', '0', '1']);
    });
  }

  it('설치 도중 실패하면 앞서 보정되어 설치된 중단점도 모두 제거한다', async () => {
    const {controller, model, script} = prepare('node');
    const install = model.agent.invoke_setBreakpoint as sinon.SinonStub;
    install.onFirstCall().resolves({
      breakpointId: 'shifted', actualLocation: {scriptId: script.scriptId, lineNumber: 0, columnNumber: 7},
      getError: () => undefined,
    });
    install.onSecondCall().resolves({getError: () => '중단점 설치 실패'});
    await pause(model, script, {lineNumber: 0, columnNumber: 7});
    assert.include(controller.status, '중단점 설치 실패');
    assert.strictEqual(controller.recordingUsage.breakpoints, 0);
    assert.lengthOf(controller.session.history, 0);
    assert.sameMembers(
        (model.agent.invoke_removeBreakpoint as sinon.SinonStub).getCalls().map(call => call.args[0].breakpointId),
        ['script-execution', 'shifted']);
  });

  it('설치 결과가 다른 소스를 가리켜 실패해도 반환된 ID를 제거한다', async () => {
    const {controller, model, script} = prepare('node');
    (model.agent.invoke_setBreakpoint as sinon.SinonStub).onFirstCall().resolves({
      breakpointId: 'wrong-script', actualLocation: {scriptId: 'other-script', lineNumber: 0, columnNumber: 0},
      getError: () => undefined,
    });
    await pause(model, script, 0);
    assert.include(controller.status, '다른 소스에 설치');
    assert.strictEqual(controller.recordingUsage.breakpoints, 0);
    sinon.assert.calledWith(model.agent.invoke_removeBreakpoint as sinon.SinonStub, {breakpointId: 'wrong-script'});
  });

  it('중복 ID 제거가 실패하면 오류를 알리고 해당 ID도 전체 정리에서 다시 제거한다', async () => {
    const {controller, model, script} = prepare('node');
    const actualLocation = {scriptId: script.scriptId, lineNumber: 0, columnNumber: 7};
    const install = model.agent.invoke_setBreakpoint as sinon.SinonStub;
    install.onFirstCall().resolves({breakpointId: '0', actualLocation, getError: () => undefined});
    install.onSecondCall().resolves({breakpointId: 'duplicate', actualLocation, getError: () => undefined});
    const remove = model.agent.invoke_removeBreakpoint as sinon.SinonStub;
    remove.onFirstCall().resolves({getError: () => '중복 중단점 제거 실패'});
    await pause(model, script, actualLocation);
    assert.include(controller.status, '중복 중단점 제거 실패');
    assert.strictEqual(controller.recordingUsage.breakpoints, 0);
    assert.deepEqual(
        remove.getCalls().map(call => call.args[0].breakpointId), ['duplicate', 'script-execution', '0', 'duplicate']);
  });

  it('보정된 debugger 문에서는 Resume 중에도 사용자에게 정지를 보여 준다', async () => {
    const {controller, model, script} = prepare('node');
    const first = {scriptId: script.scriptId, lineNumber: 0, columnNumber: 7};
    const second = {scriptId: script.scriptId, lineNumber: 1, columnNumber: 6};
    (model.agent.invoke_getPossibleBreakpoints as sinon.SinonStub).resolves({
      locations: [
        {...first, columnNumber: 0},
        {...second, columnNumber: 0, type: Protocol.Debugger.BreakLocationType.DebuggerStatement},
      ],
      getError: () => undefined,
    });
    const install = model.agent.invoke_setBreakpoint as sinon.SinonStub;
    install.onFirstCall().resolves({breakpointId: '0', actualLocation: first, getError: () => undefined});
    install.onSecondCall().resolves({breakpointId: '1', actualLocation: second, getError: () => undefined});
    const resume = sinon.stub(model.agent, 'invoke_resume').resolves({getError: () => undefined});
    await pause(model, script, first);
    await model.resume();
    model.resumedScript();
    resume.resetHistory();
    await pause(model, script, second);
    sinon.assert.notCalled(resume);
    assert.isTrue(model.isPaused());
    assert.deepInclude(controller.currentPosition, {lineNumber: 1, columnNumber: 6});
    assert.isNull(controller.session.error);
  });

  for (const kind of ['node', 'page'] as const) {
    it(`${kind === 'node' ? 'Node' : '콘솔'}에서 과거 사용자 소스의 조회 실패도 원인과 함께 알린다`, async () => {
      const prepared = prepare(kind);
      const {controller, model, script, target, expression} = prepared;
      const expired = new SDK.Script.Script(
          model, 'expired' as Protocol.Runtime.ScriptId, 'https://example.test/finished.js' as SDK.Script.Script['sourceURL'],
          0, 0, 1, 16, 1, 'expired-hash', false, false, undefined, false, 24, null, null, null, null, null, null);
      sinon.stub(model, 'scripts').returns([expired]);
      (model.agent.invoke_getPossibleBreakpoints as sinon.SinonStub)
          .withArgs(sinon.match({start: sinon.match({scriptId: expired.scriptId})}))
          .resolves({getError: () => 'Script not found'});
      if (kind === 'page') {
        recordConsoleCommand(target, expression);
        model.dispatchEventToListeners(SDK.DebuggerModel.Events.ParsedScriptSource, script);
      }
      await calibrate(prepared);
      assert.include(controller.status, '중단점 위치를 조회하지 못했습니다');
      assert.include(controller.status, expired.sourceURL);
      assert.include(controller.status, 'Script not found');
      assert.isFalse(controller.canReverse(model));
      assert.lengthOf(controller.session.history, 0);
    });
  }

  it('BackDo 내부 소스는 최초 목록과 실행 직전 모두 중단점을 조회하지 않는다', async () => {
    const prepared = prepare('node');
    const {controller, model, script} = prepared;
    const internal = new SDK.Script.Script(
        model, 'internal' as Protocol.Runtime.ScriptId,
        'backdo-internal:///restore-launch-context.js' as SDK.Script.Script['sourceURL'],
        0, 0, 1, 16, 1, 'internal-hash', false, false, undefined, true, 24, null, null, null, null, null, null);
    sinon.stub(model, 'scripts').returns([internal, script]);
    await calibrate(prepared);
    const usage = controller.recordingUsage;
    (model.scriptForId as sinon.SinonStub).returns(internal);
    sinon.stub(model.agent, 'invoke_resume').resolves({getError: () => undefined});
    await model.pausedScript([], Protocol.Debugger.PausedEventReason.Instrumentation, {scriptId: internal.scriptId}, []);
    const requests = (model.agent.invoke_getPossibleBreakpoints as sinon.SinonStub).getCalls();
    assert.isFalse(requests.some(call => call.args[0].start.scriptId === internal.scriptId));
    assert.deepEqual(controller.recordingUsage, usage);
    assert.isNull(controller.session.error);
  });

  it('현재 정지한 스크립트가 없다는 응답은 기록 실패로 알린다', async () => {
    const {controller, model, script} = prepare('node');
    sinon.stub(model, 'scripts').returns([script]);
    (model.agent.invoke_getPossibleBreakpoints as sinon.SinonStub).resolves({getError: () => 'Script not found'});
    await pause(model, script, 0);
    assert.include(controller.session.error ?? '', 'Script not found');
    assert.isFalse(controller.canReverse(model));
    assert.lengthOf(controller.session.history, 0);
  });

  it('과거 사용자 소스의 연결 오류도 숨기지 않는다', async () => {
    const {controller, model, script} = prepare('node');
    sinon.stub(model, 'scripts').returns([script]);
    (model.agent.invoke_getPossibleBreakpoints as sinon.SinonStub).resolves({getError: () => 'Connection is closed'});
    await pause(model, script, 0);
    assert.include(controller.session.error ?? '', 'Connection is closed');
    assert.lengthOf(controller.session.history, 0);
  });

  it('기록용 중단점과 함께 전달된 XHR 정지도 사용자에게 보여 준다', async () => {
    const prepared = prepare('node');
    const {model, script} = prepared;
    await calibrate(prepared);
    const resume = sinon.stub(model.agent, 'invoke_resume').resolves({getError: () => undefined});
    model.resume();
    model.resumedScript();
    resume.resetHistory();
    await pause(model, script, 1, Protocol.Debugger.PausedEventReason.XHR, ['1']);
    sinon.assert.notCalled(resume);
    assert.strictEqual(model.debuggerPausedDetails()?.reason, Protocol.Debugger.PausedEventReason.XHR);
  });

  it('일반 중단점이 없는 ESM 시작 위치도 프로세스의 시작 정지로 복원한다', async () => {
    const {controller, model, script} = prepare('node');
    const startReason = 'Break on start' as Protocol.Debugger.PausedEventReason;
    (model.agent.invoke_getPossibleBreakpoints as sinon.SinonStub).resolves({
      locations: [{scriptId: script.scriptId, lineNumber: 1, columnNumber: 0}], getError: () => undefined,
    });
    controller.setCalibrationHandler(async () => 1);
    controller.setRestartHandler(async () => 'ws://127.0.0.1:9229/restarted');
    controller.configure(async () => await pause(model, script, 0, startReason, []));
    await pause(model, script, 0, startReason, []);
    await pause(model, script, 1, Protocol.Debugger.PausedEventReason.Other, ['0']);
    assert.isTrue(controller.canReverse(model));
    await controller.reverse();
    assert.isNull(controller.session.error);
    assert.strictEqual(controller.currentPosition?.lineNumber, 0);
  });

  it('같은 위치의 XHR 추가 정지는 표시하되 재실행 방문 횟수에 더하지 않는다', async () => {
    const prepared = prepare('node');
    const {controller, model, script} = prepared;
    await calibrate(prepared);
    sinon.stub(model.agent, 'invoke_resume').resolves({getError: () => undefined});
    await model.resume();
    await pause(model, script, 1);
    const length = controller.session.history.length;
    await pause(model, script, 1, Protocol.Debugger.PausedEventReason.XHR, []);
    assert.strictEqual(model.debuggerPausedDetails()?.reason, Protocol.Debugger.PausedEventReason.XHR);
    assert.strictEqual(controller.session.history.length, length);
    assert.isTrue(controller.canReverse(model));
    await controller.reverse();
    assert.isNull(controller.session.error);
  });

  it('재시작 전에 사용자 중단점을 해제하고 실패해도 복구를 마친 뒤 버튼을 돌려준다', async () => {
    const prepared = prepare('node');
    const {controller, model, script} = prepared;
    await calibrate(prepared);
    await pause(model, script, 1);
    const activation = SDK.UserBreakpoints.UserBreakpoints.instance();
    const changes: boolean[] = [];
    activation.register('test-user-breakpoints', async () => {
      changes.push(activation.suspended);
      assert.isTrue(controller.busy);
    });
    controller.setRestartHandler(async () => {
      assert.isTrue(activation.suspended);
      throw new Error('재시작 실패');
    });
    const error = await controller.reverse().then(() => null, error => error);
    assert.include(error.message, '재시작 실패');
    assert.deepEqual(changes, [true, false]);
    assert.isFalse(controller.busy);
    assert.isFalse(activation.suspended);
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

  it('일시정지 중 콘솔 조회·수정은 재실행 입력에 넣지 않고 거꾸로가기를 유지한다', async () => {
    const prepared = prepare('node');
    const {controller, model, script, target} = prepared;
    await calibrate(prepared);
    await pause(model, script, 1);
    const usage = controller.recordingUsage;
    for (const expression of ['value', 'value = 2']) {
      recordConsoleCommand(target, expression);
      assert.isNull(controller.session.error);
      assert.deepEqual(controller.recordingUsage, usage);
      assert.isTrue(controller.canReverse(model));
    }
    await controller.reverse();
    assert.isNull(controller.session.error);
    assert.lengthOf(controller.session.history, 1);
  });

  it('복원 중 사용자가 콘솔 코드를 실행하면 성공으로 표시하지 않고 종료한다', async () => {
    const {controller, model, script, target} = prepare('node');
    await calibrate({controller, model, script, target});
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

  it('사용자 대기는 기록을 유지하고 예상 CDP 처리가 3초에 도달하면 기록 전체를 종료한다', async () => {
    const clock = sinon.useFakeTimers();
    try {
      const prepared = prepare('node');
      const {controller, model, script} = prepared;
      await calibrate(prepared, 1500);
      sinon.stub(model.agent, 'invoke_resume').resolves({getError: () => undefined});
      await clock.tickAsync(60_000);
      assert.isNull(controller.session.error);
      assert.lengthOf(controller.session.history, 1);

      await model.resume();
      await clock.tickAsync(2600);
      await pause(model, script, 1);
      assert.include(controller.session.error ?? '', '예상 CDP 처리 시간이 3초');
      assert.isFalse(controller.canReverse(model));
      assert.lengthOf(controller.session.history, 0);
      assert.strictEqual(controller.recordingUsage.breakpoints, 0);
      assert.isNull(controller.estimatedReplayMs);
    } finally {
      clock.restore();
    }
  });

  it('최초 왕복 측정값이 3초면 진행 기록을 해제하고 재측정을 반복하지 않는다', async () => {
    const prepared = prepare('node');
    await calibrate(prepared, 3000);
    assert.include(prepared.controller.session.error ?? '', '예상 CDP 처리 시간이 3초');
    assert.isFalse(prepared.controller.calibrating);
    assert.isFalse(prepared.controller.canReverse(prepared.model));
    assert.lengthOf(prepared.controller.session.history, 0);
  });

  it('더미 측정 중에도 Step을 허용하고 교체된 세션에는 늦은 측정 결과를 적용하지 않는다', async () => {
    const {controller, model, script, target} = prepare('node');
    const restart = sinon.stub().resolves('ws://127.0.0.1:9229/new');
    const disconnect = sinon.spy(target.router()!.connection(), 'disconnect');
    const resume = sinon.stub(model.agent, 'invoke_resume').resolves({getError: () => undefined});
    let finish: (ms: number) => void = () => {};
    let signal: AbortSignal|undefined;
    controller.setRestartHandler(restart);
    controller.setCalibrationHandler(cancellation => {
      signal = cancellation;
      return new Promise(resolve => { finish = resolve; });
    });
    await pause(model, script, 0);
    assert.isTrue(controller.calibrating);
    assert.isFalse(controller.busy);
    await model.stepInto();
    sinon.assert.calledOnce(resume);
    await pause(model, script, 1);
    assert.lengthOf(controller.session.history, 2);
    model.globalObjectCleared();
    assert.isTrue(signal?.aborted);
    finish(1);
    await Promise.resolve();
    assert.isFalse(controller.calibrated);
    assert.isNull(controller.estimatedReplayMs);
    sinon.assert.notCalled(restart);
    sinon.assert.notCalled(disconnect);
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
      const prepared = prepare('node');
      const {controller, model, script} = prepared;
      await calibrate(prepared);
      controller.configure(() => new Promise<void>(resolve => {
        finishConnect = resolve;
      }));
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

function prepare(
    kind: Replay.ReplayEndpoint.TargetKind, controller = new Replay.ReplayController.ReplayController()) {
  controllers.add(controller);
  controller.configure(async () => {});
  const target = createTarget();
  const model = target.model(SDK.DebuggerModel.DebuggerModel)!;
  sinon.stub(model.agent, 'invoke_setPauseOnExceptions').resolves({getError: () => undefined});
  sinon.stub(model.agent, 'invoke_removeBreakpoint').resolves({getError: () => undefined});
  sinon.stub(model.agent, 'invoke_setInstrumentationBreakpoint').resolves({
    breakpointId: 'script-execution' as Protocol.Debugger.BreakpointId, getError: () => undefined,
  });
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

async function calibrate(
    {controller, model, script, target}: Pick<ReturnType<typeof prepare>, 'controller'|'model'|'script'|'target'>,
    roundTripMs = 1): Promise<void> {
  controller.setRestartHandler(async () => 'ws://127.0.0.1:9229/new');
  sinon.stub(target.router()!.connection(), 'disconnect').resolves();
  controller.configure(async () => await pause(model, script, 0));
  controller.setCalibrationHandler(async () => roundTripMs);
  await pause(model, script, 0);
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

async function pause(
    model: SDK.DebuggerModel.DebuggerModel, script: SDK.Script.Script,
    position: number|{lineNumber: number, columnNumber: number},
    reason = Protocol.Debugger.PausedEventReason.Other,
    breakpointIds: string[] = [String(typeof position === 'number' ? position : position.lineNumber)]): Promise<void> {
  const location = typeof position === 'number' ? {lineNumber: position, columnNumber: 0} : position;
  await model.pausedScript([{
    callFrameId: 'frame' as Protocol.Debugger.CallFrameId,
    functionName: '',
    location: {scriptId: script.scriptId, ...location},
    url: script.sourceURL,
    scopeChain: [],
    this: {type: Protocol.Runtime.RemoteObjectType.Object},
  }], reason, undefined, breakpointIds);
}
