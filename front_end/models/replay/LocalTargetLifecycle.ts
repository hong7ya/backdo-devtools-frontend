// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import type {CalibrationProcess} from './ReplayCalibration.js';
import type {TargetAddress, TargetLifecycle} from './ReplayConnection.js';
import {type ConnectionRequest, type TargetKind, validateWebSocketURL} from './ReplayEndpoint.js';

interface SessionAddress {
  id: string;
  ws: string;
  kind: TargetKind;
}

/** 포트·ws만 로컬 서버에 전달한다. 실행 정보와 환경변수는 서버 밖으로 가져오지 않는다. */
export class LocalTargetLifecycle implements TargetLifecycle {
  readonly #origin: string;
  #session: SessionAddress|null = null;

  constructor(pageURL: URL) {
    const configured = pageURL.searchParams.get('backdoServer');
    const origin = new URL(configured || 'http://127.0.0.1:3000');
    if (origin.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) ||
        origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
      throw new Error('BackDo 서버 주소는 로컬 HTTP 서버 주소여야 합니다.');
    }
    this.#origin = origin.origin;
  }

  async register(request: ConnectionRequest, kind: TargetKind): Promise<string> {
    const endpoint = 'ws' in request ? new URL(validateWebSocketURL(request.ws)) : null;
    if (endpoint && !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) {
      throw new Error('프로세스 재시작은 로컬 대상에서 사용할 수 있습니다.');
    }
    const port = endpoint ? Number(endpoint.port) : 'port' in request ? request.port : 0;
    this.#session = await this.#request<SessionAddress>('/sessions', 'POST', {port, kind, ws: endpoint?.href});
    // 탭 종료 시 실행 정보와 더미를 해제한다. 사용자 대상 종료와는 별개다.
    window.addEventListener('pagehide', () => {
      void fetch(`${this.#origin}${this.#path()}`, {method: 'DELETE', keepalive: true}).catch(() => {});
    }, {once: true});
    return validateWebSocketURL(this.#session.ws);
  }

  async discover(_port: number, _kind: TargetKind): Promise<string> {
    if (!this.#session) {
      throw new Error('등록된 디버깅 대상이 없습니다.');
    }
    return this.#session.ws;
  }

  async prepare(): Promise<void> {
    await this.#request(`${this.#path()}?ready=true`, 'GET');
  }

  async restart(target: TargetAddress): Promise<string> {
    this.#session = await this.#request<SessionAddress>(`${this.#path()}/restart`, 'POST', {ws: target.ws});
    return validateWebSocketURL(this.#session.ws);
  }

  async createCalibrationProcess(_kind: TargetKind, signal: AbortSignal): Promise<CalibrationProcess> {
    const path = `${this.#path()}/calibrations/${crypto.randomUUID()}`;
    const dispose = async(): Promise<void> => { await this.#request(path, 'DELETE'); };
    try {
      const result = await this.#request<{ws: string}>(path, 'POST', {}, signal);
      if (signal.aborted) {
        await dispose();
        signal.throwIfAborted();
      }
      return {ws: validateWebSocketURL(result.ws), dispose};
    } catch (error) {
      // 응답이 유실되거나 생성 도중 취소돼도 같은 요청 ID로 서버의 소유 리소스를 정리한다.
      await dispose().catch(() => {});
      throw error;
    }
  }

  #path(): string {
    if (!this.#session) {
      throw new Error('등록된 디버깅 세션이 없습니다.');
    }
    return `/sessions/${encodeURIComponent(this.#session.id)}`;
  }

  async #request<T>(path: string, method: string, body?: object, signal?: AbortSignal): Promise<T> {
    const timeout = AbortSignal.timeout(30_000);
    const response = await fetch(`${this.#origin}${path}`, {
      method, headers: body ? {'Content-Type': 'application/json'} : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (response.status === 204) {
      return undefined as T;
    }
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'BackDo 로컬 서버 요청에 실패했습니다.');
    }
    return result as T;
  }
}
