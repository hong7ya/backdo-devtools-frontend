// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {readFile, realpath} from 'node:fs/promises';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import * as path from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
};

/** 빌드된 파일만 제공한다. 사용자 프로세스의 실행이나 별도 server API를 대신 구현하지 않는다. */
export async function serveTestFrontend(pageSource?: string): Promise<{origin: string, close: () => Promise<void>}> {
  const root = await realpath(process.env.BACKDO_FRONTEND_DIR ?? path.resolve(__dirname, '../../../front_end'));
  const server = createServer((request, response) => {
    void (async () => {
      const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
      if (pageSource && pathname === '/fixture.html') {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><meta charset="utf-8"><script src="/fixture.js"></script>');
        return;
      }
      if (pageSource && pathname === '/fixture.js') {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(pageSource);
        return;
      }
      const filename = await realpath(path.join(root, pathname));
      const relative = path.relative(root, filename);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        response.writeHead(404).end();
        return;
      }
      response.setHeader('Content-Type', CONTENT_TYPES[path.extname(filename)] ?? 'application/octet-stream');
      response.end(await readFile(filename));
    })().catch(() => response.writeHead(404).end());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
