// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/** 재실행과 최종 에디터 갱신이 끝날 때까지 이전 화면의 스냅샷을 유지한다. */
export async function withReplayTransition(update: () => Promise<void>): Promise<void> {
  const wasInert = document.body.inert;
  document.body.inert = true;
  const style = document.createElement('style');
  style.textContent = `
    ::view-transition-group(root), ::view-transition-old(root), ::view-transition-new(root) {
      animation-duration: 220ms;
      animation-timing-function: ease-in-out;
    }
    @media (prefers-reduced-motion: reduce) {
      ::view-transition-group(root), ::view-transition-old(root), ::view-transition-new(root) {
        animation-duration: 0s;
      }
    }
  `;
  document.head.appendChild(style);
  try {
    if (!document.startViewTransition) {
      await update();
      return;
    }
    const transition = document.startViewTransition(update);
    // 숨겨진 탭이나 긴 재실행에서는 전환이 생략될 수 있지만, 재실행 완료는 계속 기다린다.
    void transition.ready.catch(() => {});
    const finished = transition.finished.catch(() => {});
    await transition.updateCallbackDone;
    await finished;
  } finally {
    style.remove();
    document.body.inert = wasInert;
  }
}
