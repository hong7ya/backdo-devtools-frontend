// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {serveBackDo} from './DebugServer.js';

async function main(args: string[]): Promise<void> {
  const options = readOptions(args);
  if (!options) {
    return;
  }
  const server = await serveBackDo(options);
  console.log(`\nChrome에서 다음 주소를 여세요.\n${server.url}\n\nCtrl+C를 누르면 대상 프로세스와 서버가 종료됩니다.`);
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    await server.close();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

function readOptions(args: string[]): {entry: string, args: string[], frontend?: string}|null {
  let frontend: string|undefined;
  if (args[0] === '--frontend-dir') {
    args.shift();
    frontend = args.shift();
    if (!frontend) {
      throw new Error('--frontend-dir 뒤에 빌드한 프런트엔드 경로를 지정하세요.');
    }
  }
  const entry = args.shift();
  if (!entry || entry === '--help') {
    console.log('사용법: node out/Default/gen/scripts/backdo/debug.js [--frontend-dir 경로] 대상.js [대상 인자]');
    process.exitCode = entry ? 0 : 1;
    return null;
  }
  return {entry, args, frontend};
}

if (require.main === module) {
  void main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
