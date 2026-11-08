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

const REVERSE_BUTTON = 'pierce/[data-backdo-action="reverse"]';
const UI_TIMEOUT_MS = 15_000;
const REPLAY_TIMEOUT_MS = 35_000;

interface TestSession {
  page: Page;
  source: string;
  entry: string;
  documentRequests: () => number;
  pageErrors: string[];
}

describe('기존 콘솔·WebSocket 연결의 공통 재실행', () => {
  let server: Awaited<ReturnType<typeof serveTestFrontend>>|undefined;
  let target: TestTarget|undefined;
  let browser: Browser|undefined;
  let temporaryDirectory: string|undefined;

  afterEach(async () => {
    await browser?.close();
    await target?.close();
    await server?.close();
    if (temporaryDirectory) {
      await rm(temporaryDirectory, {recursive: true, force: true});
    }
    browser = undefined;
    target = undefined;
    server = undefined;
    temporaryDirectory = undefined;
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
    await page.exposeFunction('restartBackDoTestTarget', async (address: {ws: string, kind: string}) => {
      assert.strictEqual(address.kind, kind);
      assert.strictEqual(address.ws, connectedWS);
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
          await enterConsoleCode(page, setup);
          await page.waitForSelector('pierce/.console-user-command-result', {visible: true});
        }
        await enterConsoleCode(page, source);
      }
    }
    await page.waitForFunction(() => window.backdoTest.isPaused(), {timeout: UI_TIMEOUT_MS});
    assert.isTrue(await reverseDisabled(page));
    return {page, source, entry, documentRequests: () => documentRequests, pageErrors};
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
    const startedAt = performance.now();

    await clickReverse(page);
    await waitForReplay(page, previous.length);

    const result = await page.evaluate(() => window.backdoTest.snapshot());
    assert.isNull(result.error);
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
    console.log(`    뒤로가기 완료: ${Math.round(performance.now() - startedAt)}ms`);
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
