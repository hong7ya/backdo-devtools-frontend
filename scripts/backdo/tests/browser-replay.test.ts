// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {assert} from 'chai';
import {readFile, writeFile} from 'node:fs/promises';
import * as path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import type {Page} from 'puppeteer-core';

import {addBreakpointForLine, getLineNumberElement, removeBreakpointForLine} from '../../../test/e2e/helpers/sources-helpers.js';

import {enterConsoleCode} from './BrowserTestActions.js';
import {BrowserTestEnvironment, type TestSession} from './BrowserTestEnvironment.js';

const RECORDING_METER = 'pierce/[role="meter"][aria-label="기록 한도 사용률"]';
const LOADING = 'pierce/.backdo-replay-loading:not([hidden])';
const REVERSE_BUTTON = 'pierce/[data-backdo-action="reverse"]';
const UI_TIMEOUT_MS = 15_000;
const REPLAY_TIMEOUT_MS = 35_000;

interface ExpectedPosition {
  lineNumber: number;
  columnNumber: number;
  url?: string;
}

describe('기존 콘솔·WebSocket 연결의 공통 재실행', () => {
  const environment = new BrowserTestEnvironment();

  afterEach(() => environment.close());

  for (const kind of ['node', 'page'] as const) {
    it(`${kind === 'node' ? 'Node' : '콘솔'}의 더미 측정은 사용자 코드·연결·화면을 유지한다`, async () => {
      environment.beforeCalibration = async page => {
        await page.waitForSelector(LOADING, {visible: true});
        assert.isFalse(await page.evaluate(() => document.body.inert));
        for (const label of ['Resume script execution', 'Step over next function call']) {
          const button = await page.waitForSelector(`pierce/[aria-label="${label}"]`, {visible: true});
          assert.isFalse(await button?.evaluate(element => element.shadowRoot?.querySelector('button')?.disabled));
        }
      };
      const session = await environment.open({
        kind, fixture: 'for.js',
        setup: kind === 'page' ? 'globalThis.seed = 2; await fetch("BACKDO_ORIGIN/effect");' : undefined,
      });
      const snapshot = await session.page.evaluate(() => window.backdoTest.snapshot());
      const target = environment.target;
      assert.isNull(snapshot.error);
      assert.isTrue(snapshot.calibrated);
      assert.isAbove(snapshot.estimatedReplayMs ?? 0, 0);
      assert.strictEqual(session.restartCount(), 0);
      assert.strictEqual(target.pid, session.initialTarget.pid);
      assert.strictEqual(target.ws, session.initialTarget.ws);
      assert.deepInclude(environment.calibrations, {calibrationsCreated: 1, calibrationsDisposed: 1, calibrations: 0});
      assert.strictEqual(environment.effects, kind === 'page' ? 1 : 0, '측정 때문에 사용자 외부 요청이 반복되면 안 된다');
      if (kind === 'node') {
        assert.strictEqual(await readFile(session.marker, 'utf8').catch(() => ''), '', '측정 중 사용자 코드는 실행하지 않는다');
      }
      await session.page.waitForFunction(() => window.backdoTest.snapshot().highlight !== null);
      const rendered = await session.page.evaluate(() => window.backdoTest.snapshot());
      assert.deepEqual(rendered.highlight, [snapshot.position?.lineNumber, snapshot.position?.columnNumber]);
      assert.deepEqual(rendered.transitions, [], '측정은 화면을 전환하지 않는다');
      assert.isTrue(rendered.sameDocument);
      assert.strictEqual(await session.page.evaluate(() => window.backdoTest.historyLength()), 1);
      assert.isTrue(await reverseDisabled(session.page));
      assert.deepEqual(session.pageErrors, []);
    }).timeout(60_000);

    for (const fixture of ['modules-static.mjs', 'modules-dynamic.js']) {
      it(`${kind === 'node' ? 'Node' : 'inspector 웹페이지'}의 ${fixture}에서 모듈을 넘어 거꾸로간다`, async () => {
        const session = await environment.open({kind, fixture, input: 'page'});
        const helper = await readFile(path.join(__dirname, '../fixtures/modules-helper.mjs'), 'utf8');
        const lines = helper.split('\n');
        const firstPause = lines.findIndex(line => line.trim() === 'debugger;');
        const lastPause = lines.map(line => line.trim()).lastIndexOf('debugger;');
        const control = await session.page.waitForSelector('pierce/.backdo-replay-control');
        assert.isNotNull(control);
        await control?.hover();
        assert.include(await control?.evaluate(element => element.getAttribute('title')), '기록된 이전 실행 위치');
        assert.isTrue(await control?.evaluate(element => element.matches(':hover')));

        await resumeToHelper(firstPause);
        const caller = {...positionIn(session.source, 'forExample();'), url: kind === 'node' ? fixture : 'fixture.js'};
        await reverseAndVerify(session.page, caller);

        await resumeToHelper(firstPause);
        await resumeToHelper(lastPause);
        await reverseAndVerify(session.page, {...positionIn(helper, 'for (let', '<'), url: 'modules-helper.mjs'});

        await resumeToHelper(lastPause);
        await clickExecutionButton(session.page, 'Resume script execution');
        await session.page.waitForFunction(url => window.backdoTest.isPaused() &&
            window.backdoTest.snapshot().position?.url.endsWith(url), {}, caller.url);
        const returned = positionIn(helper, 'return total;');
        await reverseAndVerify(session.page, {
          ...returned, columnNumber: lines[returned.lineNumber].length, url: 'modules-helper.mjs',
        });
        await reverseAndVerify(session.page, {...returned, url: 'modules-helper.mjs'});
        assert.deepEqual(session.pageErrors, []);

        async function resumeToHelper(line: number): Promise<void> {
          await clickExecutionButton(session.page, 'Resume script execution');
          await session.page.waitForFunction(expected => window.backdoTest.snapshot().error ||
              window.backdoTest.isPausedAtLine(expected) &&
              window.backdoTest.snapshot().position?.url.endsWith('modules-helper.mjs'), {}, line);
          assert.isNull((await session.page.evaluate(() => window.backdoTest.snapshot())).error);
        }
      }).timeout(60_000);
    }

    it(`${kind === 'node' ? 'Node 포트 연결' : '기존 콘솔 입력'}에서 정지 중 변수 조회·수정 후에도 거꾸로갈 수 있다`, async () => {
      const session = await environment.open({kind, fixture: 'for.js'});
      const historyLength = await runToReturn(session);
      assert.strictEqual(await evaluateInConsole(session.page, 'total'), '12');
      assert.strictEqual(await evaluateInConsole(session.page, 'total += 1'), '13');
      assert.strictEqual(await evaluateInConsole(session.page, 'total'), '13');
      assert.strictEqual(await session.page.evaluate(() => window.backdoTest.historyLength()), historyLength);

      const sourcesTab = await session.page.waitForSelector('pierce/#tab-sources', {visible: true});
      if (!sourcesTab) {
        assert.fail('소스 탭을 찾을 수 없습니다.');
      }
      await sourcesTab.click();
      assert.isFalse(await reverseDisabled(session.page));
      await reverseAndVerify(session.page, positionIn(session.source, 'for (let', '<'));
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
        const session = await environment.open({kind, fixture});
        await runToReturn(session);
        const positions = fixture === 'for-of-break.js' ?
            [positionIn(session.source, 'break;'), positionIn(session.source, 'if (value')] :
            [positionIn(session.source, 'for (let', '<'), positionIn(session.source, 'for (let', '+= 1')];
        for (const position of positions) {
          await reverseAndVerify(session.page, position);
        }

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

  it('실행이 끝난 콘솔 코드의 기록을 다음 입력 뒤에도 유지하고 동적 소스로 돌아간다', async () => {
    const session = await environment.open({kind: 'page', fixture: 'completed-source.js'});
    await clickExecutionButton(session.page, 'Resume script execution');
    await session.page.waitForSelector('pierce/.console-user-command-result', {visible: true});
    const completedHistoryLength = await session.page.evaluate(() => window.backdoTest.historyLength());
    assert.isAbove(completedHistoryLength, 1);

    await enterConsoleCode(session.page, 'debugger;');
    await session.page.waitForFunction(() => window.backdoTest.isPaused());
    assert.isAbove(await session.page.evaluate(() => window.backdoTest.historyLength()), completedHistoryLength);
    await reverseAndVerify(session.page, {...positionIn(session.source, '}', '}'), url: 'backdo-console:///1'});
    await reverseAndVerify(session.page, {
      url: 'https://example.test/completed-source.js', lineNumber: 1, columnNumber: 'Math.abs(-2);'.indexOf('abs'),
    });
    assert.deepEqual(session.pageErrors, []);
  }).timeout(60_000);

  it('UI에서 추가·삭제한 줄 중단점과 Step over·Resume을 함께 사용할 수 있다', async () => {
    const session = await environment.open({kind: 'page', fixture: 'for.js'});
    const bodyLine = session.source.split('\n').findIndex(line => line.includes('const doubled'));
    await addBreakpointForLine(session.page, bodyLine + 1);
    await clickExecutionButton(session.page, 'Resume script execution');
    await session.page.waitForFunction(line => window.backdoTest.isPausedAtLine(line), {}, bodyLine);
    await clickExecutionButton(session.page, 'Step over next function call');
    await session.page.waitForFunction(line => window.backdoTest.isPausedAtLine(line), {}, bodyLine + 1);

    await removeBreakpointForLine(session.page, bodyLine + 1);
    await runToReturn(session);
    await reverseAndVerify(session.page, positionIn(session.source, 'for (let', '<'));
    assert.deepEqual(session.pageErrors, []);
  }).timeout(60_000);

  it('UI에서 추가한 XHR/fetch 중단점을 기록용 정지로 넘기지 않는다', async () => {
    const session = await environment.open({kind: 'page', fixture: 'fetch.js', input: 'console', setup: 'globalThis.endpoint = "BACKDO_ORIGIN/effect";'});
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
    assert.strictEqual(environment.effects, 0, '사용자가 재개하기 전에는 요청을 보내면 안 된다');
    await clickExecutionButton(session.page, 'Resume script execution');
    await session.page.waitForFunction(line => window.backdoTest.isPausedAtLine(line), {}, returnLine);
    await reverseAndVerify(session.page, positionIn(session.source, 'const total', 'before + 1'));
    await session.page.waitForSelector('pierce/[aria-label^="URL contains"]', {visible: true});
    await clickExecutionButton(session.page, 'Resume script execution');
    await session.page.waitForFunction(line => window.backdoTest.isPausedAtLine(line), {}, returnLine);
    assert.deepEqual(session.pageErrors, []);
  }).timeout(60_000);

  it('조건식과 로그포인트는 복원 중 실행하지 않고 복원 후 다음 실행에 다시 적용한다', async () => {
    const session = await environment.open({kind: 'page', fixture: 'breakpoints.js', input: 'console', setup: 'globalThis.seed = 2; globalThis.endpoint = "BACKDO_ORIGIN/effect";'});
    const bodyLine = session.source.split('\n').findIndex(line => line.includes('const doubled'));
    await addConditionalBreakpoint(session.page, bodyLine, '(fetch(globalThis.endpoint), false)', false);
    await addConditionalBreakpoint(session.page, bodyLine + 1, 'fetch(globalThis.endpoint)', true);
    await runToReturn(session);
    assert.strictEqual(environment.effects, 8, '앞으로 실행할 때 조건식과 로그포인트가 각각 네 번 작동해야 한다');
    await reverseAndVerify(session.page, positionIn(session.source, 'for (let', '<'));
    assert.strictEqual(environment.effects, 8, '복원 도중 조건식이나 로그포인트를 다시 평가하면 안 된다');
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
    assert.strictEqual(environment.effects, 16, '복원 후에는 원래 조건식과 로그포인트가 다시 작동해야 한다');
    assert.deepEqual(session.pageErrors, []);
  }).timeout(60_000);

  it('inspector 화면에서도 웹페이지의 스크립트를 재실행해 마지막 조건식으로 복원한다', async () => {
    const session = await environment.open({kind: 'page', fixture: 'for.js', input: 'page'});
    await runToReturn(session);
    await reverseAndVerify(session.page, positionIn(session.source, 'for (let', '<'));
    await reverseAndVerify(session.page, positionIn(session.source, 'for (let', '+= 1'));
    assert.strictEqual(session.documentRequests(), 1);
    assert.deepEqual(session.pageErrors, []);
  }).timeout(60_000);

  it('앞서 입력한 콘솔 원문도 순서대로 다시 실행하여 전역 준비 코드를 복원한다', async () => {
    const session = await environment.open({kind: 'page', fixture: 'for.js', input: 'console', setup: 'globalThis.seed = 2;'});
    await runToReturn(session);
    await reverseAndVerify(session.page, positionIn(session.source, 'for (let', '<'));
    await reverseAndVerify(session.page, positionIn(session.source, 'for (let', '+= 1'));
    assert.deepEqual(session.pageErrors, []);
  }).timeout(60_000);

  it('재시작 연동 전에도 기존 콘솔 실행과 위치 기록을 유지한다', async () => {
    const session = await environment.open({kind: 'page', fixture: 'for.js', restart: false});
    await runToReturn(session);
    const snapshot = await session.page.evaluate(() => window.backdoTest.snapshot());
    assert.isNull(snapshot.error);
    assert.isAbove(await session.page.evaluate(() => window.backdoTest.historyLength()), 2);
    assert.isTrue(await reverseDisabled(session.page));
  }).timeout(60_000);

  it('긴 복원에서도 로딩·패널 이동을 유지하고 CDP 비용에는 실제 실행 시간을 섞지 않는다', async () => {
    let releaseRestart: (() => void)|undefined;
    const gate = new Promise<void>(resolve => { releaseRestart = resolve; });
    const session = await environment.open({kind: 'node', fixture: 'for.js'});
    const historyLength = await runToReturn(session);
    environment.beforeRestart = () => gate;
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
    await waitForReplay(session.page, historyLength);
    const restored = await session.page.evaluate(() => window.backdoTest.snapshot());
    assert.isNull(restored.error);
    assert.strictEqual(await session.page.evaluate(() => window.backdoTest.historyLength()), historyLength - 1);
    assert.isBelow(restored.estimatedReplayMs ?? Infinity, 3000);
    assert.isNull(await session.page.$(LOADING));
    assert.deepEqual(session.pageErrors, []);
  }).timeout(60_000);

  it('더미 생성 실패 시 자원을 정리하고 사용자 연결과 정지는 유지한다', async () => {
    environment.beforeCalibration = async () => {
      throw new Error('테스트 더미 준비 실패');
    };
    const session = await environment.open({kind: 'node', fixture: 'for.js'});
    assert.strictEqual(session.restartCount(), 0);
    assert.strictEqual(environment.calibrations?.calibrations, 0);
    assert.isTrue(await session.page.evaluate(() => window.backdoTest.isPaused()));
    const button = await session.page.$(REVERSE_BUTTON);
    assert.include(await button?.evaluate(element => element.getAttribute('aria-label')), '더미 준비 실패');
    assert.isTrue(await reverseDisabled(session.page));
    assert.isNull(await session.page.$(LOADING));
  }).timeout(60_000);

  it('소스가 바뀌면 복원을 실패 처리하고 뒤로가기 버튼을 비활성화한다', async () => {
    const session = await environment.open({kind: 'node', fixture: 'for.js'});
    const historyLength = await runToReturn(session);
    await writeFile(session.entry, session.source.replace('i < 4', 'i < 5'));

    await clickReverse(session.page);
    await waitForReplay(session.page, historyLength);

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
    const root = await page.waitForSelector('html');
    assert.exists(root);
    const line = await getLineNumberElement(lineNumber + 1, root);
    assert.exists(line, `소스 에디터의 ${lineNumber + 1}번째 줄 번호를 찾지 못했습니다.`);
    return line;
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

  async function runToReturn(session: TestSession): Promise<number> {
    const lineNumber = session.source.split('\n').findIndex(line => line.trim() === 'return total;');
    await addBreakpointForLine(session.page, lineNumber + 1);
    const resume = await session.page.waitForSelector('pierce/[aria-label="Resume script execution"]', {visible: true});
    if (!resume) {
      assert.fail('실행 재개 버튼을 찾을 수 없습니다.');
    }
    await resume.click();
    await session.page.waitForFunction(line => window.backdoTest.isPausedAtLine(line), {
      timeout: UI_TIMEOUT_MS,
    }, lineNumber);
    return await session.page.evaluate(() => window.backdoTest.historyLength());
  }

  function positionIn(source: string, lineText: string, token = lineText): ExpectedPosition {
    const lines = source.split('\n');
    const lineNumber = lines.findIndex(line => line.includes(lineText));
    assert.isAtLeast(lineNumber, 0, `예제에서 해당 줄을 찾을 수 없습니다: ${lineText}`);
    const columnNumber = lines[lineNumber].indexOf(token);
    assert.isAtLeast(columnNumber, 0, `예제에서 해당 표현식을 찾을 수 없습니다: ${token}`);
    return {lineNumber, columnNumber};
  }

  async function reverseAndVerify(page: Page, expected: ExpectedPosition): Promise<void> {
    const historyLength = await page.evaluate(() => window.backdoTest.historyLength());
    const before = environment.target;
    const initialState = await page.evaluate(() => window.backdoTest.snapshot());
    const meter = await page.waitForSelector(RECORDING_METER);
    if (!meter) {
      assert.fail('기록 한도 사용률이 보여야 한다');
    }
    assert.include(await meter.evaluate(element => element.getAttribute('aria-valuetext')),
        `실행 위치 ${historyLength.toLocaleString('ko-KR')} /`);

    const startedAt = performance.now();
    await clickReverse(page);
    await waitForReplay(page, historyLength);
    const elapsedMs = performance.now() - startedAt;

    const result = await page.evaluate(() => window.backdoTest.snapshot());
    assert.isNull(result.error);
    assert.isNull(await page.$(LOADING));
    assert.include(await meter.evaluate(element => element.getAttribute('aria-valuetext')),
        `실행 위치 ${(historyLength - 1).toLocaleString('ko-KR')} /`);
    assert.closeTo(
        result.estimatedReplayMs ?? Infinity,
        (initialState.estimatedReplayMs ?? 0) * (historyLength - 1) / historyLength, 0.000001,
        '버린 미래 기록만큼 예상 CDP 비용도 줄어야 한다');
    assert.exists(result.position);
    assert.deepEqual([result.position.lineNumber, result.position.columnNumber], [expected.lineNumber, expected.columnNumber]);
    assert.deepEqual(result.highlight, [expected.lineNumber, expected.columnNumber]);
    if (expected.url) {
      assert.isTrue(result.position.url.endsWith(expected.url), `복원된 소스: ${result.position.url}`);
    } else {
      assert.strictEqual(result.position.url, initialState.position?.url);
    }
    assert.deepEqual(result.messages, []);
    assert.isTrue(result.sameDocument);
    assert.isTrue(result.sameTimeOrigin);
    assert.isTrue(result.sameHistoryLength);
    assert.deepEqual(result.historyState, {backdoTest: 'preserve'});
    assert.lengthOf(result.visiblePauses, initialState.visiblePauses.length + 1, '최종 정지만 UI에 전달되어야 한다');
    assert.strictEqual(result.transitions.at(-1), 'ready');
    const after = environment.target;
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
