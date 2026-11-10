// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {assert} from 'chai';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import * as path from 'node:path';
import puppeteer, {type Browser, type Page} from 'puppeteer-core';

import {defaultChromePath} from '../../../test/conductor/paths.js';

import {enterConsoleCode, evaluateInConsole} from './BrowserTestActions.js';
import type {} from './BrowserTestProtocol.js';
import {serveTestFrontend} from './FrontendTestServer.js';
import {NodeTestTarget} from './NodeTestTarget.js';

interface TargetDetails {
  ws: string;
  pid: number;
  port: number;
}
interface TestApplication {
  origin: string;
  manager: {get: (id: string) => TargetDetails};
  close: () => Promise<void>;
}
interface SessionOptions {
  kind: 'node'|'console';
  fixture: string;
  source?: string;
  files?: string[];
  connection?: 'port'|'ws';
  setup?: (origin: string) => string[];
}
export interface TestSession {
  page: Page;
  source: string;
  entry: string;
  initialTarget: TargetDetails;
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

  get effects(): number {
    return this.#server?.effectCount() ?? 0;
  }

  async close(): Promise<void> {
    const errors: unknown[] = [];
    for (const resource of [this.#target, this.#application, this.#browser, this.#server]) {
      try {
        await resource?.close();
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.#temporaryDirectory) {
      try {
        await rm(this.#temporaryDirectory, {recursive: true, force: true});
      } catch (error) {
        errors.push(error);
      }
    }
    this.#browser = undefined;
    this.#target = undefined;
    this.#server = undefined;
    this.#application = undefined;
    this.#currentSessionId = '';
    this.#temporaryDirectory = undefined;
    if (errors.length) {
      throw new AggregateError(errors, '브라우저 테스트 자원 정리 실패');
    }
  }

  get target(): TargetDetails {
    if (!this.#application || !this.#currentSessionId) {
      throw new Error('등록된 실제 서버 세션이 없습니다.');
    }
    return this.#application.manager.get(this.#currentSessionId);
  }

  async open({kind, fixture, source: suppliedSource, files = [], connection = 'port', setup}: SessionOptions):
      Promise<TestSession> {
    this.#temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'backdo-frontend-'));
    const source = suppliedSource ?? await readFile(path.join(__dirname, '../fixtures', fixture), 'utf8');
    const entry = path.join(this.#temporaryDirectory, fixture);
    await writeFile(entry, source);
    for (const filename of files) {
      const content = await readFile(path.join(__dirname, '../fixtures', filename), 'utf8');
      await writeFile(path.join(this.#temporaryDirectory, filename), content);
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
        entry,
        cwd: this.#temporaryDirectory,
        env: {},
      });
      initialTarget = await this.#target.start();
    } else {
      const response = await fetch(`${this.#application.origin}/ws/open`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({port: 0}),
      });
      const opened = await response.json();
      assert.isTrue(response.ok, JSON.stringify(opened));
      initialTarget = {ws: opened.ws, pid: opened.browserPID, port: opened.port};
    }
    this.#browser = await puppeteer.launch({
      executablePath: process.env.CHROME_BIN || defaultChromePath(),
      headless: true,
      defaultViewport: {width: 1440, height: 1000},
      args: ['--no-first-run', '--disable-features=Translate'],
    });
    const page = await this.#browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const registered = page.waitForResponse(
        response =>
            response.request().method() === 'POST' && response.url() === `${this.#application?.origin}/sessions`,
        {timeout: UI_TIMEOUT_MS});
    // 화면 준비가 먼저 실패해도 등록 대기의 거절이 처리되지 않은 채 남지 않게 한다.
    void registered.catch(() => {});
    const entrypoint = kind === 'node' ? 'js_app.html' : 'devtools_app.html';
    const url = new URL(`/${entrypoint}`, this.#server.origin);
    url.searchParams.set('backdoServer', this.#application.origin);
    if (connection === 'port') {
      url.searchParams.set('port', String(initialTarget.port));
    } else {
      url.searchParams.set('ws', initialTarget.ws.replace(/^ws:\/\//, ''));
    }
    await page.goto(url.href, {waitUntil: 'domcontentloaded'});
    await page.addScriptTag({type: 'module', url: `${this.#server.origin}/models/replay/ReplayTestHarness.js`});
    await page.waitForFunction(() => window.backdoTest?.ready(), {timeout: UI_TIMEOUT_MS});
    const registration = await registered;
    const session = await registration.json();
    assert.isTrue(registration.ok(), JSON.stringify(session));
    this.#currentSessionId = session.id;
    if (kind === 'console') {
      for (const input of setup?.(this.#server.origin) ?? []) {
        await evaluateInConsole(page, input);
      }
      await enterConsoleCode(page, source);
    }
    await page.waitForFunction(() => window.backdoTest.calibrationFinished(), {timeout: UI_TIMEOUT_MS});
    return {page, source, entry, initialTarget, pageErrors};
  }
}
