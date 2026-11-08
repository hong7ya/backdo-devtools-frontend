// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {assert} from 'chai';
import {describe, it} from 'mocha';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {serveBackDo} from '../debug.mjs';

describe('BackDo process manager', () => {
  it('restart replaces the owned PID and WebSocket on the same inspector port; control is authenticated', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'backdo-process-'));
    let app;
    try {
      await writeFile(path.join(directory, 'js_app.html'), '<title>BackDo</title>');
      await writeFile(path.join(directory, 'entry.js'), 'const a = 1;\nconsole.log(a);');
      app = await serveBackDo({entry: path.join(directory, 'entry.js'), frontend: directory, output: null});
      const headers = {'X-BackDo-Session': app.token};
      const session = () => fetch(`${app.origin}/__backdo/session`, {headers}).then(r => r.json());
      const first = await session();
      assert.isAbove(first.pid, 0);
      assert.strictEqual((await fetch(app.url)).status, 200);
      assert.strictEqual((await fetch(`${app.origin}/__backdo/restart`, {method: 'POST'})).status, 403);
      assert.strictEqual((await fetch(`${app.origin}/__backdo/restart`, {
        method: 'POST', headers: {...headers, Origin: 'https://untrusted.example'},
      })).status, 403);
      assert.strictEqual((await session()).pid, first.pid);
      const response = await fetch(`${app.origin}/__backdo/restart`, {method: 'POST', headers});
      assert.strictEqual(response.status, 200);
      const second = await response.json();
      assert.notStrictEqual(second.pid, first.pid);
      assert.notStrictEqual(second.ws, first.ws);
      assert.strictEqual(second.port, first.port);
      assert.strictEqual(second.entryURL, first.entryURL);
      assert.throws(() => process.kill(first.pid, 0), /ESRCH/);
      await app.close();
      app = null;
      assert.throws(() => process.kill(second.pid, 0), /ESRCH/);
    } finally {
      await app?.close();
      await rm(directory, {recursive: true, force: true});
    }
  }).timeout(15_000);
});
