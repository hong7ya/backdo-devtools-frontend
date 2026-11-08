// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {type ChildProcessByStdio, spawn} from 'node:child_process';
import {once} from 'node:events';
import type {Readable} from 'node:stream';

const INSPECTOR_START_TIMEOUT_MS = 10_000;
const DISCOVERY_TIMEOUT_MS = 5000;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 2000;
const STARTUP_LOG_LIMIT = 8192;

type TargetProcess = ChildProcessByStdio<null, Readable, Readable>;

interface NodeTestSession {
  ws: string;
  pid: number;
  port: number;
}

interface NodeTestOptions {
  entry: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** 테스트가 직접 실행한 Node만 관리한다. 실제 사용자의 터미널 실행을 테스트 안에서 대신한다. */
export class NodeTestTarget {
  readonly #options: NodeTestOptions;
  #child: TargetProcess|null = null;
  #inspectorPort = 0;
  #closed = false;

  constructor(options: NodeTestOptions) {
    this.#options = options;
  }

  async start(): Promise<NodeTestSession> {
    if (this.#closed || this.#child) {
      throw new Error('종료되었거나 이미 실행 중인 프로세스 관리기입니다.');
    }
    const child = this.#spawnTarget();
    this.#child = child;
    try {
      const inspectorURL = await this.#waitForInspector(child);
      this.#inspectorPort = Number(new URL(inspectorURL).port);
      const ws = await this.#discoverWebSocket(inspectorURL);
      if (!child.pid) {
        throw new Error('실행한 프로세스의 PID를 확인할 수 없습니다.');
      }
      return {ws, pid: child.pid, port: this.#inspectorPort};
    } catch (error) {
      await this.#stopTarget();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#stopTarget();
  }

  #spawnTarget(): TargetProcess {
    const {entry, args = [], cwd = process.cwd()} = this.#options;
    const child = spawn(process.execPath, [`--inspect-brk=127.0.0.1:${this.#inspectorPort}`, entry, ...args], {
      cwd, env: this.#options.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.resume();
    return child;
  }

  #waitForInspector(child: TargetProcess): Promise<string> {
    return new Promise((resolve, reject) => {
      let startupLog = '';
      const cleanup = (): void => {
        clearTimeout(timeout);
        child.stderr.off('data', onData);
        child.off('error', onError);
        child.off('exit', onExit);
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onExit = (code: number|null): void => {
        onError(new Error(`디버거 연결 전에 대상 프로세스가 종료되었습니다. 종료 코드: ${code}`));
      };
      const onData = (chunk: Buffer): void => {
        startupLog = (startupLog + chunk.toString()).slice(-STARTUP_LOG_LIMIT);
        const match = startupLog.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/);
        if (match) {
          cleanup();
          resolve(match[1]);
        }
      };
      const timeout = setTimeout(() => {
        onError(new Error('Node 디버거 시작 대기 시간이 초과되었습니다.'));
      }, INSPECTOR_START_TIMEOUT_MS);
      child.stderr.on('data', onData);
      child.once('error', onError);
      child.once('exit', onExit);
    });
  }

  async #discoverWebSocket(expectedURL: string): Promise<string> {
    // 실제 사용자의 포트 연결과 같이 /json/list에서 직접 실행한 대상을 확인한다.
    const response = await fetch(`http://127.0.0.1:${this.#inspectorPort}/json/list`, {
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`디버거 연결 정보 조회에 실패했습니다. HTTP ${response.status}`);
    }
    const targets: unknown = await response.json();
    const ownedTarget = Array.isArray(targets) && targets.some((target: unknown) => {
      return typeof target === 'object' && target !== null &&
          'webSocketDebuggerUrl' in target && target.webSocketDebuggerUrl === expectedURL;
    });
    if (!ownedTarget) {
      throw new Error('직접 실행한 프로세스의 디버거 연결을 찾을 수 없습니다.');
    }
    return expectedURL;
  }

  async #stopTarget(): Promise<void> {
    const child = this.#child;
    if (!child) {
      return;
    }
    const isRunning = child.pid && child.exitCode === null && child.signalCode === null;
    if (isRunning) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const forceKill = setTimeout(() => child.kill('SIGKILL'), GRACEFUL_SHUTDOWN_TIMEOUT_MS);
      try {
        await exited;
      } finally {
        clearTimeout(forceKill);
      }
    }
    this.#child = null;
  }
}
