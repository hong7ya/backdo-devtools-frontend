// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';

/** Owns only the child it starts. No PID lookup or killing processes by port. */
export class ManagedProcess {
  #child;
  #port;
  #restarting = false;
  #options;
  #session;

  constructor({entry, args = [], cwd = process.cwd(), port = 0, output = process.stderr}) {
    this.#options = {entry, args, cwd, output};
    this.#port = port;
  }

  get session() {
    if (!this.#child || this.#child.exitCode !== null || this.#child.signalCode !== null) {
      throw new Error('The debug target is not running');
    }
    return this.#session;
  }

  async start() {
    if (this.#child) {
      throw new Error('The debug target has already started');
    }
    const {entry, args, cwd, output} = this.#options;
    const child = spawn(process.execPath, [`--inspect-brk=127.0.0.1:${this.#port}`, entry, ...args], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.#child = child;
    child.stdout.on('data', chunk => output?.write(chunk));
    child.stderr.on('data', chunk => output?.write(chunk));
    try {
      const inspectorURL = await new Promise((resolve, reject) => {
        let stderr = '';
        const finish = (error, url) => {
          clearTimeout(timer);
          child.stderr.off('data', onData);
          child.off('error', onError);
          child.off('exit', onExit);
          error ? reject(error) : resolve(url);
        };
        const onError = error => finish(error);
        const onExit = code => finish(new Error(`Target exited before inspector startup (${code})`));
        const onData = chunk => {
          stderr = (stderr + chunk).slice(-8192);
          const match = stderr.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
          if (match) {
            finish(null, match[1]);
          }
        };
        const timer = setTimeout(() => finish(new Error('Inspector startup timed out')), 10_000);
        child.stderr.on('data', onData);
        child.once('error', onError);
        child.once('exit', onExit);
      });
      this.#port = Number(new URL(inspectorURL).port);
      // Rediscover the new WebSocket ID rather than reusing the old process URL.
      const response = await fetch(`http://127.0.0.1:${this.#port}/json/list`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        throw new Error(`Inspector discovery failed: ${response.status}`);
      }
      const targets = await response.json();
      const target = targets.find(item => item.webSocketDebuggerUrl === inspectorURL);
      if (!target) {
        throw new Error('Inspector discovery did not identify the owned child');
      }
      this.#session = {
        ws: target.webSocketDebuggerUrl, entryURL: pathToFileURL(entry).href,
        pid: child.pid, port: this.#port,
      };
      return this.session;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop() {
    const child = this.#child;
    if (!child) {
      return;
    }
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      try {
        await exited;
      } finally {
        clearTimeout(killTimer);
      }
    }
    this.#child = undefined;
  }

  async restart() {
    if (this.#restarting) {
      throw new Error('A target restart is already in progress');
    }
    this.#restarting = true;
    try {
      await this.stop();
      return await this.start();
    } finally {
      this.#restarting = false;
    }
  }
}
