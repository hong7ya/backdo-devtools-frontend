// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {type ChildProcessByStdio, spawn} from 'node:child_process';
import {once} from 'node:events';
import type {Readable} from 'node:stream';
import {pathToFileURL} from 'node:url';

const INSPECTOR_START_TIMEOUT_MS = 10_000;
const DISCOVERY_TIMEOUT_MS = 5000;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 2000;
const STARTUP_LOG_LIMIT = 8192;

type TargetProcess = ChildProcessByStdio<null, Readable, Readable>;

interface NodeTestSession {
  ws: string;
  entryURL: string;
  pid: number;
  port: number;
}

interface NodeTestOptions {
  entry: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  port?: number;
  pauseOnStart?: boolean;
  output?: Pick<NodeJS.WritableStream, 'write'>|null;
}

/** 테스트가 직접 실행한 Node만 관리한다. 실제 사용자의 터미널 실행을 테스트 안에서 대신한다. */
export class NodeTestTarget {
  readonly #options: NodeTestOptions;
  #child: TargetProcess|null = null;
  #session: NodeTestSession|null = null;
  #inspectorPort: number;
  #restartTask: Promise<NodeTestSession>|null = null;
  #closed = false;

  constructor(options: NodeTestOptions) {
    this.#options = options;
    this.#inspectorPort = options.port ?? 0;
  }

  get session(): NodeTestSession {
    if (!this.#child || !this.#session || this.#child.exitCode !== null || this.#child.signalCode !== null) {
      throw new Error('디버깅 대상 프로세스가 실행 중이 아닙니다.');
    }
    return this.#session;
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
      this.#session = {
        ws, entryURL: pathToFileURL(this.#options.entry).href,
        pid: child.pid, port: this.#inspectorPort,
      };
      return this.session;
    } catch (error) {
      await this.#stopTarget();
      throw error;
    }
  }

  async restart(): Promise<NodeTestSession> {
    if (this.#closed || this.#restartTask) {
      throw new Error('실행 관리기가 종료되었거나 재시작이 이미 진행 중입니다.');
    }
    this.#restartTask = this.#replaceTarget();
    try {
      return await this.#restartTask;
    } finally {
      this.#restartTask = null;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    // 테스트 종료와 재시작이 겹쳐도 새 자식 프로세스가 남지 않게 한다.
    await this.#restartTask?.catch(() => {});
    await this.#stopTarget();
  }

  async #replaceTarget(): Promise<NodeTestSession> {
    await this.#stopTarget();
    return await this.start();
  }

  #spawnTarget(): TargetProcess {
    const {entry, args = [], cwd = process.cwd(), output = process.stderr} = this.#options;
    const inspect = this.#options.pauseOnStart === false ? '--inspect' : '--inspect-brk';
    const child = spawn(process.execPath, [`${inspect}=127.0.0.1:${this.#inspectorPort}`, entry, ...args], {
      cwd, env: this.#options.env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => output?.write(chunk));
    child.stderr.on('data', chunk => output?.write(chunk));
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
    // 포트는 같아도 재시작할 때 연결 식별자가 바뀌므로 /json/list에서 다시 조회한다.
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
    this.#session = null;
  }
}
