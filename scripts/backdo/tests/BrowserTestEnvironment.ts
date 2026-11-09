// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {assert} from 'chai';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import * as path from 'node:path';
import puppeteer, {type Browser, type Page} from 'puppeteer-core';

import {defaultChromePath} from '../../../test/conductor/paths.js';

import {enterConsoleCode} from './BrowserTestActions.js';
import type {} from './BrowserTestProtocol.js';
import {serveTestFrontend} from './FrontendTestServer.js';
import {NodeTestTarget} from './NodeTestTarget.js';

interface TargetDetails {
  ws: string;
  pid: number;
  port: number;
  restarts: number;
}
interface CalibrationUsage {
  calibrations: number;
  calibrationsCreated: number;
  calibrationsDisposed: number;
}
interface TestApplication {
  origin: string;
  manager: {get: (id: string) => TargetDetails, usage: CalibrationUsage};
  close: () => Promise<void>;
}
interface SessionOptions {
  kind: 'node'|'console';
  fixture: string;
  restart?: boolean;
  setup?: string;
}
export interface TestSession {
  page: Page;
  source: string;
  entry: string;
  marker: string;
  initialTarget: Omit<TargetDetails, 'restarts'>;
  documentRequests: () => number;
  restartCount: () => number;
  pageErrors: string[];
}

const UI_TIMEOUT_MS = 15_000;

/** 테스트가 만든 화면·API·대상 프로세스의 준비와 정리만 담당한다. */
export class BrowserTestEnvironment {
  #server: Awaited<ReturnType<typeof serveTestFrontend>>|undefined;
  #target: NodeTestTarget|undefined;
  #application: TestApplication|undefined;
  #currentSessionId = '';
  #browser: Browser|undefined;
  #temporaryDirectory: string|undefined;
  beforeRestart: (() => Promise<void>)|undefined;
  beforeCalibration: ((page: Page) => Promise<void>)|undefined;

  get effects(): number {
    return this.#server?.effectCount() ?? 0;
  }

  get calibrations(): CalibrationUsage|undefined {
    return this.#application?.manager.usage;
  }

