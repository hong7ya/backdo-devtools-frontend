// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {randomBytes} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {realpath, stat} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {ManagedProcess} from './process-manager.mjs';

const defaultFrontend = fileURLToPath(new URL('../../out/Default/gen/front_end/', import.meta.url));
const mime = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.woff2': 'font/woff2'};

export async function serveBackDo({entry, args = [], frontend = defaultFrontend, output = process.stderr}) {
  const root = await realpath(frontend);
  await stat(path.join(root, 'js_app.html'));
  const manager = new ManagedProcess({entry: await realpath(entry), args, output});
  const session = await manager.start();
  const token = randomBytes(32).toString('hex');
  const server = createServer(async (request, response) => {
    const reply = (status, body) => {
      response.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store'});
      response.end(JSON.stringify(body));
    };
    try {
      const url = new URL(request.url, origin);
      if (url.pathname.startsWith('/__backdo/')) {
        // No cross-origin control, no arbitrary executable/path/PID accepted by the API.
        if (request.headers.host !== new URL(origin).host ||
            request.headers['x-backdo-session'] !== token ||
            (request.headers.origin && request.headers.origin !== origin)) {
          reply(403, {error: 'Invalid BackDo session'});
          return;
        }
        if (url.pathname === '/__backdo/session' && request.method === 'GET') {
          reply(200, manager.session);
        } else if (url.pathname === '/__backdo/restart' && request.method === 'POST') {
          reply(200, await manager.restart());
        } else {
          reply(405, {error: 'Unsupported session operation'});
        }
        return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        reply(405, {error: 'Read only'});
        return;
      }
      const filename = await realpath(path.join(root, decodeURIComponent(url.pathname)));
      const relative = path.relative(root, filename);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !(await stat(filename)).isFile()) {
        reply(404, {error: 'Not found'});
        return;
      }
      response.writeHead(200, {
        'Content-Type': mime[path.extname(filename)] || 'application/octet-stream',
        'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      });
      if (request.method === 'HEAD') {
        response.end();
      } else {
        createReadStream(filename).on('error', () => response.destroy()).pipe(response);
      }
    } catch (error) {
      reply(error.code === 'ENOENT' ? 404 : 500, {error: error.message});
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    await manager.stop();
    throw error;
  }
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = new URL('/js_app.html', origin);
  url.searchParams.set('ws', session.ws.replace(/^ws:\/\//, ''));
  url.searchParams.set('backdoSession', token);
  return {
    url: url.href, origin, token, manager,
    async close() {
      await manager.stop();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  let frontend;
  if (args[0] === '--frontend-dir') {
    args.shift();
    frontend = args.shift();
  }
  const entry = args.shift();
  if (!entry || entry === '--help') {
    console.log('Usage: node scripts/backdo/debug.mjs [--frontend-dir DIR] entry.js [script arguments]');
    process.exitCode = entry ? 0 : 1;
  } else {
    try {
      const app = await serveBackDo({entry, args, frontend});
      console.log(`\nOpen BackDo in Chrome:\n${app.url}\n\nCtrl+C stops the owned target and server.`);
      let closing = false;
      const close = async () => {
        if (closing) {
          return;
        }
        closing = true;
        await app.close();
      };
      process.once('SIGINT', close);
      process.once('SIGTERM', close);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
