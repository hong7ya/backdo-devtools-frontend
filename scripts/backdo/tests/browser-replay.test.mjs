// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {assert} from 'chai';
import {afterEach, describe, it} from 'mocha';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

import paths from '../../devtools_paths.js';
import {serveBackDo} from '../debug.mjs';

// Node targets need their own process supervisor; use the repository's script Mocha runner.
// BACKDO_FRONTEND_DIR optionally selects a separately built frontend for local verification.
describe('BackDo browser/process replay', () => {
  let app;
  let browser;
  let directory;

  afterEach(async () => {
    await browser?.close();
    await app?.close();
    if (directory) {
      await rm(directory, {recursive: true, force: true});
    }
    browser = app = directory = undefined;
  });

  async function open(fixture) {
    directory = await mkdtemp(path.join(tmpdir(), 'backdo-browser-'));
    const source = await readFile(new URL(`../fixtures/${fixture}`, import.meta.url), 'utf8');
    const entry = path.join(directory, fixture);
    await writeFile(entry, source);
    app = await serveBackDo({entry, frontend: process.env.BACKDO_FRONTEND_DIR, output: null});
    browser = await puppeteer.launch({
      executablePath: process.env.CHROME_BIN || paths.downloadedChromeBinaryPath(),
      headless: true, defaultViewport: {width: 1440, height: 1000},
      args: ['--no-first-run', '--disable-features=Translate'],
    });
    const page = await browser.newPage();
    let documents = 0;
    const pageErrors = [];
    page.on('request', request => {
      if (request.resourceType() === 'document') {
        documents++;
      }
    });
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(app.url, {waitUntil: 'domcontentloaded'});
    await page.waitForFunction(async () => {
      const SDK = await import('/core/sdk/sdk.js');
      const Replay = await import('/models/replay/replay.js');
      const Common = await import('/core/common/common.js');
      const Sources = await import('/panels/sources/sources.js');
      const model = () => SDK.TargetManager.TargetManager.instance().primaryPageTarget()?.model(
          SDK.DebuggerModel.DebuggerModel);
      window.backdoTest = {SDK, Replay, Common, Sources, model};
      return model()?.isPaused();
    }, {timeout: 15_000});
    await page.evaluate(() => {
      const {SDK} = window.backdoTest;
      window.backdoTest.visiblePauses = [];
      SDK.TargetManager.TargetManager.instance().addModelListener(
          SDK.DebuggerModel.DebuggerModel, 'DebuggerPaused', event => {
            const location = event.data.debuggerPausedDetails()?.callFrames[0]?.location();
            if (location) {
              window.backdoTest.visiblePauses.push([location.lineNumber, location.columnNumber]);
            }
          });
      window.backdoTest.document = document;
      window.backdoTest.timeOrigin = performance.timeOrigin;
      history.replaceState({backdoTest: 'preserve'}, '');
      window.backdoTest.historyLength = history.length;
      window.backdoTest.transitions = [];
      const start = document.startViewTransition.bind(document);
      document.startViewTransition = update => {
        const transition = start(update);
        transition.ready.then(() => window.backdoTest.transitions.push('ready'), () => {
          window.backdoTest.transitions.push('skipped');
        });
        return transition;
      };
    });
    const unavailable = await page.$('pierce/[title="No previous recorded position in the entry script"]');
    assert.isNotNull(unavailable);
    assert.isTrue(await unavailable.evaluate(element => element.disabled));
    return {page, source, entry, documents: () => documents, pageErrors};
  }

  async function runToReturn(page, source) {
    const line = source.split('\n').findIndex(text => text.trim() === 'return total;');
    await page.evaluate(async lineNumber => {
      const model = window.backdoTest.model();
      const url = model.debuggerPausedDetails().callFrames[0].script.sourceURL;
      await model.setBreakpointByURL(url, lineNumber, 2);
      model.resume();
    }, line);
    await page.waitForFunction(lineNumber => {
      return window.backdoTest.model()?.debuggerPausedDetails()?.callFrames[0]?.location().lineNumber === lineNumber;
    }, {timeout: 15_000}, line);
    return page.evaluate(() => {
      const controller = window.backdoTest.Replay.ReplayController.ReplayController.instance();
      return {target: controller.session.history.previous().target, length: controller.session.history.length};
    });
  }

  async function reverse(page, previous) {
    const before = app.manager.session;
    const started = performance.now();
    const count = await page.evaluate(() => window.backdoTest.visiblePauses.length);
    const button = await page.waitForSelector('pierce/[title^="Go to the previous recorded position"]');
    await button.click();
    await page.waitForFunction(length => {
      const {Replay} = window.backdoTest;
      const controller = Replay.ReplayController.ReplayController.instance();
      return !controller.busy && !document.body.inert &&
          (controller.session.history.length === length - 1 || controller.session.error);
    }, {timeout: 35_000}, previous.length);
    const result = await page.evaluate(() => {
      const {model, Replay, Common, Sources} = window.backdoTest;
      const frame = model().debuggerPausedDetails()?.callFrames[0];
      const location = frame?.location();
      const editor = Sources.SourcesPanel.SourcesPanel.instance().sourcesViewInternal.currentSourceFrame()?.textEditor;
      const token = editor?.shadowRoot?.querySelector('.cm-executionToken');
      const offset = token && editor.editor.posAtDOM(token, 0);
      const line = typeof offset === 'number' && editor.state.doc.lineAt(offset);
      return {
        error: Replay.ReplayController.ReplayController.instance().session.error,
        position: location && {url: frame.script.sourceURL, hash: frame.script.hash,
          lineNumber: location.lineNumber, columnNumber: location.columnNumber},
        highlight: line && [line.number - 1, offset - line.from],
        messages: Common.Console.Console.instance().messages().filter(message => message.text.startsWith('BackDo:')),
        sameDocument: window.backdoTest.document === document,
        sameTimeOrigin: window.backdoTest.timeOrigin === performance.timeOrigin,
        sameHistoryLength: window.backdoTest.historyLength === history.length,
        historyState: history.state, ws: new URL(location ? window.location.href : '').searchParams.get('ws'),
        visiblePauses: window.backdoTest.visiblePauses, transitions: window.backdoTest.transitions,
      };
    });
    assert.isNull(result.error);
    assert.deepEqual(result.position, previous.target);
    assert.deepEqual(result.highlight, [previous.target.lineNumber, previous.target.columnNumber]);
    assert.deepEqual(result.messages, []);
    assert.isTrue(result.sameDocument);
    assert.isTrue(result.sameTimeOrigin);
    assert.isTrue(result.sameHistoryLength);
    assert.deepEqual(result.historyState, {backdoTest: 'preserve'});
    assert.lengthOf(result.visiblePauses, count + 1, 'Only the final replay pause reaches the UI');
    assert.strictEqual(result.transitions.at(-1), 'ready');
    const after = app.manager.session;
    assert.notStrictEqual(after.pid, before.pid);
    assert.notStrictEqual(after.ws, before.ws);
    assert.strictEqual(after.port, before.port);
    assert.strictEqual(result.ws, after.ws.replace(/^ws:\/\//, ''));
    console.log(`    reverse completed in ${Math.round(performance.now() - started)} ms`);
  }

  for (const fixture of ['for.js', 'async-await.js', 'for-of-break.js']) {
    it(`replays ${fixture} in the same tab with one final UI pause`, async () => {
      const test = await open(fixture);
      const previous = await runToReturn(test.page, test.source);
      if (fixture !== 'for-of-break.js') {
        const lines = test.source.split('\n');
        const condition = lines.findIndex(line => line.includes('i <'));
        assert.strictEqual(previous.target.lineNumber, condition);
        assert.strictEqual(previous.target.columnNumber, lines[condition].indexOf('<'));
      }
      await reverse(test.page, previous);
      // Repeated reverse consumes one history event, not a whole loop iteration.
      const next = await test.page.evaluate(() => {
        const controller = window.backdoTest.Replay.ReplayController.ReplayController.instance();
        return {target: controller.session.history.previous().target, length: controller.session.history.length};
      });
      await reverse(test.page, next);
      assert.strictEqual(test.documents(), 1);
      assert.deepEqual(test.pageErrors, []);
    }).timeout(60_000);
  }

  it('rejects replay after the source changes and disables reverse', async () => {
    const test = await open('for.js');
    await runToReturn(test.page, test.source);
    await writeFile(test.entry, test.source.replace('i < 4', 'i < 5'));
    await (await test.page.$('pierce/[title^="Go to the previous recorded position"]')).click();
    await test.page.waitForFunction(() => {
      const controller = window.backdoTest.Replay.ReplayController.ReplayController.instance();
      return !controller.busy && !document.body.inert && controller.session.error;
    }, {timeout: 35_000});
    const button = await test.page.$('pierce/[title^="BackDo unavailable:"]');
    assert.isNotNull(button);
    assert.isTrue(await button.evaluate(element => element.disabled));
    const error = await test.page.evaluate(() => {
      return window.backdoTest.Replay.ReplayController.ReplayController.instance().session.error;
    });
    assert.match(error, /diverged/);
    assert.strictEqual(test.documents(), 1);
  }).timeout(60_000);
});
