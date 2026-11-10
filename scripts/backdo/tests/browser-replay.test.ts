// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {assert} from 'chai';
import {readFile, writeFile} from 'node:fs/promises';
import * as path from 'node:path';
import type {Page} from 'puppeteer-core';

import {
  addBreakpointForLine,
  getLineNumberElement,
  removeBreakpointForLine
} from '../../../test/e2e/helpers/sources-helpers.js';

import {enterConsoleCode, evaluateInConsole} from './BrowserTestActions.js';
import {BrowserTestEnvironment} from './BrowserTestEnvironment.js';

const RECORDING_METER = 'pierce/[role="meter"][aria-label="CDP 처리 시간 예산 사용률"]';
const LOADING = 'pierce/.backdo-replay-loading:not([hidden])';
const REVERSE_BUTTON = 'pierce/[data-backdo-action="reverse"]';
const UI_TIMEOUT_MS = 15_000;
const REPLAY_TIMEOUT_MS = 35_000;

interface ExpectedPosition {
  lineNumber: number;
  columnNumber: number;
  url?: string;
  source?: string;
}

describe('기존 콘솔·WebSocket 연결의 공통 재실행', () => {
  const environment = new BrowserTestEnvironment();

  afterEach(() => environment.close());

  it('Console 측정은 앞선 입력을 다시 실행하지 않고 현재 대상의 정지를 유지한다', async () => {
    const session = await environment.open({
      kind: 'console',
      fixture: 'for.js',
      setup: origin => [`await fetch("${origin}/effect");`],
    });

    await assertPausedAt(session.page, positionIn(session.source, 'debugger;'));
    assert.strictEqual(environment.effects, 1, '측정 때문에 앞선 입력의 요청이 반복되면 안 된다');
    assert.strictEqual(environment.target.ws, session.initialTarget.ws);
    assert.deepEqual(session.pageErrors, []);
  }).timeout(60_000);

  for (const kind of ['node', 'console'] as const) {
    it(`${kind === 'node' ? 'Node' : 'Console'}: 복원 후 Step·Resume하고 다음 호출에서 다시 거꾸로간다`, async () => {
      const {page, source} = await environment.open({
        kind,
        fixture: 'two-calls.js',
        source: `debugger;
function sum(multiplier) {
  let total = 0;
  for (let i = 0; i < 4; i += 1) {
    total += i * multiplier;
  }
  return total;
}
sum(2);
sum(3);`,
      });
      const returnPosition = positionIn(source, 'return total;');
      const lastCondition = positionIn(source, 'for (let', '<');
      await addLineBreakpoint(page, returnPosition);
      await resumeToNextPause(page);
      await assertPausedAt(page, returnPosition);
      assert.strictEqual(await evaluateInConsole(page, 'total'), '12');

      await reverse(page);

      await assertPausedAt(page, lastCondition);
      assert.strictEqual(await evaluateInConsole(page, 'total'), '12');

      await stepOver(page);
      await assertPausedAt(page, returnPosition);
      await resumeToNextPause(page);

      await assertPausedAt(page, returnPosition);
      assert.strictEqual(await evaluateInConsole(page, 'total'), '18', '다음 호출의 사용자 중단점에서 멈춘다');

      await reverse(page);

      await assertPausedAt(page, lastCondition);
      assert.strictEqual(await evaluateInConsole(page, 'total'), '18', '최근 호출의 직전 상태를 복원한다');
    }).timeout(60_000);
  }

  it('Node: async/await 이후 마지막 조건식과 증가식으로 차례로 돌아간다', async () => {
    const {page, source} = await environment.open({kind: 'node', fixture: 'async-await.js'});
    await addLineBreakpoint(page, positionIn(source, 'return total;'));
    await resumeToNextPause(page);

    await reverse(page);
    await assertPausedAt(page, positionIn(source, 'for (let', '<'));

    await reverse(page);
    await assertPausedAt(page, positionIn(source, 'for (let', '+= 1'));
  }).timeout(60_000);

  it('Console: 반복 방문한 마지막 조건식과 증가식으로 차례로 돌아간다', async () => {
    const {page, source} = await environment.open({kind: 'console', fixture: 'for.js'});
    await addLineBreakpoint(page, positionIn(source, 'return total;'));
    await resumeToNextPause(page);

    await reverse(page);
    await assertPausedAt(page, positionIn(source, 'for (let', '<'));

    await reverse(page);
    await assertPausedAt(page, positionIn(source, 'for (let', '+= 1'));
  }).timeout(60_000);

  it('Console: 반복문을 빠져나온 break와 그 분기 조건으로 차례로 돌아간다', async () => {
    const {page, source} = await environment.open({kind: 'console', fixture: 'for-of-break.js'});
    await addLineBreakpoint(page, positionIn(source, 'return total;'));
    await resumeToNextPause(page);

    await reverse(page);
    await assertPausedAt(page, positionIn(source, 'break;'));

    await reverse(page);
    await assertPausedAt(page, positionIn(source, 'if (value'));
  }).timeout(60_000);

  for (const fixture of ['modules-static.mjs', 'modules-dynamic.js']) {
    it(`Node의 ${fixture}에서 호출자와 모듈 사이를 거꾸로간다`, async () => {
      const {page, source} = await environment.open({
        kind: 'node',
        fixture,
        files: ['modules-helper.mjs'],
        connection: 'ws',
      });
      const helper = await readFile(path.join(__dirname, '../fixtures/modules-helper.mjs'), 'utf8');
      const moduleEntry = {...positionIn(helper, '// 모듈 진입', 'debugger;'), url: 'modules-helper.mjs'};
      const beforeReturn = {...positionIn(helper, '// 반환 직전', 'debugger;'), url: 'modules-helper.mjs'};
      const caller = {...positionIn(source, 'forExample();'), url: fixture};
      const lastCondition = {...positionIn(helper, 'for (let', '<'), url: 'modules-helper.mjs'};
      const callerAfterReturn = {...positionIn(source, 'debugger;'), url: fixture};
      const returnPosition = {...positionIn(helper, 'return total;'), url: 'modules-helper.mjs'};
      const returnEnd = {
        ...returnPosition,
        columnNumber: returnPosition.columnNumber + 'return total;'.length,
      };

      await resumeToNextPause(page);
      await assertPausedAt(page, moduleEntry);
      await reverse(page);
      await assertPausedAt(page, caller);

      await resumeToNextPause(page);
      await assertPausedAt(page, moduleEntry);
      await resumeToNextPause(page);
      await assertPausedAt(page, beforeReturn);
      await reverse(page);
      await assertPausedAt(page, lastCondition);

      await resumeToNextPause(page);
      await assertPausedAt(page, beforeReturn);
      await resumeToNextPause(page);
      await assertPausedAt(page, callerAfterReturn);

      await reverse(page);
      await assertPausedAt(page, returnEnd);
      await reverse(page);
      await assertPausedAt(page, returnPosition);
    }).timeout(60_000);
  }

  it('실행이 끝난 콘솔 코드의 기록을 다음 입력 뒤에도 유지하고 동적 소스로 돌아간다', async () => {
    const dynamicSourceURL = 'https://example.test/completed-source.js';
    const dynamicSource = `Math.abs(-1);
Math.abs(-2);
//# sourceURL=${dynamicSourceURL}`;
    const session = await environment.open({
      kind: 'console',
      fixture: 'completed-source.js',
      source: `debugger;
function runCompletedSource() {
  (0, eval)(\`${dynamicSource}\`);
}
runCompletedSource();`,
    });
    const functionEnd = positionIn(session.source, '}');
    const lastEvaluatedCall = {...positionIn(dynamicSource, 'Math.abs(-2);', 'abs'), url: dynamicSourceURL};
    await clickExecutionButton(session.page, 'Resume script execution');
    await session.page.waitForSelector('pierce/.console-user-command-result', {visible: true});

    await enterConsoleCode(session.page, 'debugger;');
    await session.page.waitForFunction(() => window.backdoTest.isPaused());
    await reverse(session.page);
    await assertPausedAt(session.page, functionEnd);
    await reverse(session.page);
    await assertPausedAt(session.page, lastEvaluatedCall);
    assert.deepEqual(session.pageErrors, []);
  }).timeout(60_000);

  it('사용자가 줄 중단점을 삭제하면 Resume으로 다음 중단점까지 진행한다', async () => {
    const {page, source} = await environment.open({kind: 'console', fixture: 'for.js'});
    const bodyPosition = positionIn(source, 'const doubled', 'i * 2');
    const returnPosition = positionIn(source, 'return total;');
    await addLineBreakpoint(page, bodyPosition);
    await addLineBreakpoint(page, returnPosition);
    await resumeToNextPause(page);
    await assertPausedAt(page, bodyPosition);

    await removeBreakpointForLine(page, bodyPosition.lineNumber + 1);
    await resumeToNextPause(page);

    await assertPausedAt(page, returnPosition);
    assert.strictEqual(await evaluateInConsole(page, 'total'), '12');
  }).timeout(60_000);

  it('복원 후 다음 호출에서도 XHR/fetch 요청을 보내기 전에 멈춘다', async () => {
    const {page, source} = await environment.open({
      kind: 'console',
      fixture: 'fetch.js',
      setup: origin => [`globalThis.endpoint = "${origin}/effect";`],
    });
    const returnPosition = positionIn(source, 'return total;');
    await addLineBreakpoint(page, returnPosition);
    await addXHRBreakpoint(page, '/effect');

    await resumeToNextPause(page);

    assert.strictEqual(await page.evaluate(() => window.backdoTest.pauseReason()), 'XHR');
    assert.strictEqual(environment.effects, 0, '사용자가 재개하기 전에는 요청을 보내면 안 된다');

    await resumeToNextPause(page);
    await assertPausedAt(page, returnPosition);
    await reverse(page);

    await assertPausedAt(page, positionIn(source, 'const total', 'before + 1'));
    const requestsBeforeNextCall = environment.effects;

    await resumeToNextPause(page);
    await assertPausedAt(page, returnPosition);
    await resumeToNextPause(page);

    assert.strictEqual(await page.evaluate(() => window.backdoTest.pauseReason()), 'XHR');
    assert.strictEqual(
        environment.effects, requestsBeforeNextCall, '다음 호출도 사용자가 재개하기 전에는 요청을 보내면 안 된다');

    await resumeToNextPause(page);

    await assertPausedAt(page, returnPosition);
    assert.strictEqual(environment.effects, requestsBeforeNextCall + 1, '재개하면 다음 호출의 요청이 완료된다');
  }).timeout(60_000);

  it('조건식과 로그포인트는 복원 중 실행하지 않고 복원 후 다음 실행에 다시 적용한다', async () => {
    const session = await environment.open(
        {kind: 'console', fixture: 'breakpoints.js', setup: origin => [`globalThis.endpoint = "${origin}/effect";`]});
    const returnPosition = positionIn(session.source, 'return total;');
    const bodyLine = positionIn(session.source, 'const doubled').lineNumber;
    await addLineBreakpoint(session.page, returnPosition);
    await addConditionalBreakpoint(session.page, bodyLine, '(fetch(globalThis.endpoint), false)');
    await addLogpoint(session.page, bodyLine + 1, 'fetch(globalThis.endpoint)');
    await resumeToNextPause(session.page);
    await assertPausedAt(session.page, returnPosition);
    assert.strictEqual(environment.effects, 8, '앞으로 실행할 때 조건식과 로그포인트가 각각 네 번 작동해야 한다');
    await reverse(session.page);
    await assertPausedAt(session.page, positionIn(session.source, 'for (let', '<'));
    assert.strictEqual(environment.effects, 8, '복원 도중 조건식이나 로그포인트를 다시 평가하면 안 된다');
    await session.page.waitForSelector('pierce/.cm-breakpoint-conditional', {visible: true});
    await session.page.waitForSelector('pierce/.cm-breakpoint-logpoint', {visible: true});

    await resumeToNextPause(session.page);
    await assertPausedAt(session.page, returnPosition);
    await resumeToNextPause(session.page);
    await assertPausedAt(session.page, returnPosition);
    assert.strictEqual(environment.effects, 16, '복원 후에는 원래 조건식과 로그포인트가 다시 작동해야 한다');
    assert.deepEqual(session.pageErrors, []);
  }).timeout(60_000);

  it('Chrome을 교체하고 앞선 Console 입력을 순서대로 재실행해 계산 결과를 복원한다', async () => {
    const session = await environment.open({
      kind: 'console',
      fixture: 'for.js',
      setup: () => ['globalThis.seed = 1;', 'globalThis.seed += 2;'],
      source: `debugger;
function sum() {
  let total = 0;
  for (let i = 0; i < 4; i += 1) {
    const doubled = i * globalThis.seed;
    total += doubled;
  }
  return total;
}
sum();`,
    });
    const returnPosition = positionIn(session.source, 'return total;');
    await addLineBreakpoint(session.page, returnPosition);
    await resumeToNextPause(session.page);
    await assertPausedAt(session.page, returnPosition);
    assert.strictEqual(await evaluateInConsole(session.page, 'total'), '18');
    await reverse(session.page);
    await assertPausedAt(session.page, positionIn(session.source, 'for (let', '<'));
    assert.notStrictEqual(environment.target.pid, session.initialTarget.pid, 'Console 실행 Chrome을 교체한다');
    assert.notStrictEqual(environment.target.ws, session.initialTarget.ws);
    assert.strictEqual(await evaluateInConsole(session.page, 'globalThis.seed'), '3');
    assert.strictEqual(
        await evaluateInConsole(session.page, 'total'), '18',
        '앞선 두 입력이 누락되거나 순서가 바뀌면 계산 결과가 달라진다');
    assert.deepEqual(session.pageErrors, []);
  }).timeout(60_000);

  it('소스가 바뀌면 복원을 실패 처리하고 뒤로가기 버튼을 비활성화한다', async () => {
    const session = await environment.open({kind: 'node', fixture: 'for.js'});
    const returnPosition = positionIn(session.source, 'return total;');
    await addLineBreakpoint(session.page, returnPosition);
    await resumeToNextPause(session.page);
    await assertPausedAt(session.page, returnPosition);
    await writeFile(session.entry, session.source.replace('i < 4', 'i < 5'));

    await reverse(session.page);

    assert.isTrue(await reverseDisabled(session.page));
    const result = await session.page.evaluate(() => window.backdoTest.snapshot());
    assert.match(result.error ?? '', /diverged/);
    const button = await session.page.$(REVERSE_BUTTON);
    assert.include(await button?.evaluate(element => element.getAttribute('aria-label')), '뒤로가기 사용 불가');
    assert.isNull(await session.page.$(LOADING));
    const meter = await session.page.$(RECORDING_METER);
    assert.strictEqual(await meter?.evaluate(element => element.getAttribute('aria-valuenow')), '0');
    assert.include(await meter?.evaluate(element => element.getAttribute('aria-valuetext')), '기록 종료');
  }).timeout(60_000);

  async function lineNumberElement(page: Page, lineNumber: number) {
    const root = await page.waitForSelector('html');
    assert.exists(root);
    const line = await getLineNumberElement(lineNumber + 1, root);
    assert.exists(line, `소스 에디터의 ${lineNumber + 1}번째 줄 번호를 찾지 못했습니다.`);
    return line;
  }

  async function addXHRBreakpoint(page: Page, url: string): Promise<void> {
    const section = await page.waitForSelector('pierce/[aria-label="XHR/fetch Breakpoints"][aria-expanded]');
    if (await section?.evaluate(element => element.getAttribute('aria-expanded')) !== 'true') {
      await section?.click();
    }
    await page.locator('pierce/[aria-label="Add XHR/fetch breakpoint"]').click();
    await page.locator('pierce/[aria-label="URL Breakpoint"]').click();
    await page.keyboard.type(url);
    await page.keyboard.press('Enter');
    await page.waitForSelector('pierce/[aria-label^="URL contains"]');
  }

  async function addConditionalBreakpoint(page: Page, lineNumber: number, condition: string): Promise<void> {
    await editBreakpointExpression(page, lineNumber, condition, false);
  }

  async function addLogpoint(page: Page, lineNumber: number, expression: string): Promise<void> {
    await editBreakpointExpression(page, lineNumber, expression, true);
  }

  async function editBreakpointExpression(
      page: Page, lineNumber: number, condition: string, isLogpoint: boolean): Promise<void> {
    await (await lineNumberElement(page, lineNumber)).click({button: 'right'});
    const action = await page.waitForSelector(
        isLogpoint ? 'aria/Add logpoint…' : 'aria/Add conditional breakpoint…', {visible: true});
    assert.exists(action);
    await action.click();
    const dialog = await page.waitForSelector('pierce/.sources-edit-breakpoint-dialog', {visible: true});
    assert.exists(dialog);
    const editor = await dialog.waitForSelector('pierce/[aria-label="Code editor"]', {visible: true});
    assert.exists(editor);
    await editor.focus();
    await page.keyboard.type(condition);
    await page.keyboard.press('Enter');
    await page.waitForSelector(
        isLogpoint ? 'pierce/.cm-breakpoint-logpoint' : 'pierce/.cm-breakpoint-conditional', {visible: true});
  }

  async function clickExecutionButton(page: Page, label: string): Promise<void> {
    await page.locator('pierce/#tab-sources').click();
    const button = await page.waitForSelector(`pierce/[aria-label="${label}"]`, {visible: true});
    if (!button) {
      throw new Error(`${label} 버튼을 찾지 못했습니다.`);
    }
    await button.click();
  }

  async function addLineBreakpoint(page: Page, position: ExpectedPosition): Promise<void> {
    await page.locator('pierce/#tab-sources').click();
    if (position.source) {
      await page.waitForFunction(
          source => window.backdoTest.sourceIsVisible(source), {timeout: UI_TIMEOUT_MS}, position.source);
    }
    await addBreakpointForLine(page, position.lineNumber + 1);
  }

  function positionIn(source: string, lineText: string, token = lineText): ExpectedPosition {
    const lines = source.split('\n');
    const lineNumber = lines.findIndex(line => line.includes(lineText));
    assert.isAtLeast(lineNumber, 0, `예제에서 해당 줄을 찾을 수 없습니다: ${lineText}`);
    const columnNumber = lines[lineNumber].indexOf(token);
    assert.isAtLeast(columnNumber, 0, `예제에서 해당 표현식을 찾을 수 없습니다: ${token}`);
    return {lineNumber, columnNumber, source};
  }

  async function assertPausedAt(page: Page, expected: ExpectedPosition): Promise<void> {
    await page.waitForFunction(({lineNumber, columnNumber, url, source}) => {
      const {error, highlight, source: displayed} = window.backdoTest.snapshot();
      return error ||
          highlight?.[0] === lineNumber && highlight?.[1] === columnNumber && (!url || displayed?.url.endsWith(url)) &&
          (!source || displayed?.text.includes(source.trim()));
    }, {timeout: UI_TIMEOUT_MS}, expected);
    const result = await page.evaluate(() => window.backdoTest.snapshot());
    assert.isNull(result.error);
    assert.deepEqual(result.highlight, [expected.lineNumber, expected.columnNumber]);
    assert.exists(result.source);
    if (expected.url) {
      assert.isTrue(result.source.url.endsWith(expected.url), `화면에서 선택된 소스: ${result.source.url}`);
    }
    if (expected.source) {
      assert.include(result.source.text, expected.source.trim());
    }
    assert.deepEqual(result.messages, []);
  }

  async function reverseDisabled(page: Page): Promise<boolean> {
    const button = await page.waitForSelector(REVERSE_BUTTON);
    if (!button) {
      assert.fail('뒤로가기 버튼을 찾을 수 없습니다.');
    }
    return await button.evaluate(element => element.shadowRoot?.querySelector('button')?.disabled === true);
  }

  async function reverse(page: Page): Promise<void> {
    await page.locator('pierce/#tab-sources').click();
    const previousPause = await page.evaluate(() => window.backdoTest.snapshot().pauseCount);
    const button = await page.waitForSelector(REVERSE_BUTTON);
    if (!button) {
      throw new Error('뒤로가기 버튼을 찾지 못했습니다.');
    }
    await button.click();
    await page.waitForFunction(count => {
      const {error, pauseCount} = window.backdoTest.snapshot();
      return error || pauseCount > count;
    }, {timeout: REPLAY_TIMEOUT_MS}, previousPause);
    await page.waitForSelector(LOADING, {hidden: true, timeout: REPLAY_TIMEOUT_MS});
  }

  async function resumeToNextPause(page: Page): Promise<void> {
    await executeToNextPause(page, 'Resume script execution');
  }

  async function stepOver(page: Page): Promise<void> {
    await executeToNextPause(page, 'Step over next function call');
  }

  async function executeToNextPause(page: Page, label: string): Promise<void> {
    const previousPause = await page.evaluate(() => window.backdoTest.snapshot().pauseCount);
    await clickExecutionButton(page, label);
    await page.waitForFunction(
        count => window.backdoTest.snapshot().pauseCount > count, {timeout: UI_TIMEOUT_MS}, previousPause);
  }
});
