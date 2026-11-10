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
    const {controller, model, script} = createControllerTarget({kind: 'node'});
    await pause(model, script, 0);
    await pause(model, script, 1);
    assert.lengthOf(controller.session.history, 2);
    assert.strictEqual(controller.recordingUsage.positions, 2);
    assert.isNull(controller.session.error);
    assert.isFalse(controller.canReverse(model));
    assert.include(controller.status, '재시작 연동');
  });

  it('보정된 정지 좌표를 기록하고 재시작 후 후보가 달라도 같은 실제 위치로 돌아간다', async () => {
    const {controller, model, script} = createControllerTarget({kind: 'node'});
    const first = {lineNumber: 0, columnNumber: 7};
    const second = {lineNumber: 1, columnNumber: 6};
    (model.agent.invoke_getPossibleBreakpoints as sinon.SinonStub).resolves({
      locations: [
        {scriptId: script.scriptId, lineNumber: 0, columnNumber: 0},
        {scriptId: script.scriptId, lineNumber: 1, columnNumber: 0},
      ],
      getError: () => undefined,
    });
    const install = model.agent.invoke_setBreakpoint as sinon.SinonStub;
    install.onFirstCall().resolves(
        {breakpointId: '0', actualLocation: {scriptId: script.scriptId, ...first}, getError: () => undefined});
    install.onSecondCall().resolves(
        {breakpointId: '1', actualLocation: {scriptId: script.scriptId, ...second}, getError: () => undefined});
    controller.setCalibrationHandler(async () => 1);
    controller.setRestartHandler(async () => 'ws://127.0.0.1:9229/restarted');
    controller.configure(async () => {
      const restarted = createControllerTarget({kind: 'node', controller});
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
    const prepared = createControllerTarget({kind: 'node'});
    const {controller, model, script} = prepared;
    enableReplay(prepared);
    await pause(model, script, 0);
    await pause(model, script, 1);
    controller.configure(async () => {
      const restarted = createControllerTarget({kind: 'node', controller});
      const changed = {scriptId: restarted.script.scriptId, lineNumber: 0, columnNumber: 7};
      (restarted.model.agent.invoke_setBreakpoint as sinon.SinonStub)
          .onFirstCall()
          .resolves({breakpointId: '0', actualLocation: changed, getError: () => undefined});
      await pause(restarted.model, restarted.script, changed);
    });

    const error = await controller.reverse().then(() => null, error => error);
    assert.include(error.message, 'Replay diverged');
    assert.include(controller.status, 'Replay diverged');
    assert.lengthOf(controller.session.history, 0);
  });

  it('여러 후보가 같은 CDP 중단점으로 보정되어도 실제 정지를 기록할 중단점은 유지한다', async () => {
    const {controller, model, script} = createControllerTarget({kind: 'node'});
    const first = {scriptId: script.scriptId, lineNumber: 0, columnNumber: 7};
    const second = {scriptId: script.scriptId, lineNumber: 1, columnNumber: 6};
    (model.agent.invoke_getPossibleBreakpoints as sinon.SinonStub).resolves({
      locations: [{...first, columnNumber: 0}, {...first, columnNumber: 1}, {...second, columnNumber: 0}],
      getError: () => undefined,
    });
    (model.agent.invoke_setBreakpoint as sinon.SinonStub)
        .callsFake(async ({location}) => ({
                     breakpointId: location.lineNumber === 0 ? 'shared' : 'next',
                     actualLocation: location.lineNumber === 0 ? first : second,
                     getError: () => undefined,
                   }));

    await pause(model, script, first, Protocol.Debugger.PausedEventReason.Other, ['shared']);
    await pause(model, script, second, Protocol.Debugger.PausedEventReason.Other, ['next']);

    assert.isNull(controller.session.error);
    assert.deepInclude(controller.currentPosition, {lineNumber: 1, columnNumber: 6});
    assert.deepInclude(controller.session.history.previous().target, {lineNumber: 0, columnNumber: 7});
    // 같은 ID를 중복이라고 제거하면 실제 대상에서 이 위치의 이후 방문을 놓친다.
    sinon.assert.neverCalledWith(model.agent.invoke_removeBreakpoint as sinon.SinonStub, {breakpointId: 'shared'});
  });

  it('설치 도중 실패하면 앞서 보정되어 설치된 중단점도 모두 제거한다', async () => {
    const {controller, model, script} = createControllerTarget({kind: 'node'});
    const install = model.agent.invoke_setBreakpoint as sinon.SinonStub;
    install.onFirstCall().resolves({
      breakpointId: 'shifted',
      actualLocation: {scriptId: script.scriptId, lineNumber: 0, columnNumber: 7},
      getError: () => undefined,
    });
    install.onSecondCall().resolves({getError: () => '중단점 설치 실패'});
    await pause(model, script, {lineNumber: 0, columnNumber: 7});
    assert.include(controller.status, '중단점 설치 실패');
    assert.strictEqual(controller.recordingUsage.breakpoints, 0);
    assert.lengthOf(controller.session.history, 0);
    assert.isFalse(controller.canReverse(model));
    // 실패 뒤 남은 기록용 중단점이 일반 디버깅을 멈추지 않도록 해제한다.
    sinon.assert.calledWith(model.agent.invoke_removeBreakpoint as sinon.SinonStub, {breakpointId: 'shifted'});
  });

  it('보정된 debugger 문에서는 Resume 중에도 사용자에게 정지를 보여 준다', async () => {
    const {controller, model, script} = createControllerTarget({kind: 'node'});
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

  for (const kind of ['node', 'console'] as const) {
    it(`${kind === 'node' ? 'Node' : '콘솔'}에서 과거 사용자 소스의 조회 실패도 원인과 함께 알린다`, async () => {
      const prepared = createControllerTarget({kind});
      const {controller, model, script, target, expression} = prepared;
      const expired =
          createScript(model, {id: 'expired', url: 'https://example.test/finished.js', hash: 'expired-hash'});
      sinon.stub(model, 'scripts').returns([expired]);
      (model.agent.invoke_getPossibleBreakpoints as sinon.SinonStub)
          .withArgs(sinon.match({start: sinon.match({scriptId: expired.scriptId})}))
          .resolves({getError: () => 'Script not found'});
      if (kind === 'console') {
        recordConsoleCommand(target, expression);
        model.dispatchEventToListeners(SDK.DebuggerModel.Events.ParsedScriptSource, script);
      }
      enableReplay(prepared);
      await pause(model, script, 0);
      assert.include(controller.status, '중단점 위치를 조회하지 못했습니다');
      assert.include(controller.status, expired.sourceURL);
      assert.include(controller.status, 'Script not found');
      assert.isFalse(controller.canReverse(model));
      assert.lengthOf(controller.session.history, 0);
    });
  }

  it('BackDo 내부 소스는 최초 목록과 실행 직전 모두 중단점을 조회하지 않는다', async () => {
    const prepared = createControllerTarget({kind: 'node'});
    const {controller, model, script} = prepared;
    const internal = createScript(model, {
      id: 'internal',
      url: 'backdo-internal:///restore-launch-context.js',
      hash: 'internal-hash',
      hasSourceURL: true,
    });
    sinon.stub(model, 'scripts').returns([internal, script]);
    enableReplay(prepared);
    await pause(model, script, 0);
    const usage = controller.recordingUsage;
    (model.scriptForId as sinon.SinonStub).returns(internal);
    sinon.stub(model.agent, 'invoke_resume').resolves({getError: () => undefined});
    await model.pausedScript(
        [], Protocol.Debugger.PausedEventReason.Instrumentation, {scriptId: internal.scriptId}, []);
    const requests = (model.agent.invoke_getPossibleBreakpoints as sinon.SinonStub).getCalls();
    assert.isFalse(requests.some(call => call.args[0].start.scriptId === internal.scriptId));
    assert.deepEqual(controller.recordingUsage, usage);
    assert.isNull(controller.session.error);
  });

  it('현재 정지한 스크립트가 없다는 응답은 기록 실패로 알린다', async () => {
    const {controller, model, script} = createControllerTarget({kind: 'node'});
    sinon.stub(model, 'scripts').returns([script]);
    (model.agent.invoke_getPossibleBreakpoints as sinon.SinonStub).resolves({getError: () => 'Script not found'});
    await pause(model, script, 0);
    assert.include(controller.session.error ?? '', 'Script not found');
    assert.isFalse(controller.canReverse(model));
    assert.lengthOf(controller.session.history, 0);
  });

  it('과거 사용자 소스의 연결 오류도 숨기지 않는다', async () => {
    const {controller, model, script} = createControllerTarget({kind: 'node'});
    sinon.stub(model, 'scripts').returns([script]);
    (model.agent.invoke_getPossibleBreakpoints as sinon.SinonStub).resolves({getError: () => 'Connection is closed'});
    await pause(model, script, 0);
    assert.include(controller.session.error ?? '', 'Connection is closed');
    assert.lengthOf(controller.session.history, 0);
  });

  it('기록용 중단점과 함께 전달된 XHR 정지도 사용자에게 보여 준다', async () => {
    const prepared = createControllerTarget({kind: 'node'});
    const {model, script} = prepared;
    enableReplay(prepared);
    await pause(model, script, 0);
    const resume = sinon.stub(model.agent, 'invoke_resume').resolves({getError: () => undefined});
    model.resume();
    model.resumedScript();
    resume.resetHistory();
    await pause(model, script, 1, Protocol.Debugger.PausedEventReason.XHR, ['1']);
    sinon.assert.notCalled(resume);
    assert.strictEqual(model.debuggerPausedDetails()?.reason, Protocol.Debugger.PausedEventReason.XHR);
  });

  it('일반 중단점이 없는 ESM 시작 위치도 프로세스의 시작 정지로 복원한다', async () => {
    const {controller, model, script} = createControllerTarget({kind: 'node'});
    const startReason = 'Break on start' as Protocol.Debugger.PausedEventReason;
    (model.agent.invoke_getPossibleBreakpoints as sinon.SinonStub).resolves({
      locations: [{scriptId: script.scriptId, lineNumber: 1, columnNumber: 0}],
      getError: () => undefined,
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
    const prepared = createControllerTarget({kind: 'node'});
    const {controller, model, script} = prepared;
    enableReplay(prepared);
    await pause(model, script, 0);
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
    const prepared = createControllerTarget({kind: 'node'});
    const {controller, model, script} = prepared;
    enableReplay(prepared);
    await pause(model, script, 0);
    await pause(model, script, 1);
    const activation = SDK.UserBreakpoints.UserBreakpoints.instance();
    const observations: Array<{phase: string, busy: boolean, suspended: boolean}> = [];
    activation.register('test-user-breakpoints', async () => {
      await Promise.resolve();
      observations.push({
        phase: activation.suspended ? 'breakpoints-disabled' : 'breakpoints-restored',
        busy: controller.busy,
        suspended: activation.suspended,
      });
    });
    controller.setRestartHandler(async () => {
      observations.push({phase: 'restart', busy: controller.busy, suspended: activation.suspended});
      throw new Error('재시작 실패');
    });

    const error = await controller.reverse().then(() => null, error => error);

    assert.include(error.message, '재시작 실패');
    assert.deepEqual(observations, [
      {phase: 'breakpoints-disabled', busy: true, suspended: true},
      {phase: 'restart', busy: true, suspended: true},
      {phase: 'breakpoints-restored', busy: true, suspended: false},
    ]);
    assert.isFalse(controller.busy);
    assert.isFalse(activation.suspended);
  });

  it('콘솔에서 입력한 익명 소스에 파일 경로 없이 일반 브레이크포인트를 설치한다', async () => {
    const {controller, model, script, target, expression} = createControllerTarget({kind: 'console'});
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
    const prepared = createControllerTarget({kind: 'node'});
    const {controller, model, script, target} = prepared;
    enableReplay(prepared);
    await pause(model, script, 0);
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
    const {controller, model, script, target} = createControllerTarget({kind: 'node'});
    enableReplay({controller, model, script, target});
    await pause(model, script, 0);
    await pause(model, script, 1);
    const result = controller.reverse().then(() => null, error => error);
    recordConsoleCommand(target, 'value = 2');
    assert.include((await result).message, '복원 중 콘솔');
    assert.isFalse(controller.busy);
    assert.isFalse(controller.canReverse(model));
    assert.strictEqual(controller.recordingUsage.positions, 0);
  });

  it('Console 입력·원문·소스 수의 고정 상한으로 기록을 종료하지 않는다', async () => {
    const {controller, target, model, expression} = createControllerTarget({kind: 'console'});
    // 과거 256개 입력·소스 및 2MiB 원문 상한의 재도입을 잡는 경계값이다.
    for (let index = 0; index < 257; index++) {
      recordConsoleCommand(target, expression);
      const script = createScript(model, {id: String(index), length: expression.length});
      model.dispatchEventToListeners(SDK.DebuggerModel.Events.ParsedScriptSource, script);
    }
    await Promise.resolve();
    recordConsoleCommand(target, 'x'.repeat(2 * 1024 * 1024 + 1));
    assert.isNull(controller.session.error);
    assert.strictEqual(controller.inputCount, 258);
    assert.strictEqual(controller.recordingUsage.pendingSources, 257);
  });

  it('사용자 대기는 기록을 유지하고 예상 CDP 처리가 3초에 도달하면 기록 전체를 종료한다', async () => {
    const clock = sinon.useFakeTimers();
    try {
      const prepared = createControllerTarget({kind: 'node'});
      const {controller, model, script} = prepared;
      enableReplay(prepared, {roundTripMs: 1500});
      await pause(model, script, 0);
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
    const prepared = createControllerTarget({kind: 'node'});
    enableReplay(prepared, {roundTripMs: 3000});
    await pause(prepared.model, prepared.script, 0);
    assert.include(prepared.controller.session.error ?? '', '예상 CDP 처리 시간이 3초');
    assert.isFalse(prepared.controller.calibrating);
    assert.isFalse(prepared.controller.canReverse(prepared.model));
    assert.lengthOf(prepared.controller.session.history, 0);
  });

  it('더미 측정이 끝나기 전에도 Step으로 다음 위치를 기록한다', async () => {
    const {controller, model, script} = createControllerTarget({kind: 'node'});
    const resume = sinon.stub(model.agent, 'invoke_resume').resolves({getError: () => undefined});
    controller.setCalibrationHandler(() => new Promise(() => {}));
    await pause(model, script, 0);

    await model.stepInto();
    await pause(model, script, 1);

    sinon.assert.calledOnce(resume);
    assert.isTrue(controller.calibrating);
    assert.isFalse(controller.busy);
    assert.deepInclude(controller.currentPosition, {lineNumber: 1, columnNumber: 0});
    assert.lengthOf(controller.session.history, 2);
  });

  it('실행 컨텍스트가 교체되면 이전 측정의 늦은 결과를 적용하지 않는다', async () => {
    const {controller, model, script} = createControllerTarget({kind: 'node'});
    const measurement = Promise.withResolvers<number>();
    let signal: AbortSignal|undefined;
    controller.setCalibrationHandler(cancellation => {
      signal = cancellation;
      return measurement.promise;
    });
    await pause(model, script, 0);

    model.globalObjectCleared();
    measurement.resolve(1);
    await measurement.promise;

    assert.isTrue(signal?.aborted);
    assert.isFalse(controller.calibrated);
    assert.isNull(controller.estimatedReplayMs);
  });

  it('실행 컨텍스트가 교체되면 이전 입력과 위치를 비우고 새 기록을 받는다', () => {
    const {controller, target, model} = createControllerTarget({kind: 'console'});
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
    const connection = Promise.withResolvers<void>();
    try {
      const prepared = createControllerTarget({kind: 'node'});
      const {controller, model, script} = prepared;
      enableReplay(prepared);
      await pause(model, script, 0);
      controller.configure(() => connection.promise);
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
      connection.resolve();
      await clock.tickAsync(0);
      clock.restore();
    }
  });
});

function createControllerTarget({kind, controller = new Replay.ReplayController.ReplayController()}: {
  kind: Replay.ReplayEndpoint.TargetKind,
  controller?: Replay.ReplayController.ReplayController,
}) {
  controllers.add(controller);
  controller.configure(async () => {});
  const target = createTarget();
  const model = target.model(SDK.DebuggerModel.DebuggerModel)!;
  sinon.stub(model.agent, 'invoke_setPauseOnExceptions').resolves({getError: () => undefined});
  sinon.stub(model.agent, 'invoke_removeBreakpoint').resolves({getError: () => undefined});
  sinon.stub(model.agent, 'invoke_setInstrumentationBreakpoint').resolves({
    breakpointId: 'script-execution' as Protocol.Debugger.BreakpointId,
    getError: () => undefined,
  });
  const scriptId = 'script' as Protocol.Runtime.ScriptId;
  const expression = 'debugger;\nconst value = 1;';
  const url = (kind === 'node' ? 'file:///user-cli.js' : '') as SDK.Script.Script['sourceURL'];
  const script = createScript(model, {id: scriptId, url, length: expression.length});
  sinon.stub(model.agent, 'invoke_getScriptSource').resolves({scriptSource: expression, getError: () => undefined});
  sinon.stub(model, 'scriptForId').returns(script);
  sinon.stub(model.agent, 'invoke_getPossibleBreakpoints').resolves({
    locations: [0, 1].map(lineNumber => ({scriptId, lineNumber, columnNumber: 0})),
    getError: () => undefined,
  });
  let id = 0;
  sinon.stub(model.agent, 'invoke_setBreakpoint').callsFake(async ({location}) => ({
                                                              breakpointId: String(id++) as
                                                                  Protocol.Debugger.BreakpointId,
                                                              actualLocation: location,
                                                              getError: () => undefined,
                                                            }));
  controller.attach(target);
  return {controller, target, model, script, expression};
}

function createScript(
    model: SDK.DebuggerModel.DebuggerModel, {id, url = '', hash = 'hash', hasSourceURL = false, length = 24}: {
      id: string,
      url?: string,
      hash?: string,
      hasSourceURL?: boolean,
      length?: number,
    }): SDK.Script.Script {
  return new SDK.Script.Script(
      model, id as Protocol.Runtime.ScriptId, url as SDK.Script.Script['sourceURL'], 0, 0, 1, 16, 1, hash, false, false,
      undefined, hasSourceURL, length, null, null, null, null, null, null);
}

// 실제 연결 대신 첫 위치 정지를 전달한다. 측정을 시작하는 pause는 각 테스트에서 명시한다.
function enableReplay(
    {controller, model, script, target}:
        Pick<ReturnType<typeof createControllerTarget>, 'controller'|'model'|'script'|'target'>,
    {roundTripMs = 1}: {roundTripMs?: number} = {}): void {
  controller.setRestartHandler(async () => 'ws://127.0.0.1:9229/new');
  sinon.stub(target.router()!.connection(), 'disconnect').resolves();
  controller.configure(async () => await pause(model, script, 0));
  controller.setCalibrationHandler(async () => roundTripMs);
}

function recordConsoleCommand(target: SDK.Target.Target, expression: string): void {
  dispatchEvent(target, 'Runtime.executionContextCreated', {
    context: {id: 1, origin: '', name: '', uniqueId: 'context', auxData: {isDefault: true}},
  });
  const context = target.model(SDK.RuntimeModel.RuntimeModel)!.defaultExecutionContext()!;
  target.model(SDK.ConsoleModel.ConsoleModel)!.dispatchEventToListeners(
      SDK.ConsoleModel.Events.CommandWillBeEvaluated, {
        executionContext: context,
        expression,
        useCommandLineAPI: true,
        userGesture: false,
      });
}

async function pause(
    model: SDK.DebuggerModel.DebuggerModel, script: SDK.Script.Script,
    position: number|{lineNumber: number, columnNumber: number}, reason = Protocol.Debugger.PausedEventReason.Other,
    breakpointIds: string[] = [String(typeof position === 'number' ? position : position.lineNumber)]): Promise<void> {
  const location = typeof position === 'number' ? {lineNumber: position, columnNumber: 0} : position;
  await model.pausedScript(
      [{
        callFrameId: 'frame' as Protocol.Debugger.CallFrameId,
        functionName: '',
        location: {scriptId: script.scriptId, ...location},
        url: script.sourceURL,
        scopeChain: [],
        this: {type: Protocol.Runtime.RemoteObjectType.Object},
      }],
      reason, undefined, breakpointIds);
}
