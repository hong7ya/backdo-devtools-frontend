// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/** Node 테스트와 브라우저 도우미 사이에서 주고받는 직렬화 가능한 데이터. */
export interface DisplayedSource {
  url: string;
  text: string;
}

export interface ReplaySnapshot {
  error: string|null;
  source: DisplayedSource|null;
  highlight: number[]|null;
  messages: string[];
  pauseCount: number;
}

export interface BrowserTestClient {
  ready(): boolean;
  calibrationFinished(): boolean;
  isPaused(): boolean;
  pauseReason(): string|null;
  sourceIsVisible(source: string): boolean;
  snapshot(): ReplaySnapshot;
}

declare global {
  interface Window {
    backdoTest: BrowserTestClient;
  }
}
