// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {assert} from 'chai';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import * as path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import puppeteer, {type Browser, type Page} from 'puppeteer-core';

import {defaultChromePath} from '../../../test/conductor/paths.js';

import type {HistorySnapshot} from './BrowserTestProtocol.js';
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
  let target: NodeTestTarget|undefined;
  let application: {
    origin: string,
    manager: {get: (id: string) => {ws: string, pid: number, port: number, restarts: number}, usage: {calibrations: number, calibrationsCreated: number, calibrationsDisposed: number}},
    close: () => Promise<void>,
  }|undefined;
  let currentSessionId = '';
  let browser: Browser|undefined;
  let temporaryDirectory: string|undefined;
  let beforeRestart: (() => Promise<void>)|undefined;
  let beforeCalibration: ((page: Page) => Promise<void>)|undefined;
  const calibrationReports: object[] = [];

  after(async () => {
    if (process.env.BACKDO_CALIBRATION_REPORT) {
      await writeFile(process.env.BACKDO_CALIBRATION_REPORT, JSON.stringify(calibrationReports, null, 2));
    }
  });

  afterEach(async () => {
    await target?.close();
    await application?.close();
    await browser?.close();
    await server?.close();
    if (temporaryDirectory) {
      await rm(temporaryDirectory, {recursive: true, force: true});
    }
    browser = undefined;
    target = undefined;
    server = undefined;
    application = undefined;
    currentSessionId = '';
    temporaryDirectory = undefined;
    beforeRestart = undefined;
    beforeCalibration = undefined;
  });

  for (const kind of ['node', 'page'] as const) {
    it(`${kind === 'node' ? 'Node 포트 연결' : '기존 콘솔 입력'}에서 정지 중 변수 조회·수정 후에도 거꾸로갈 수 있다`, async () => {
      const session = await openSession(kind, 'for.js');
      const previous = await runToReturn(session);
      assert.strictEqual(await evaluateInConsole(session.page, 'total'), '12');
      assert.strictEqual(await evaluateInConsole(session.page, 'total += 1'), '13');
      assert.strictEqual(await evaluateInConsole(session.page, 'total'), '13');
      assert.strictEqual(await session.page.evaluate(() => window.backdoTest.historyLength()), previous.length);

      const sourcesTab = await session.page.waitForSelector('pierce/#tab-sources', {visible: true});
      if (!sourcesTab) {
        assert.fail('소스 탭을 찾을 수 없습니다.');
      }
      await sourcesTab.click();
      assert.isFalse(await reverseDisabled(session.page));
      await reverseAndVerify(session.page, previous);
      assert.strictEqual(await evaluateInConsole(session.page, 'total'), '12',
          '재실행 결과를 보여 주고 콘솔에서 수동으로 바꾼 값은 다시 적용하지 않아야 한다');
      await sourcesTab.click();
      assert.isFalse(await reverseDisabled(session.page));
      assert.deepEqual(session.pageErrors, []);
    }).timeout(60_000);

    for (const [fixture, description] of [
      ['for.js', 'for 문의 마지막 조건식으로'],
      ['async-await.js', 'async/await 이후의 마지막 조건식으로'],
      ['for-of-break.js', 'for...of의 break 직전 위치로'],
    ]) {
      if (kind === 'node' && fixture === 'for-of-break.js') {
        continue;
      }
      const input = kind === 'node' ? 'Node의 포트 또는 ws 연결에서' : '기존 화면의 콘솔 입력에서';
      it(`${input} ${description} 두 번 되돌아간다`, async () => {
        const session = await openSession(kind, fixture);
        const previous = await runToReturn(session);
        verifyFinalCondition(fixture, session.source, previous);

        await reverseAndVerify(session.page, previous);
        const next = await session.page.evaluate(() => window.backdoTest.previous());
        await reverseAndVerify(session.page, next);

        assert.strictEqual(session.restartCount(), 2, '사용자가 요청한 뒤로가기 두 번만 재시작해야 한다');
        if (kind === 'node') {
          const effects = await readFile(path.join(path.dirname(session.entry), '실행 횟수.txt'), 'utf8');
          assert.strictEqual(effects, '진입\n진입\n진입\n', '측정과 연결 교체 때문에 실행 횟수가 늘면 안 된다');
        }
        assert.strictEqual(session.documentRequests(), 1, '문서 전체를 다시 불러오지 않아야 한다');
        assert.deepEqual(session.pageErrors, [], '브라우저에서 처리되지 않은 오류가 없어야 한다');
      }).timeout(60_000);
    }
  }

  it('UI에서 추가·삭제한 줄 중단점과 Step over·Resume을 함께 사용할 수 있다', async () => {
    const session = await openSession('page', 'for.js');
    const bodyLine = session.source.split('\n').findIndex(line => line.includes('const doubled'));
    await (await lineNumberElement(session.page, bodyLine)).click();
    await session.page.waitForSelector('pierce/.cm-breakpoint', {visible: true});
    await clickExecutionButton(session.page, 'Resume script execution');
    await session.page.waitForFunction(line => window.backdoTest.isPausedAtLine(line), {}, bodyLine);
    await clickExecutionButton(session.page, 'Step over next function call');
    await session.page.waitForFunction(line => window.backdoTest.isPausedAtLine(line), {}, bodyLine + 1);

    await (await lineNumberElement(session.page, bodyLine)).click();
    await session.page.waitForSelector('pierce/.cm-breakpoint', {hidden: true});
    const previous = await runToReturn(session);
    verifyFinalCondition('for.js', session.source, previous);
    await reverseAndVerify(session.page, previous);
    assert.deepEqual(session.pageErrors, []);
  }).timeout(60_000);

  it('UI에서 추가한 XHR/fetch 중단점을 기록용 정지로 넘기지 않는다', async () => {
    const session = await openSession('page', 'fetch.js', true, 'console',
        'globalThis.endpoint = "BACKDO_ORIGIN/effect";');
    const section = await session.page.waitForSelector('pierce/[aria-label="XHR/fetch Breakpoints"][aria-expanded]');
    if (await section?.evaluate(element => element.getAttribute('aria-expanded')) !== 'true') {
      await section?.click();
    }
    const add = await session.page.waitForSelector('pierce/[aria-label="Add XHR/fetch breakpoint"]', {visible: true});
    await add?.click();
    const input = await session.page.waitForSelector('pierce/[aria-label="URL Breakpoint"]', {visible: true});
    await input?.click();
    await session.page.keyboard.type('/effect');
    await session.page.keyboard.press('Enter');
    await session.page.waitForSelector('pierce/[aria-label^="URL contains"]');

    const returnLine = session.source.split('\n').findIndex(line => line.trim() === 'return total;');
    await (await lineNumberElement(session.page, returnLine)).click();
    await clickExecutionButton(session.page, 'Resume script execution');
    await session.page.waitForFunction(line => window.backdoTest.pauseReason() === 'XHR' ||
        window.backdoTest.isPausedAtLine(line), {}, returnLine);
    assert.strictEqual(await session.page.evaluate(() => window.backdoTest.pauseReason()), 'XHR');
    assert.strictEqual(server?.effectCount(), 0, '사용자가 재개하기 전에는 요청을 보내면 안 된다');
    await clickExecutionButton(session.page, 'Resume script execution');
    await session.page.waitForFunction(line => window.backdoTest.isPausedAtLine(line), {}, returnLine);
    const previous = await session.page.evaluate(() => window.backdoTest.previous());
    await reverseAndVerify(session.page, previous);
    await session.page.waitForSelector('pierce/[aria-label^="URL contains"]', {visible: true});
    await clickExecutionButton(session.page, 'Resume script execution');
    await session.page.waitForFunction(line => window.backdoTest.isPausedAtLine(line), {}, returnLine);
    assert.deepEqual(session.pageErrors, []);
  }).timeout(60_000);

  it('조건식과 로그포인트는 복원 중 실행하지 않고 복원 후 다음 실행에 다시 적용한다', async () => {
    const session = await openSession('page', 'breakpoints.js', true, 'console',
        'globalThis.seed = 2; globalThis.endpoint = "BACKDO_ORIGIN/effect";');
    const bodyLine = session.source.split('\n').findIndex(line => line.includes('const doubled'));
    await addConditionalBreakpoint(session.page, bodyLine, '(fetch(globalThis.endpoint), false)', false);
    await addConditionalBreakpoint(session.page, bodyLine + 1, 'fetch(globalThis.endpoint)', true);
    const previous = await runToReturn(session);
    assert.strictEqual(server?.effectCount(), 8, '앞으로 실행할 때 조건식과 로그포인트가 각각 네 번 작동해야 한다');
    await reverseAndVerify(session.page, previous);
    assert.strictEqual(server?.effectCount(), 8, '복원 도중 조건식이나 로그포인트를 다시 평가하면 안 된다');
    await session.page.waitForSelector('pierce/.cm-breakpoint-conditional', {visible: true});
    await session.page.waitForSelector('pierce/.cm-breakpoint-logpoint', {visible: true});

    const returnLine = session.source.split('\n').findIndex(line => line.trim() === 'return total;');
    await clickExecutionButton(session.page, 'Resume script execution');
    await session.page.waitForFunction(line => window.backdoTest.isPausedAtLine(line), {}, returnLine);
    const previousPauseCount = await session.page.evaluate(() => window.backdoTest.snapshot().visiblePauses.length);
    await clickExecutionButton(session.page, 'Resume script execution');
    await session.page.waitForFunction(({line, previousCount}) =>
        window.backdoTest.snapshot().visiblePauses.length > previousCount && window.backdoTest.isPausedAtLine(line),
        {}, {line: returnLine, previousCount: previousPauseCount});
    assert.strictEqual(server?.effectCount(), 16, '복원 후에는 원래 조건식과 로그포인트가 다시 작동해야 한다');
    assert.deepEqual(session.pageErrors, []);
  }).timeout(60_000);

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
    assert.strictEqual(application?.manager.usage.calibrations, 0);
    assert.isTrue(await session.page.evaluate(() => window.backdoTest.isPaused()));
    const button = await session.page.$(REVERSE_BUTTON);
    assert.include(await button?.evaluate(element => element.getAttribute('aria-label')), '더미 준비 실패');
    assert.isTrue(await reverseDisabled(session.page));
    assert.isNull(await session.page.$(LOADING));
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

  function currentTarget() {
    if (!application || !currentSessionId) {
      throw new Error('등록된 실제 서버 세션이 없습니다.');
    }
    return {session: application.manager.get(currentSessionId)};
  }

  async function openSession(
      kind: 'node'|'page', fixture: string, withRestart = true, input: 'console'|'page' = 'console', setup?: string):
      Promise<TestSession> {
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'backdo-frontend-'));
    const fixtureSource = await readFile(path.join(__dirname, '../fixtures', fixture), 'utf8');
    const code = setup ? fixtureSource.replace('i * 2', 'i * globalThis.seed') : fixtureSource;
    const marker = path.join(temporaryDirectory, '실행 횟수.txt');
    const finished = "process.getBuiltinModule('fs').appendFileSync(process.argv[2], '뒷부분 실행\\n');";
    // 비동기 예제는 함수가 반환한 Promise까지 끝난 뒤 종료 표식을 남긴다.
    const nodeCode = fixture === 'async-await.js' ?
        code.replace('asyncExample();', `asyncExample().then(() => { ${finished} });`) : `${code}\n${finished}`;
    const source = kind === 'page' ? `debugger;\n${code}` :
        `process.getBuiltinModule('fs').appendFileSync(process.argv[2], '진입\\n');\n${nodeCode}`;
    const entry = path.join(temporaryDirectory, fixture);
    await writeFile(entry, source);
    server = await serveTestFrontend(source);
    const serverDirectory = process.env.BACKDO_SERVER_DIR || path.resolve(process.cwd(), '../server');
    const {startServer} = require(path.join(serverDirectory, 'app.js'));
    application = await startServer({port: 0});
    if (!application) {
      throw new Error('실제 BackDo 서버를 시작하지 못했습니다.');
    }
    assert.notStrictEqual(server.origin, application.origin, '화면과 프로세스 제어 API는 다른 주소에서 제공해야 한다');
    let initialTarget: {ws: string, pid: number, port: number};
    if (kind === 'node') {
      target = new NodeTestTarget({
        entry, args: [marker, '공백 있는 인자', ''], cwd: temporaryDirectory, output: null,
        env: {BACKDO_FIRST: '첫 번째', BACKDO_SECOND: '두 번째', BACKDO_RESTORE_CONTEXT: '사용자 값'},
      });
      initialTarget = await target.start();
    } else {
      const response = await fetch(`${application.origin}/ws/open`, {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({port: 0}),
      });
      const opened = await response.json();
      assert.isTrue(response.ok, JSON.stringify(opened));
      initialTarget = {ws: opened.ws, pid: opened.browserPID, port: opened.port};
    }
    browser = await puppeteer.launch({
      executablePath: process.env.CHROME_BIN || defaultChromePath(),
      headless: true, defaultViewport: {width: 1440, height: 1000},
      args: ['--no-first-run', '--disable-features=Translate'],
    });
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    let documentRequests = 0;
    page.on('request', request => { if (request.resourceType() === 'document') {documentRequests++;} });
    page.on('pageerror', error => pageErrors.push(error.message));
    const registered = new Promise<void>(resolve => {
      page.on('response', response => {
        if (response.request().method() === 'POST' && response.url() === `${application?.origin}/sessions` && response.ok()) {
          void response.json().then(result => { currentSessionId = result.id; resolve(); });
        }
      });
    });
    await page.setRequestInterception(true);
    page.on('request', request => {
      void (async () => {
        if (request.method() === 'POST' && request.url().endsWith('/restart')) {await beforeRestart?.();}
        if (request.method() === 'POST' && request.url().includes('/calibrations/')) {await beforeCalibration?.(page);}
        await request.continue();
      })().catch(async error => {
        await request.respond({
          status: 400, contentType: 'application/json',
          headers: {'Access-Control-Allow-Origin': server?.origin ?? ''},
          body: JSON.stringify({error: error.message}),
        });
      });
    });
    const entrypoint = kind === 'node' ? 'js_app.html' : input === 'page' ? 'inspector.html' : 'devtools_app.html';
    const url = new URL(`/${entrypoint}`, server.origin);
    url.searchParams.set('backdoServer', withRestart ? application.origin : 'http://127.0.0.1:1');
    if (kind === 'node' && fixture === 'for.js' && withRestart) {
      url.searchParams.set('port', String(initialTarget.port));
    } else {
      url.searchParams.set('ws', initialTarget.ws.replace(/^ws:\/\//, ''));
    }
    await page.goto(url.href, {waitUntil: 'domcontentloaded'});
    await page.addScriptTag({type: 'module', url: `${server.origin}/models/replay/ReplayTestHarness.js`});
    await page.waitForFunction(() => window.backdoTest?.ready(), {timeout: UI_TIMEOUT_MS});
    if (withRestart) {await registered;}
    if (kind === 'page') {
      if (input === 'page') {
        const inspected = await puppeteer.connect({browserURL: `http://127.0.0.1:${initialTarget.port}`});
        const inspectedPage = (await inspected.pages())[0];
        const connection = await inspectedPage.createCDPSession();
        await connection.send('Page.navigate', {url: `${server.origin}/fixture.html`});
        await connection.detach();
        await inspected.disconnect();
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
      assert.strictEqual(currentTarget().session.restarts, 0, '측정은 사용자 대상을 재시작하지 않아야 한다');
      assert.strictEqual(currentTarget().session.pid, initialTarget.pid);
      assert.strictEqual(currentTarget().session.ws, initialTarget.ws);
      if (!snapshot.error) {
        assert.isTrue(snapshot.calibrated);
        assert.isAbove(snapshot.estimatedReplayMs ?? 0, 0);
        assert.strictEqual(await page.evaluate(() => window.backdoTest.historyLength()), 1);
        assert.strictEqual(application.manager.usage.calibrationsCreated, 1);
        assert.strictEqual(application.manager.usage.calibrationsDisposed, 1);
        assert.strictEqual(application.manager.usage.calibrations, 0);
        await page.waitForFunction(() => window.backdoTest.snapshot().highlight !== null, {timeout: UI_TIMEOUT_MS});
        const rendered = await page.evaluate(() => window.backdoTest.snapshot());
        assert.deepEqual(rendered.highlight, [snapshot.position?.lineNumber, snapshot.position?.columnNumber]);
        assert.deepEqual(snapshot.transitions, [], '측정 때문에 화면을 전환하면 안 된다');
        assert.isTrue(snapshot.sameDocument);
        if (kind === 'node') {
          assert.strictEqual(await readFile(marker, 'utf8').catch(() => ''), '', '측정 중 사용자 코드가 실행되면 안 된다');
        }
        calibrationReports.push({kind, input, targetPort: initialTarget.port, userPID: initialTarget.pid,
          userPIDAfter: currentTarget().session.pid, roundTripMs: snapshot.estimatedReplayMs,
          actualServerAPI: true, dummyCreated: application.manager.usage.calibrationsCreated,
          dummyDisposed: application.manager.usage.calibrationsDisposed});
      }
    } else {
      await page.waitForFunction(() => window.backdoTest.isPaused(), {timeout: UI_TIMEOUT_MS});
      assert.isFalse((await page.evaluate(() => window.backdoTest.snapshot())).calibrated);
    }
    assert.isTrue(await reverseDisabled(page));
    return {page, source, entry, documentRequests: () => documentRequests,
      restartCount: () => currentTarget().session.restarts, pageErrors};
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

  async function evaluateInConsole(page: Page, expression: string): Promise<string> {
    const selector = 'pierce/.console-user-command-result';
    const previousCount = (await page.$$(selector)).length;
    await enterConsoleCode(page, expression);
    const deadline = performance.now() + UI_TIMEOUT_MS;
    while (performance.now() < deadline) {
      const results = await page.$$(selector);
      if (results.length > previousCount) {
        return await results[results.length - 1].evaluate(element => element.textContent?.trim() ?? '');
      }
      await delay(20);
    }
    assert.fail(`콘솔 실행 결과를 기다리는 시간이 지났습니다: ${expression}`);
  }

  async function lineNumberElement(page: Page, lineNumber: number) {
    await page.waitForSelector('pierce/.cm-lineNumbers', {visible: true});
    for (const line of await page.$$('pierce/.cm-lineNumbers .cm-gutterElement')) {
      if (await line.evaluate((element, expected) => element.checkVisibility() && element.textContent === String(expected), lineNumber + 1)) {
        return line;
      }
    }
    throw new Error(`소스 에디터의 ${lineNumber + 1}번째 줄 번호를 찾지 못했습니다.`);
  }

  async function addConditionalBreakpoint(page: Page, lineNumber: number, condition: string, isLogpoint: boolean):
      Promise<void> {
    await (await lineNumberElement(page, lineNumber)).click({button: 'right'});
    const action = await page.waitForSelector(isLogpoint ? 'aria/Add logpoint…' : 'aria/Add conditional breakpoint…',
        {visible: true});
    assert.exists(action);
    await action.click();
    const dialog = await page.waitForSelector('pierce/.sources-edit-breakpoint-dialog', {visible: true});
    assert.exists(dialog);
    const editor = await dialog.waitForSelector('pierce/[aria-label="Code editor"]', {visible: true});
    assert.exists(editor);
    await editor.focus();
    await page.keyboard.type(condition);
    await page.keyboard.press('Enter');
    await page.waitForSelector(isLogpoint ? 'pierce/.cm-breakpoint-logpoint' : 'pierce/.cm-breakpoint-conditional',
        {visible: true});
  }

  async function clickExecutionButton(page: Page, label: string): Promise<void> {
    const button = await page.waitForSelector(`pierce/[aria-label="${label}"]`, {visible: true});
    if (!button) {
      throw new Error(`${label} 버튼을 찾지 못했습니다.`);
    }
    await button.click();
  }

  async function runToReturn(session: TestSession): Promise<HistorySnapshot> {
    const lineNumber = session.source.split('\n').findIndex(line => line.trim() === 'return total;');
    await (await lineNumberElement(session.page, lineNumber)).click();
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
