// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/** Keep the old document snapshot until replay and the final editor update finish. */
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
    // Browsers may skip a transition (hidden tab, long replay). The replay still has to finish.
    void transition.ready.catch(() => {});
    const finished = transition.finished.catch(() => {});
    await transition.updateCallbackDone;
    await finished;
  } finally {
    style.remove();
    document.body.inert = wasInert;
  }
}
