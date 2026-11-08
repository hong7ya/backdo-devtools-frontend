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
  calibrated: boolean;
  estimatedReplayMs: number|null;
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
  useTestLifecycle(): void;
  ready(): boolean;
  calibrationFinished(): boolean;
  historyLength(): number;
  isPaused(): boolean;
  isPausedAtLine(lineNumber: number): boolean;
  previous(): HistorySnapshot;
  replayFinished(previousLength: number): boolean;
  snapshot(): ReplaySnapshot;
}

declare global {
  interface Window {
    backdoTest: BrowserTestClient;
    createBackDoCalibrationProcess(kind: 'node'|'page'): Promise<string>;
    disposeBackDoCalibrationProcess(ws: string): Promise<void>;
    restartBackDoTestTarget(target: {ws: string, kind: 'node'|'page'}): Promise<string>;
    discoverBackDoTestTarget(port: number, kind: 'node'|'page'): Promise<string>;
  }
}
