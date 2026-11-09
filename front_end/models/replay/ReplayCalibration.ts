// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import type * as Platform from '../../core/platform/platform.js';
import * as SDK from '../../core/sdk/sdk.js';
import type * as Protocol from '../../generated/protocol.js';

import {validateWebSocketURL} from './ReplayEndpoint.js';

/** 생성자가 소유한 별도 OS 프로세스다. 사용자 대상과 포트·프로세스를 공유하지 않는다. */
export interface CalibrationProcess {
  ws: string;
  /** 소유한 더미만 종료한다. 여러 번 호출해도 안전해야 한다. */
  dispose(): Promise<void>;
}

export type CalibrationProcessFactory = (signal: AbortSignal) => Promise<CalibrationProcess>;

// 사용자 소스나 위치를 전달하지 않는다. 이 소스는 컴파일만 하고 실행하지 않는다.
const DUMMY_SOURCE = '(() => { let total = 0; for (let i = 0; i < 4; i++) { total += i; } return total; })()';
// 3초 예산과 별개로, 응답 없는 측정 리소스를 해제하기 위한 대기 상한이다.
const CALIBRATION_TIMEOUT_MS = 30_000;

/** 독립 연결의 요청 한 번을 측정한다. 사용자 연결·전역 SDK 대상·화면은 건드리지 않는다. */
export async function measureRoundTrip(
    createProcess: CalibrationProcessFactory, userWS: string, signal: AbortSignal): Promise<number> {
  const cancellation = new AbortController();
  const cancel = (): void => cancellation.abort(new Error('CDP 응답 시간 측정이 취소되었습니다.'));
  signal.addEventListener('abort', cancel, {once: true});
  if (signal.aborted) {
    cancel();
  }
  const timeout = setTimeout(
      () => cancellation.abort(new Error('CDP 응답 시간 측정의 대기 제한 시간이 지났습니다.')), CALIBRATION_TIMEOUT_MS);
  let process: CalibrationProcess|undefined;
  let connection: CalibrationConnection|undefined;
  try {
    cancellation.signal.throwIfAborted();
    const pendingProcess = createProcess(cancellation.signal).then(async created => {
      assertSeparateEndpoint(created.ws, userWS);
      process = created;
      // 생성 도중 세션이 끝나도 늦게 도착한 더미를 남기지 않는다.
      if (cancellation.signal.aborted) {
        await created.dispose();
        cancellation.signal.throwIfAborted();
      }
      return created;
    });
    process = await untilCancelled(pendingProcess, cancellation.signal);
    connection = new CalibrationConnection(validateWebSocketURL(process.ws), cancellation.signal);
    await connection.request('Runtime.enable');
    await connection.request('Debugger.enable');
    const script = await connection.request<Protocol.Runtime.CompileScriptResponse>('Runtime.compileScript', {
      expression: DUMMY_SOURCE,
      sourceURL: 'backdo-calibration:///probe.js',
      persistScript: true,
    });
    if (!script.scriptId || script.exceptionDetails) {
      throw new Error('더미 측정 소스를 준비하지 못했습니다.');
    }
    const startedAt = performance.now();
    const result = await connection.request<Protocol.Debugger.GetPossibleBreakpointsResponse>(
        'Debugger.getPossibleBreakpoints', {start: {scriptId: script.scriptId, lineNumber: 0}});
    const roundTripMs = performance.now() - startedAt;
    if (!result.locations.length) {
      throw new Error('더미 소스에서 측정할 정지 위치를 찾지 못했습니다.');
    }
    return roundTripMs;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', cancel);
    connection?.close();
    await process?.dispose();
  }
}

function assertSeparateEndpoint(dummyWS: string, userWS: string): void {
  const dummy = new URL(validateWebSocketURL(dummyWS));
  const user = new URL(validateWebSocketURL(userWS));
  const port = (url: URL): string => url.port || (url.protocol === 'wss:' ? '443' : '80');
  const host =
      (url: URL): string => ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? 'loopback' : url.hostname;
  if (host(dummy) === host(user) && port(dummy) === port(user)) {
    // 잘못 전달된 사용자 주소에는 연결하지 않고, 사용자 프로세스를 종료할 수도 있는 콜백도 호출하지 않는다.
    throw new Error('측정용 프로세스는 사용자 대상과 별도 포트를 사용해야 합니다.');
  }
}

async function untilCancelled<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel: () => void = () => {};
  try {
    return await new Promise<T>((resolve, reject) => {
      cancel = () => reject(signal.reason);
      signal.addEventListener('abort', cancel, {once: true});
      void pending.then(resolve, reject);
      if (signal.aborted) {
        cancel();
      }
    });
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

/** 측정 전용 순차 요청 연결. 정지 이벤트를 SDK나 사용자 화면에 전달하지 않는다. */
class CalibrationConnection {
  readonly #connection: SDK.Connections.WebSocketConnection;
  readonly #signal: AbortSignal;
  #nextId = 0;
  #pending: {id: number, resolve: (value: object) => void, reject: (error: Error) => void}|null = null;
  #failure: Error|null = null;
  readonly #cancel = (): void => this.#stop(new Error('CDP 측정 연결이 취소되었습니다.'));

  constructor(ws: string, signal: AbortSignal) {
    this.#signal = signal;
    // SDK의 연결 전 송신 대기·실패·종료 처리를 재사용한다. 전역 대상이나 연결 팩토리는 등록하지 않는다.
    this.#connection = new SDK.Connections.WebSocketConnection(
        ws as Platform.DevToolsPath.UrlString, message => this.#stop(new Error(message)));
    this.#connection.setOnDisconnect(message => this.#stop(new Error(message)));
    this.#connection.setOnMessage(message => this.#handleMessage(message));
    signal.addEventListener('abort', this.#cancel, {once: true});
    if (signal.aborted) {
      this.#cancel();
    }
  }

  async request<T extends object>(method: string, params: object = {}): Promise<T> {
    if (this.#failure) {
      throw this.#failure;
    }
    if (this.#pending) {
      throw new Error('CDP 측정 요청은 한 번에 하나씩 보내야 합니다.');
    }
    return await new Promise<T>((resolve, reject) => {
      const id = ++this.#nextId;
      this.#pending = {id, resolve: value => resolve(value as T), reject};
      this.#connection.sendRawMessage(JSON.stringify({id, method, params}));
    });
  }

  close(): void {
    this.#stop(new Error('CDP 측정 연결을 정리했습니다.'));
  }

  #handleMessage(data: object|string): void {
    try {
      const message = (typeof data === 'string' ? JSON.parse(data) : data) as
          {id?: number, result?: object, error?: {message: string}};
      const pending = this.#pending;
      if (!pending || message.id !== pending.id) {
        return;
      }
      this.#pending = null;
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result ?? {});
      }
    } catch {
      this.#stop(new Error('더미 프로세스의 CDP 응답을 읽지 못했습니다.'));
    }
  }

  #stop(error: Error): void {
    if (this.#failure) {
      return;
    }
    this.#failure = error;
    this.#pending?.reject(error);
    this.#pending = null;
    this.#signal.removeEventListener('abort', this.#cancel);
    void this.#connection.disconnect();
  }
}
