// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as Replay from '../../models/replay/replay.js';
import * as UI from '../../ui/legacy/legacy.js';

const {REPLAY_RESPONSE_BUDGET_MS} = Replay.ReplayLimits;
// 한도 도달 전에 실행 범위를 조절할 수 있도록 20%를 남겨 두고 안내하는 초기 UI 정책이다.
const WARNING_USAGE_PERCENT = 80;

/** 거꾸로가기 버튼, 기록 한도 막대, 복원 중 표시를 한 영역에서 관리한다. */
export class ReplayToolbar extends UI.Toolbar.ToolbarItem {
  readonly button = new UI.Toolbar.ToolbarButton('기록된 직전 위치로 이동', 'go-to-prev-line');
  readonly #meter: HTMLDivElement;
  readonly #fill: HTMLDivElement;
  readonly #loading: HTMLSpanElement;
  readonly #loadingLabel: HTMLSpanElement;
  #status = '';
  #usageTitle = '';

  constructor() {
    super(document.createElement('div'));
    this.element.classList.add('backdo-replay-control');
    this.button.element.dataset.backdoAction = 'reverse';
    this.button.setEnabled(false);
    this.element.appendChild(this.button.element);

    this.#meter = this.element.createChild('div', 'backdo-recording-meter');
    this.#meter.setAttribute('role', 'meter');
    this.#meter.setAttribute('aria-label', 'CDP 처리 시간 예산 사용률');
    this.#meter.setAttribute('aria-valuemin', '0');
    this.#meter.setAttribute('aria-valuemax', '100');
    this.#fill = this.#meter.createChild('div', 'backdo-recording-fill');

    this.#loading = this.element.createChild('span', 'backdo-replay-loading');
    this.#loading.setAttribute('role', 'status');
    this.#loading.hidden = true;
    this.#loading.createChild('span', 'backdo-replay-spinner').setAttribute('aria-hidden', 'true');
    this.#loadingLabel = this.#loading.createChild('span');
    this.#loadingLabel.textContent = '복원 중';
  }

  updateState({busy, enabled, status, calibrating}:
                  {busy: boolean, enabled: boolean, status: string, calibrating: boolean}): void {
    this.element.setAttribute('aria-busy', String(busy || calibrating));
    this.button.setEnabled(enabled && !busy && !calibrating);
    this.element.classList.toggle('backdo-replay-disabled', !this.button.enabled);
    this.#status = status;
    if (busy || calibrating) {
      this.#status = calibrating ? '사용자 코드와 분리된 프로그램에서 CDP 요청·응답 시간을 확인하고 있습니다.' :
                                   '이전 실행 위치로 복원 중입니다.';
    }
    this.#loadingLabel.textContent = calibrating ? 'CDP 응답 확인 중' : '복원 중';
    this.#updateTooltip();
    this.#loading.hidden = !busy && !calibrating;
  }

  updateUsage(error: string|null, estimatedReplayMs: number|null): void {
    const ratio = (estimatedReplayMs ?? 0) / REPLAY_RESPONSE_BUDGET_MS;
    const percent = Math.min(100, ratio * 100);
    const timeDescription = estimatedReplayMs === null ?
        'CDP 응답 시간 측정 준비 중' :
        `예상 CDP 처리 약 ${(estimatedReplayMs / 1000).toFixed(1)}초 / 기준 3초 미만 (재시작·코드 실행·화면 표시 제외)`;
    const title = error ? `기록 종료 · 저장된 기록 해제\n${error}` :
                          `CDP 처리 시간 예산 ${percent.toFixed(1)}% 사용\n${timeDescription}`;
    this.#meter.setAttribute('aria-valuenow', String(percent));
    this.#meter.setAttribute('aria-valuetext', error ? '기록 종료 · 저장된 기록 해제' : title);
    this.#fill.style.width = `${percent}%`;
    this.element.classList.toggle('recording-warning', percent >= WARNING_USAGE_PERCENT);
    this.element.classList.toggle('recording-ended', Boolean(error));
    this.#usageTitle = title;
    this.#updateTooltip();
    UI.Tooltip.Tooltip.install(this.#meter, title);
  }

  #updateTooltip(): void {
    const title = `${this.#status}\n${this.#usageTitle}`;
    this.button.setTitle(title);
    // 비활성 버튼이 마우스 이벤트를 받지 않아도 바깥 영역에서 사유를 확인할 수 있다.
    UI.Tooltip.Tooltip.install(this.element, title);
    this.element.setAttribute('aria-label', title);
  }
}
