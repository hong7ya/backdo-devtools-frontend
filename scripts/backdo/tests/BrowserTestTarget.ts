// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import puppeteer, {type Browser} from 'puppeteer-core';

import {defaultChromePath} from '../../../test/conductor/paths.js';

export interface TestTarget {
  readonly session: {ws: string, pid: number, port: number};
  start(): Promise<unknown>;
  restart(): Promise<{ws: string}>;
  close(): Promise<void>;
}

/** BackDo 화면과 별개의 Chrome 프로세스를 테스트가 소유하고 재시작한다. */
export class BrowserTestTarget implements TestTarget {
  #browser: Browser|undefined;
  #session: TestTarget['session']|undefined;
  #port = 0;
  readonly #frontendOrigin: string;

  constructor(frontendOrigin: string) {
    this.#frontendOrigin = frontendOrigin;
  }

  get session(): TestTarget['session'] {
    if (!this.#session) {
      throw new Error('테스트 대상 Chrome이 시작되지 않았습니다.');
    }
    return this.#session;
  }

  async start(): Promise<TestTarget['session']> {
    this.#browser = await puppeteer.launch({
      executablePath: process.env.CHROME_BIN || defaultChromePath(),
      headless: true,
      args: [`--remote-debugging-port=${this.#port}`, `--remote-allow-origins=${this.#frontendOrigin}`],
    });
    this.#port = Number(new URL(this.#browser.wsEndpoint()).port);
    const targets = await (await fetch(`http://127.0.0.1:${this.#port}/json/list`)).json() as
        Array<{type: string, url: string, webSocketDebuggerUrl: string}>;
    const page = targets.find(target => target.type === 'page' && target.url === 'about:blank');
    const pid = this.#browser.process()?.pid;
    if (!page || !pid) {
      throw new Error('테스트 대상 페이지와 프로세스를 식별할 수 없습니다.');
    }
    this.#session = {ws: page.webSocketDebuggerUrl, pid, port: this.#port};
    return this.session;
  }

  async restart(): Promise<TestTarget['session']> {
    await this.close();
    return await this.start();
  }

  async navigate(url: string): Promise<void> {
    const page = (await this.#browser?.pages())?.[0];
    if (!page) {
      throw new Error('이동할 테스트 페이지가 없습니다.');
    }
    const connection = await page.createCDPSession();
    await connection.send('Page.navigate', {url});
    await connection.detach();
  }

  async close(): Promise<void> {
    await this.#browser?.close();
    this.#browser = undefined;
  }
}
