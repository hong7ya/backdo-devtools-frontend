// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import type * as SDK from '../../core/sdk/sdk.js';
import type * as Protocol from '../../generated/protocol.js';

/** 원본 파일과 생성된 파일의 같은 URL도 서로 다른 기록 범위다. */
export function sourceKey(url: string, original = false): string {
  return `${original ? 'source' : 'script'}:${url}`;
}

export class ScriptScope {
  private constructor(
      readonly script: SDK.Script.Script, readonly url: string, readonly sourceMap: SDK.SourceMap.SourceMap|undefined) {
  }

  static async create(script: SDK.Script.Script, url: string): Promise<ScriptScope> {
    const map = await script.debuggerModel.sourceMapManager().sourceMapForClientPromise(script);
    return new ScriptScope(script, url, map);
  }

  sourceAt(location: Protocol.Debugger.Location): string {
    const relative = this.script.rawLocationToRelativeLocation(
        {lineNumber: location.lineNumber, columnNumber: location.columnNumber ?? 0});
    const entry = this.sourceMap?.findEntry(relative.lineNumber, relative.columnNumber);
    return entry?.sourceURL ? sourceKey(entry.sourceURL, true) : sourceKey(this.url);
  }

  includes(location: Protocol.Debugger.Location, selected: ReadonlySet<string>): boolean {
    // 생성된 파일에 직접 중단점을 놓았다면 그 실행 스크립트 전체를 선택한 것이다.
    return selected.has(sourceKey(this.url)) || selected.has(this.sourceAt(location));
  }

  hasSelectedSource(selected: ReadonlySet<string>): boolean {
    return selected.has(sourceKey(this.url)) ||
        (this.sourceMap?.sourceURLs().some(url => selected.has(sourceKey(url, true))) ?? false);
  }
}
