// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/** Node 테스트와 브라우저 도우미 사이에서 주고받는 직렬화 가능한 데이터. */
export interface RecordedPosition {
  url: string;
  hash: string;
  lineNumber: number;
  columnNumber: number;
}

export interface HistorySnapshot {
  target: RecordedPosition;
  length: number;
}

export interface ReplaySnapshot {
  error: string|null;
  position: RecordedPosition|null;
  highlight: number[]|null;
  messages: string[];
  sameDocument: boolean;
  sameTimeOrigin: boolean;
  sameHistoryLength: boolean;
  historyState: unknown;
  ws: string|null;
  visiblePauses: number[][];
  transitions: string[];
}

export interface BrowserTestClient {
  isPaused(): boolean;
  runToLine(lineNumber: number): Promise<void>;
  isPausedAtLine(lineNumber: number): boolean;
  previous(): HistorySnapshot;
  replayFinished(previousLength: number): boolean;
  snapshot(): ReplaySnapshot;
}

declare global {
  interface Window {
    backdoTest: BrowserTestClient;
  }
}
