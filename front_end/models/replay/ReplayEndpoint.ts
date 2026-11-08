// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

export type TargetKind = 'node'|'console';

export type ConnectionRequest = {ws: string}|{port: number};

/** 기존 ws 주소를 우선한다. 포트만 전달한 경우 주소 조회는 서버 연결 계층에 맡긴다. */
export function readConnectionRequest(url: URL): ConnectionRequest|null {
  const ws = url.searchParams.get('ws');
  const wss = url.searchParams.get('wss');
  if (ws || wss) {
    return {ws: validateWebSocketURL(ws ? `ws://${ws}` : `wss://${wss}`)};
  }
  const port = url.searchParams.get('port');
  if (port === null) {
    return null;
  }
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('디버깅 포트는 1부터 65535 사이의 정수여야 합니다.');
  }
  return {port: Number(port)};
}

export function validateWebSocketURL(value: string): string {
  const url = new URL(value);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || !url.hostname) {
    throw new Error('유효한 디버거 WebSocket 주소가 아닙니다.');
  }
  return url.href;
}

/** 주소 갱신과 실제 연결 교체는 별개다. 연결 응답을 받은 뒤에만 호출한다. */
export function replaceConnectionAddress(ws: string): void {
  const target = new URL(validateWebSocketURL(ws));
  const url = new URL(location.href);
  url.searchParams.delete('ws');
  url.searchParams.delete('wss');
  url.searchParams.set(target.protocol === 'wss:' ? 'wss' : 'ws', target.href.replace(/^wss?:\/\//, ''));
  history.replaceState(history.state, '', url);
}
