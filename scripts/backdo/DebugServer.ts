// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {randomBytes} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {realpath, stat} from 'node:fs/promises';
import {createServer, type IncomingMessage, type Server, type ServerResponse} from 'node:http';
import type {AddressInfo} from 'node:net';
import * as path from 'node:path';

import {ManagedProcess, type ProcessOptions} from './ManagedProcess.js';

const DEFAULT_FRONTEND = path.resolve(__dirname, '../../front_end');
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

interface ServerOptions extends ProcessOptions {
  frontend?: string;
}

interface RequestContext {
  root: string;
  token: string;
  origin: string;
  manager: ManagedProcess;
}

export interface BackDoServer {
  url: string;
  origin: string;
  token: string;
  manager: ManagedProcess;
  close: () => Promise<void>;
}

export async function serveBackDo(options: ServerOptions): Promise<BackDoServer> {
  const root = await realpath(options.frontend ?? DEFAULT_FRONTEND);
  await stat(path.join(root, 'js_app.html'));
  const manager = new ManagedProcess({...options, entry: await realpath(options.entry)});
  const target = await manager.start();
  const token = randomBytes(32).toString('hex');
  const server = createServer((request, response) => {
    const context = {root, token, manager, origin: serverOrigin(server)};
    void handleRequest(context, request, response);
  });
  try {
    await listenLocally(server);
  } catch (error) {
    await manager.close();
    throw error;
  }
  const origin = serverOrigin(server);
  const url = new URL('/js_app.html', origin);
  url.searchParams.set('ws', target.ws.replace(/^ws:\/\//, ''));
  url.searchParams.set('backdoSession', token);
  return {
    url: url.href, origin, token, manager,
    async close(): Promise<void> {
      await manager.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

async function handleRequest(context: RequestContext, request: IncomingMessage, response: ServerResponse):
    Promise<void> {
  try {
    const url = new URL(request.url ?? '/', context.origin);
    if (url.pathname.startsWith('/__backdo/')) {
      await handleSessionRequest(context, request, response, url.pathname);
      return;
    }
    await serveFrontendFile(context.root, request, response, url.pathname);
  } catch (error) {
    const missingFile = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    sendJSON(response, missingFile ? 404 : 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleSessionRequest(
    context: RequestContext, request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
  if (!isAuthorizedSessionRequest(context, request)) {
    sendJSON(response, 403, {error: '유효하지 않은 BackDo 세션입니다.'});
    return;
  }
  if (pathname === '/__backdo/session' && request.method === 'GET') {
    sendJSON(response, 200, context.manager.session);
    return;
  }
  if (pathname === '/__backdo/restart' && request.method === 'POST') {
    sendJSON(response, 200, await context.manager.restart());
    return;
  }
  sendJSON(response, 405, {error: '지원하지 않는 세션 요청입니다.'});
}

function isAuthorizedSessionRequest(context: RequestContext, request: IncomingMessage): boolean {
  const sameHost = request.headers.host === new URL(context.origin).host;
  const sameOrigin = !request.headers.origin || request.headers.origin === context.origin;
  const validToken = request.headers['x-backdo-session'] === context.token;
  // 요청으로 실행 경로나 PID를 받지 않는다. 현재 세션이 시작한 프로세스만 재시작한다.
  return sameHost && sameOrigin && validToken;
}

async function serveFrontendFile(
    root: string, request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJSON(response, 405, {error: '정적 파일은 조회만 가능합니다.'});
    return;
  }
  const filename = await realpath(path.join(root, decodeURIComponent(pathname)));
  const relative = path.relative(root, filename);
  const outsideRoot = relative.startsWith('..') || path.isAbsolute(relative);
  if (outsideRoot || !(await stat(filename)).isFile()) {
    sendJSON(response, 404, {error: '파일을 찾을 수 없습니다.'});
    return;
  }
  response.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(filename)] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(filename).on('error', () => response.destroy()).pipe(response);
}

function sendJSON(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
  response.end(JSON.stringify(body));
}

function listenLocally(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function serverOrigin(server: Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