  async close(): Promise<void> {
    await this.#target?.close();
    await this.#application?.close();
    await this.#browser?.close();
    await this.#server?.close();
    if (this.#temporaryDirectory) {
      await rm(this.#temporaryDirectory, {recursive: true, force: true});
    }
    this.#browser = undefined;
    this.#target = undefined;
    this.#server = undefined;
    this.#application = undefined;
    this.#currentSessionId = '';
    this.#temporaryDirectory = undefined;
    this.beforeRestart = undefined;
    this.beforeCalibration = undefined;
  }

  get target(): TargetDetails {
    if (!this.#application || !this.#currentSessionId) {
      throw new Error('등록된 실제 서버 세션이 없습니다.');
    }
    return this.#application.manager.get(this.#currentSessionId);
  }

  async open({kind, fixture, restart = true, setup}: SessionOptions): Promise<TestSession> {
    this.#temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'backdo-frontend-'));
    const fixtureSource = await readFile(path.join(__dirname, '../fixtures', fixture), 'utf8');
    const code = setup ? fixtureSource.replace('i * 2', 'i * globalThis.seed') : fixtureSource;
    const marker = path.join(this.#temporaryDirectory, '실행 횟수.txt');
    const finished = "process.getBuiltinModule('fs').appendFileSync(process.argv[2], '뒷부분 실행\\n');";
    // 비동기 예제는 함수가 반환한 Promise까지 끝난 뒤 종료 표식을 남긴다.
    const nodeCode = fixture === 'async-await.js' ?
        code.replace('asyncExample();', `asyncExample().then(() => { ${finished} });`) : `${code}\n${finished}`;
    const source = kind === 'console' ? `debugger;\n${code}` :
        `process.getBuiltinModule('fs').appendFileSync(process.argv[2], '진입\\n');\n${nodeCode}`;
    const entry = path.join(this.#temporaryDirectory, fixture);
    await writeFile(entry, source);
    if (fixture.startsWith('modules-')) {
      const helper = await readFile(path.join(__dirname, '../fixtures/modules-helper.mjs'), 'utf8');
      await writeFile(path.join(this.#temporaryDirectory, 'modules-helper.mjs'), helper);
    }
    this.#server = await serveTestFrontend();
    const serverDirectory = process.env.BACKDO_SERVER_DIR || path.resolve(process.cwd(), '../server');
    const {startServer} = require(path.join(serverDirectory, 'app.js'));
    this.#application = await startServer({port: 0});
    if (!this.#application) {
      throw new Error('실제 BackDo 서버를 시작하지 못했습니다.');
    }
    let initialTarget: {ws: string, pid: number, port: number};
    if (kind === 'node') {
      this.#target = new NodeTestTarget({
        entry, args: [marker, '공백 있는 인자', ''], cwd: this.#temporaryDirectory,
        env: {BACKDO_FIRST: '첫 번째', BACKDO_SECOND: '두 번째', BACKDO_RESTORE_CONTEXT: '사용자 값'},
      });
      initialTarget = await this.#target.start();
    } else {
      const response = await fetch(`${this.#application.origin}/ws/open`, {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({port: 0}),
      });
      const opened = await response.json();
      assert.isTrue(response.ok, JSON.stringify(opened));
      initialTarget = {ws: opened.ws, pid: opened.browserPID, port: opened.port};
    }
    this.#browser = await puppeteer.launch({
      executablePath: process.env.CHROME_BIN || defaultChromePath(),
      headless: true, defaultViewport: {width: 1440, height: 1000},
      args: ['--no-first-run', '--disable-features=Translate'],
    });
    const page = await this.#browser.newPage();
    const pageErrors: string[] = [];
    let documentRequests = 0;
    page.on('request', request => { if (request.resourceType() === 'document') {documentRequests++;} });
    page.on('pageerror', error => pageErrors.push(error.message));
    const registered = new Promise<void>(resolve => {
      page.on('response', response => {
        if (response.request().method() === 'POST' && response.url() === `${this.#application?.origin}/sessions` && response.ok()) {
          void response.json().then(result => { this.#currentSessionId = result.id; resolve(); });
        }
      });
    });
    await page.setRequestInterception(true);
    page.on('request', request => {
      void (async () => {
        if (request.method() === 'POST' && request.url().endsWith('/restart')) {await this.beforeRestart?.();}
        if (request.method() === 'POST' && request.url().includes('/calibrations/')) {await this.beforeCalibration?.(page);}
        await request.continue();
      })().catch(async error => {
        await request.respond({
          status: 400, contentType: 'application/json',
          headers: {'Access-Control-Allow-Origin': this.#server?.origin ?? ''},
          body: JSON.stringify({error: error.message}),
        });
      });
    });
    const entrypoint = kind === 'node' ? 'js_app.html' : 'devtools_app.html';
    const url = new URL(`/${entrypoint}`, this.#server.origin);
    url.searchParams.set('backdoServer', restart ? this.#application.origin : 'http://127.0.0.1:1');
    if (kind === 'node' && fixture === 'for.js' && restart) {
      url.searchParams.set('port', String(initialTarget.port));
    } else {
      url.searchParams.set('ws', initialTarget.ws.replace(/^ws:\/\//, ''));
    }
    await page.goto(url.href, {waitUntil: 'domcontentloaded'});
    await page.addScriptTag({type: 'module', url: `${this.#server.origin}/models/replay/ReplayTestHarness.js`});
    await page.waitForFunction(() => window.backdoTest?.ready(), {timeout: UI_TIMEOUT_MS});
    if (restart) {await registered;}
    if (kind === 'console') {
      if (setup) {
        await enterConsoleCode(page, setup.replace('BACKDO_ORIGIN', this.#server.origin));
        await page.waitForSelector('pierce/.console-user-command-result', {visible: true});
      }
      await enterConsoleCode(page, source);
    }
    if (restart) {
      await page.waitForFunction(() => window.backdoTest.calibrationFinished(), {timeout: UI_TIMEOUT_MS});
    } else {
      await page.waitForFunction(() => window.backdoTest.isPaused(), {timeout: UI_TIMEOUT_MS});
    }
    return {page, source, entry, marker, initialTarget, documentRequests: () => documentRequests,
      restartCount: () => this.target.restarts, pageErrors};
  }

}
