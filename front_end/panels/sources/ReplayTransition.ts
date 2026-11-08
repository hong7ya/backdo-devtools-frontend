// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/** 소스 패널의 이전 모습만 유지한다. 복원 작업을 화면 캡처 콜백 안에서 기다리지 않는다. */
export async function withReplayTransition(
    panel: HTMLElement, signal: AbortSignal, update: () => Promise<void>): Promise<void> {
  if (!document.startViewTransition || signal.aborted) {
    await update();
    return;
  }
  const originalName = panel.style.viewTransitionName;
  const wasInert = panel.inert;
  const style = document.createElement('style');
  style.textContent = `
    :root { view-transition-name: none; }
    ::view-transition { pointer-events: none; }
    ::view-transition-group(backdo-panel), ::view-transition-group(backdo-control) { animation: none; }
    ::view-transition-old(backdo-panel) { animation: backdo-hold 1s infinite; opacity: 1; }
    ::view-transition-new(backdo-panel) { animation: none; opacity: 0; }
    ::view-transition-old(backdo-control) { display: none; }
    ::view-transition-new(backdo-control) { animation: none; }
    @keyframes backdo-hold { from { opacity: 1; } to { opacity: 1; } }
    @keyframes backdo-fade-out { from { opacity: 1; } to { opacity: 0; } }
    @keyframes backdo-fade-in { from { opacity: 0; } to { opacity: 1; } }
    :root.backdo-reveal::view-transition-old(backdo-panel) {
      animation: backdo-fade-out 220ms ease-in-out both;
    }
    :root.backdo-reveal::view-transition-new(backdo-panel) {
      animation: backdo-fade-in 220ms ease-in-out both;
    }
    @media (prefers-reduced-motion: reduce) {
      :root.backdo-reveal::view-transition-old(backdo-panel),
      :root.backdo-reveal::view-transition-new(backdo-panel) { animation-duration: 0s; }
    }
  `;
  document.head.appendChild(style);
  panel.style.viewTransitionName = 'backdo-panel';
  panel.inert = true;
  let transition: ViewTransition|undefined;
  const skip = (): void => transition?.skipTransition();
  try {
    transition = document.startViewTransition(() => {});
    signal.addEventListener('abort', skip, {once: true});
    const finished = transition.finished.catch(() => {});
    // 캡처만 끝낸 뒤 재실행한다. 갱신 콜백을 오래 붙잡으면 문서 렌더링까지 멈춘다.
    await transition.ready.catch(() => {});
    await update();
    document.documentElement.classList.add('backdo-reveal');
    await finished;
  } finally {
    transition?.skipTransition();
    signal.removeEventListener('abort', skip);
    document.documentElement.classList.remove('backdo-reveal');
    style.remove();
    panel.style.viewTransitionName = originalName;
    panel.inert = wasInert;
  }
}
