// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {assert} from 'chai';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import * as path from 'node:path';
import puppeteer, {type Browser, type Page} from 'puppeteer-core';

import {defaultChromePath} from '../../../test/conductor/paths.js';

import type {HistorySnapshot} from './BrowserTestProtocol.js';
import {BrowserTestTarget, type TestTarget} from './BrowserTestTarget.js';
import {serveTestFrontend} from './FrontendTestServer.js';
import {NodeTestTarget} from './NodeTestTarget.js';

const RECORDING_METER = 'pierce/[role="meter"][aria-label="기록 한도 사용률"]';
const LOADING = 'pierce/.backdo-replay-loading:not([hidden])';
const REVERSE_BUTTON = 'pierce/[data-backdo-action="reverse"]';
const UI_TIMEOUT_MS = 15_000;
const REPLAY_TIMEOUT_MS = 35_000;

interface TestSession {
  page: Page;
  source: string;
  entry: string;
  documentRequests: () => number;
  restartCount: () => number;
  pageErrors: string[];
}

describe('기존 콘솔·WebSocket 연결의 공통 재실행', () => {
  let server: Awaited<ReturnType<typeof serveTestFrontend>>|undefined;
  let target: TestTarget|undefined;
  let browser: Browser|undefined;
  let temporaryDirectory: string|undefined;
  let beforeRestart: (() => Promise<void>)|undefined;
  let beforeCalibration: ((page: Page) => Promise<void>)|undefined;
  const calibrationProcesses = new Map<string, TestTarget>();
  const calibrationReports: object[] = [];

  after(async () => {
    if (process.env.BACKDO_CALIBRATION_REPORT) {
      await writeFile(process.env.BACKDO_CALIBRATION_REPORT, JSON.stringify(calibrationReports, null, 2));
    }
  });

  afterEach(async () => {
    await browser?.close();
    for (const process of calibrationProcesses.values()) {
      await process.close();
    }
    calibrationProcesses.clear();
    await target?.close();
    await server?.close();
    if (temporaryDirectory) {
      await rm(temporaryDirectory, {recursive: true, force: true});
    }
    browser = undefined;
    target = undefined;
    server = undefined;
    temporaryDirectory = undefined;
    beforeRestart = undefined;
    beforeCalibration = undefined;
  });

  for (const kind of ['node', 'page'] as const) {
    for (const [fixture, description] of [
      ['for.js', 'for 문의 마지막 조건식으로'],
      ['async-await.js', 'async/await 이후의 마지막 조건식으로'],
      ['for-of-break.js', 'for...of의 break 직전 위치로'],
    ]) {
      if (kind === 'node' && fixture === 'for-of-break.js') {
        continue;
      }
      const input = kind === 'node' ? 'Node ws 직접 연결에서' : '기존 화면의 콘솔 입력에서';
      it(`${input} ${description} 두 번 되돌아간다`, async () => {
        const session = await openSession(kind, fixture);
        const previous = await runToReturn(session);
        verifyFinalCondition(fixture, session.source, previous);

        await reverseAndVerify(session.page, previous);
        const next = await session.page.evaluate(() => window.backdoTest.previous());
        await reverseAndVerify(session.page, next);

        assert.strictEqual(session.restartCount(), 2, '사용자가 요청한 뒤로가기 두 번만 재시작해야 한다');
        assert.strictEqual(session.documentRequests(), 1, '문서 전체를 다시 불러오지 않아야 한다');
        assert.deepEqual(session.pageErrors, [], '브라우저에서 처리되지 않은 오류가 없어야 한다');
      }).timeout(60_000);
    }
  }

  it('inspector 화면에서도 웹페이지의 스크립트를 재실행해 마지막 조건식으로 복원한다', async () => {
    const session = await openSession('page', 'for.js', true, 'page');
    const previous = await runToReturn(session);
    verifyFinalCondition('for.js', session.source, previous);
    await reverseAndVerify(session.page, previous);
    const next = await session.page.evaluate(() => window.backdoTest.previous());
    await reverseAndVerify(session.page, next);
    assert.strictEqual(session.documentRequests(), 1);
    assert.deepEqual(session.pageErrors, []);
  }).timeout(60_000);

  it('앞서 입력한 콘솔 원문도 순서대로 다시 실행하여 전역 준비 코드를 복원한다', async () => {
    const session = await openSession('page', 'for.js', true, 'console', 'globalThis.seed = 2;');
    const previous = await runToReturn(session);
    await reverseAndVerify(session.page, previous);
    const next = await session.page.evaluate(() => window.backdoTest.previous());
    await reverseAndVerify(session.page, next);
    assert.deepEqual(session.pageErrors, []);
  }).timeout(60_000);

  it('재시작 연동 전에도 기존 콘솔 실행과 위치 기록을 유지한다', async () => {
    const session = await openSession('page', 'for.js', false);
    await runToReturn(session);
    const snapshot = await session.page.evaluate(() => window.backdoTest.snapshot());
    assert.isNull(snapshot.error);
    assert.isAbove(await session.page.evaluate(() => window.backdoTest.historyLength()), 2);
    assert.isTrue(await reverseDisabled(session.page));
  }).timeout(60_000);

  it('긴 복원에서도 로딩·패널 이동을 유지하고 CDP 비용에는 실제 실행 시간을 섞지 않는다', async () => {
    let releaseRestart: (() => void)|undefined;
    const gate = new Promise<void>(resolve => { releaseRestart = resolve; });
    const session = await openSession('node', 'for.js');
    const previous = await runToReturn(session);
    beforeRestart = () => gate;
    try {
      await clickReverse(session.page);
      const loading = await session.page.waitForSelector(LOADING, {visible: true});
      if (!loading) {
        assert.fail('복원 중 표시가 보여야 한다');
      }
      assert.isTrue(await reverseDisabled(session.page));
      assert.isFalse(await session.page.evaluate(() => document.body.inert));
      // 이전 구현에서 화면 전환이 만료되던 긴 대기 구간도 실제로 거친다.
      await session.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 4500)));
      const bounds = await loading.boundingBox();
      if (!bounds) {
        assert.fail('복원 중 표시를 화면에서 확인할 수 있어야 한다');
      }
      const firstFrame = await session.page.screenshot({clip: bounds});
      await session.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 200)));
      const nextFrame = await session.page.screenshot({clip: bounds});
      assert.notDeepEqual(firstFrame, nextFrame, '캡처한 화면에서도 로딩이 계속 움직여야 한다');
      const consoleTab = await session.page.waitForSelector('pierce/#tab-console', {visible: true});
      if (!consoleTab) {
        assert.fail('복원 중에도 콘솔 탭이 보여야 한다');
      }
      await consoleTab.click();
      await session.page.waitForSelector('pierce/[aria-label="Console prompt"]', {visible: true});
    } finally {
      releaseRestart?.();
    }
    await waitForReplay(session.page, previous.length);
    const restored = await session.page.evaluate(() => window.backdoTest.snapshot());
    assert.isNull(restored.error);
    assert.strictEqual(await session.page.evaluate(() => window.backdoTest.historyLength()), previous.length - 1);
    assert.isBelow(restored.estimatedReplayMs ?? Infinity, 3000);
    assert.isNull(await session.page.$(LOADING));
    assert.deepEqual(session.pageErrors, []);
  }).timeout(60_000);

  it('더미 측정은 콘솔 준비 코드의 외부 요청을 반복하지 않고 Resume·Step도 막지 않는다', async () => {
    beforeCalibration = async page => {
      await page.waitForSelector(LOADING, {visible: true});
      assert.isFalse(await page.evaluate(() => document.body.inert));
      for (const label of ['Resume script execution', 'Step over next function call']) {
        const button = await page.waitForSelector(`pierce/[aria-label="${label}"]`, {visible: true});
        assert.isFalse(await button?.evaluate(element => element.shadowRoot?.querySelector('button')?.disabled));
      }
    };
    const session = await openSession(
        'page', 'for.js', true, 'console', 'globalThis.seed = 2; await fetch("BACKDO_ORIGIN/effect");');
    assert.strictEqual(server?.effectCount(), 1, '측정을 위해 준비 코드를 다시 실행하면 외부 요청도 늘어난다');
    assert.strictEqual(session.restartCount(), 0);
    assert.isTrue(await session.page.evaluate(() => window.backdoTest.isPaused()));
    assert.deepEqual(session.pageErrors, []);
  }).timeout(60_000);

  it('더미 생성 실패 시 자원을 정리하고 사용자 연결과 정지는 유지한다', async () => {
    beforeCalibration = async () => {
      throw new Error('테스트 더미 준비 실패');
    };
    const session = await openSession('node', 'for.js');
    assert.strictEqual(session.restartCount(), 0);
    assert.strictEqual(calibrationProcesses.size, 0);
    assert.isTrue(await session.page.evaluate(() => window.backdoTest.isPaused()));
    const button = await session.page.$(REVERSE_BUTTON);
    assert.include(await button?.evaluate(element => element.getAttribute('aria-label')), '더미 준비 실패');
    assert.isTrue(await reverseDisabled(session.page));
    assert.isNull(await session.page.$(LOADING));
  }).timeout(60_000);

  it('더미 CDP 연결 실패도 더미만 정리하고 사용자 디버깅을 유지한다', async () => {
    beforeCalibration = async () => {
      for (const dummy of calibrationProcesses.values()) {
        await dummy.close();
      }
    };
    const session = await openSession('node', 'for.js');
    assert.strictEqual(session.restartCount(), 0);
    assert.strictEqual(calibrationProcesses.size, 0);
    assert.isTrue(await session.page.evaluate(() => window.backdoTest.isPaused()));
    const button = await session.page.$(REVERSE_BUTTON);
    assert.include(await button?.evaluate(element => element.getAttribute('aria-label')), 'CDP 연결');
    assert.isTrue(await reverseDisabled(session.page));
    assert.isNull(await session.page.$(LOADING));
    assert.deepEqual(session.pageErrors, []);
  }).timeout(60_000);

  it('소스가 바뀌면 복원을 실패 처리하고 뒤로가기 버튼을 비활성화한다', async () => {
    const session = await openSession('node', 'for.js');
    const previous = await runToReturn(session);
    await writeFile(session.entry, session.source.replace('i < 4', 'i < 5'));

    await clickReverse(session.page);
    await waitForReplay(session.page, previous.length);

    assert.isTrue(await reverseDisabled(session.page));
    const result = await session.page.evaluate(() => window.backdoTest.snapshot());
    assert.match(result.error ?? '', /diverged/);
    const button = await session.page.$(REVERSE_BUTTON);
    assert.include(await button?.evaluate(element => element.getAttribute('aria-label')), '뒤로가기 사용 불가');
    assert.isNull(await session.page.$(LOADING));
    const meter = await session.page.$(RECORDING_METER);
    assert.strictEqual(await meter?.evaluate(element => element.getAttribute('aria-valuenow')), '0');
    assert.include(await meter?.evaluate(element => element.getAttribute('aria-valuetext')), '기록 종료');
    assert.strictEqual(session.documentRequests(), 1);
  }).timeout(60_000);

  function currentTarget(): TestTarget {
    if (!target) {
      throw new Error('실행 중인 테스트 대상이 없습니다.');
    }
    return target;
  }

  async function openSession(
      kind: 'node'|'page', fixture: string, withRestart = true, input: 'console'|'page' = 'console', setup?: string):
      Promise<TestSession> {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'backdo-frontend-'));
    const fixtureSource = await readFile(path.join(__dirname, '../fixtures', fixture), 'utf8');
    const code = setup ? fixtureSource.replace('i * 2', 'i * globalThis.seed') : fixtureSource;
    const source = kind === 'page' ? `debugger;\n${code}` : code;
    const entry = path.join(temporaryDirectory, fixture);
    await writeFile(entry, source);
    server = await serveTestFrontend(source);
    target = kind === 'node' ? new NodeTestTarget({entry, output: null}) : new BrowserTestTarget(server.origin);
    await target.start();
    const initialTarget = {...target.session};
    browser = await puppeteer.launch({
      executablePath: process.env.CHROME_BIN || defaultChromePath(),
      headless: true, defaultViewport: {width: 1440, height: 1000},
      args: ['--no-first-run', '--disable-features=Translate'],
    });
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    let documentRequests = 0;
    page.on('request', request => {
      if (request.resourceType() === 'document') {
        documentRequests++;
      }
    });
    page.on('pageerror', error => pageErrors.push(error.message));
    let connectedWS = target.session.ws;
    let restartCount = 0;
    let calibrationCount = 0;
    let disposedCalibrationCount = 0;
    const calibration: {position: HistorySnapshot['target']|null, pid?: number, port?: number, visiblePauses?: number} = {position: null};
    await page.exposeFunction('createBackDoCalibrationProcess', async (requestedKind: 'node'|'page') => {
      assert.strictEqual(requestedKind, kind);
      calibrationCount++;
      const before = await page.evaluate(() => window.backdoTest.snapshot());
      calibration.position = before.position;
      calibration.visiblePauses = before.visiblePauses.length;
      const dummyEntry = path.join(path.dirname(entry), 'calibration.js');
      await writeFile(dummyEntry, 'setInterval(() => {}, 1000);');
      const dummy = kind === 'node' ? new NodeTestTarget({entry: dummyEntry, output: null, pauseOnStart: false}) :
                                    new BrowserTestTarget(new URL(page.url()).origin);
      try {
        await dummy.start();
        const {ws, pid, port} = dummy.session;
        calibration.pid = pid;
        calibration.port = port;
        assert.notStrictEqual(pid, currentTarget().session.pid, '실제 별도 OS 프로세스여야 한다');
        assert.notStrictEqual(port, currentTarget().session.port, '사용자 연결 포트를 공유하지 않아야 한다');
        calibrationProcesses.set(ws, dummy);
        await beforeCalibration?.(page);
        return ws;
      } catch (error) {
        for (const [ws, owned] of calibrationProcesses) {
          if (owned === dummy) {
            calibrationProcesses.delete(ws);
          }
        }
        await dummy.close();
        throw error;
      }
    });
    await page.exposeFunction('disposeBackDoCalibrationProcess', async (ws: string) => {
      const dummy = calibrationProcesses.get(ws);
      if (dummy) {
        await dummy.close();
        calibrationProcesses.delete(ws);
        disposedCalibrationCount++;
        if (calibration.pid) {
          assert.throws(() => process.kill(calibration.pid ?? 0, 0), /ESRCH/, '더미 프로세스가 종료되어야 한다');
        }
      }
    });
    await page.exposeFunction('restartBackDoTestTarget', async (address: {ws: string, kind: string}) => {
      assert.strictEqual(address.kind, kind);
      assert.strictEqual(address.ws, connectedWS);
      restartCount++;
      await beforeRestart?.();
      connectedWS = (await currentTarget().restart()).ws;
      return connectedWS;
    });
    await page.exposeFunction('discoverBackDoTestTarget', async (port: number) => {
      assert.strictEqual(port, currentTarget().session.port);
      return currentTarget().session.ws;
    });
    const entrypoint = kind === 'node' ? '/js_app.html' : input === 'page' ? '/inspector.html' : '/devtools_app.html';
    const url = new URL(entrypoint, server.origin);
    url.searchParams.set('ws', target.session.ws.replace(/^ws:\/\//, ''));
    await page.goto(url.href, {waitUntil: 'domcontentloaded'});
    await page.addScriptTag({type: 'module', url: `${server.origin}/models/replay/ReplayTestHarness.js`});
    await page.waitForFunction(() => window.backdoTest?.ready(), {timeout: UI_TIMEOUT_MS});
    if (withRestart) {
      await page.evaluate(() => window.backdoTest.useTestLifecycle());
    }
    if (kind === 'page' && target instanceof BrowserTestTarget) {
      if (input === 'page') {
        await target.navigate(`${server.origin}/fixture.html`);
      } else {
        if (setup) {
          await enterConsoleCode(page, setup.replace('BACKDO_ORIGIN', server.origin));
          await page.waitForSelector('pierce/.console-user-command-result', {visible: true});
        }
        await enterConsoleCode(page, source);
      }
    }
    if (withRestart) {
      await page.waitForFunction(() => window.backdoTest.calibrationFinished(), {timeout: UI_TIMEOUT_MS});
      const snapshot = await page.evaluate(() => window.backdoTest.snapshot());
      if (!snapshot.error) {
        assert.isTrue(snapshot.calibrated);
        assert.isAbove(snapshot.estimatedReplayMs ?? 0, 0);
        assert.strictEqual(restartCount, 0);
        assert.strictEqual(calibrationCount, 1);
        assert.strictEqual(disposedCalibrationCount, 1);
        assert.strictEqual(calibrationProcesses.size, 0);
        assert.strictEqual(await page.evaluate(() => window.backdoTest.historyLength()), 1);
        const initialPosition = calibration.position;
        if (!initialPosition) {
          assert.fail('측정 전 최초 정지 위치를 확인할 수 있어야 한다');
        }
        assert.deepEqual(snapshot.position, initialPosition, '측정 후 최초 정지 위치를 유지해야 한다');
        await page.waitForFunction(() => window.backdoTest.snapshot().highlight !== null, {timeout: UI_TIMEOUT_MS});
        const rendered = await page.evaluate(() => window.backdoTest.snapshot());
        assert.deepEqual(rendered.highlight, [initialPosition.lineNumber, initialPosition.columnNumber]);
        assert.lengthOf(snapshot.visiblePauses, calibration.visiblePauses ?? 0, '측정 때문에 사용자 정지가 추가되면 안 된다');
        assert.deepEqual(snapshot.transitions, [], '측정 중에는 사용자 화면 전환이 없어야 한다');
        assert.strictEqual(currentTarget().session.pid, initialTarget.pid);
        assert.strictEqual(currentTarget().session.ws, initialTarget.ws);
        assert.strictEqual(currentTarget().session.port, initialTarget.port);
        assert.isTrue(snapshot.sameDocument);
        assert.isNull(await page.$(LOADING));
        calibrationReports.push({
          kind, input, userPID: initialTarget.pid, userPIDAfter: currentTarget().session.pid,
          userWS: initialTarget.ws, userWSAfter: currentTarget().session.ws,
          dummyPID: calibration.pid, dummyPort: calibration.port, userPort: initialTarget.port,
          userRestarts: restartCount, dummyCreated: calibrationCount, dummyDisposed: disposedCalibrationCount,
          roundTripMs: snapshot.estimatedReplayMs, position: snapshot.position, transitions: snapshot.transitions,
          externalRequests: server?.effectCount(),
        });
      }
    } else {
      await page.waitForFunction(() => window.backdoTest.isPaused(), {timeout: UI_TIMEOUT_MS});
      assert.strictEqual(restartCount, 0);
      assert.strictEqual(calibrationCount, 0);
      assert.isFalse((await page.evaluate(() => window.backdoTest.snapshot())).calibrated);
    }
    assert.isTrue(await reverseDisabled(page));
    return {page, source, entry, documentRequests: () => documentRequests, restartCount: () => restartCount, pageErrors};
  }

  async function enterConsoleCode(page: Page, source: string): Promise<void> {
    const tab = await page.waitForSelector('pierce/#tab-console', {visible: true});
    if (!tab) {
      assert.fail('콘솔 탭을 찾을 수 없습니다.');
    }
    await tab.click();
    const prompt = await page.waitForSelector('pierce/[aria-label="Console prompt"]', {visible: true});
    if (!prompt) {
      assert.fail('콘솔 입력란을 찾을 수 없습니다.');
    }
    await prompt.click();
    await page.keyboard.sendCharacter(source);
    await page.keyboard.press('Enter');
  }

  async function runToReturn(session: TestSession): Promise<HistorySnapshot> {
    const lineNumber = session.source.split('\n').findIndex(line => line.trim() === 'return total;');
    const gutter = await session.page.waitForSelector('pierce/.cm-lineNumbers', {visible: true});
    if (!gutter) {
      assert.fail('소스 에디터의 줄 번호를 찾을 수 없습니다.');
    }
    const lines = await session.page.$$('pierce/.cm-lineNumbers .cm-gutterElement');
    let clicked = false;
    for (const line of lines) {
      if (await line.evaluate((element, expected) => element.textContent === String(expected), lineNumber + 1)) {
        await line.click();
        clicked = true;
        break;
      }
    }
    assert.isTrue(clicked, '사용자가 클릭할 목표 줄 번호가 보여야 한다');
    await session.page.waitForSelector('pierce/.cm-breakpoint', {visible: true});
    const resume = await session.page.waitForSelector('pierce/[aria-label="Resume script execution"]', {visible: true});
    if (!resume) {
      assert.fail('실행 재개 버튼을 찾을 수 없습니다.');
    }
    await resume.click();
    await session.page.waitForFunction(line => window.backdoTest.isPausedAtLine(line), {
      timeout: UI_TIMEOUT_MS,
    }, lineNumber);
    return await session.page.evaluate(() => window.backdoTest.previous());
  }

  function verifyFinalCondition(fixture: string, source: string, previous: HistorySnapshot): void {
    if (fixture === 'for-of-break.js') {
      return;
    }
    const lines = source.split('\n');
    const conditionLine = lines.findIndex(line => line.includes('i <'));
    assert.strictEqual(previous.target.lineNumber, conditionLine);
    assert.strictEqual(previous.target.columnNumber, lines[conditionLine].indexOf('<'));
  }

  async function reverseAndVerify(page: Page, previous: HistorySnapshot): Promise<void> {
    const before = currentTarget().session;
    const initialState = await page.evaluate(() => window.backdoTest.snapshot());
    const meter = await page.waitForSelector(RECORDING_METER);
    if (!meter) {
      assert.fail('기록 한도 사용률이 보여야 한다');
    }
    assert.include(await meter.evaluate(element => element.getAttribute('aria-valuetext')),
        `실행 위치 ${previous.length.toLocaleString('ko-KR')} /`);

    const startedAt = performance.now();
    await clickReverse(page);
    await waitForReplay(page, previous.length);
    const elapsedMs = performance.now() - startedAt;

    const result = await page.evaluate(() => window.backdoTest.snapshot());
    assert.isNull(result.error);
    assert.isNull(await page.$(LOADING));
    assert.include(await meter.evaluate(element => element.getAttribute('aria-valuetext')),
        `실행 위치 ${(previous.length - 1).toLocaleString('ko-KR')} /`);
    assert.closeTo(
        result.estimatedReplayMs ?? Infinity,
        (initialState.estimatedReplayMs ?? 0) * (previous.length - 1) / previous.length, 0.000001,
        '버린 미래 기록만큼 예상 CDP 비용도 줄어야 한다');
    calibrationReports.push({
      action: 'reverse', recordsBefore: previous.length, recordsAfter: previous.length - 1,
      estimatedCDPMs: initialState.estimatedReplayMs, actualRestoreMs: elapsedMs,
    });
    assert.deepEqual(result.position, previous.target);
    assert.deepEqual(result.highlight, [previous.target.lineNumber, previous.target.columnNumber]);
    assert.deepEqual(result.messages, []);
    assert.isTrue(result.sameDocument);
    assert.isTrue(result.sameTimeOrigin);
    assert.isTrue(result.sameHistoryLength);
    assert.deepEqual(result.historyState, {backdoTest: 'preserve'});
    assert.lengthOf(result.visiblePauses, initialState.visiblePauses.length + 1, '최종 정지만 UI에 전달되어야 한다');
    assert.strictEqual(result.transitions.at(-1), 'ready');
    const after = currentTarget().session;
    assert.notStrictEqual(after.pid, before.pid);
    assert.notStrictEqual(after.ws, before.ws);
    assert.strictEqual(after.port, before.port);
    assert.strictEqual(result.ws, after.ws.replace(/^ws:\/\//, ''));
    console.log(`    뒤로가기 완료: ${Math.round(elapsedMs)}ms`);
  }

  async function reverseDisabled(page: Page): Promise<boolean> {
    const button = await page.waitForSelector(REVERSE_BUTTON);
    if (!button) {
      assert.fail('뒤로가기 버튼을 찾을 수 없습니다.');
    }
    return await button.evaluate(element => element.shadowRoot?.querySelector('button')?.disabled === true);
  }

  async function clickReverse(page: Page): Promise<void> {
    const button = await page.waitForSelector(REVERSE_BUTTON);
    if (!button) {
      assert.fail('뒤로가기 버튼을 찾을 수 없습니다.');
    }
    await button.click();
  }

  async function waitForReplay(page: Page, previousLength: number): Promise<void> {
    await page.waitForFunction(length => window.backdoTest.replayFinished(length), {
      timeout: REPLAY_TIMEOUT_MS,
    }, previousLength);
  }
});
