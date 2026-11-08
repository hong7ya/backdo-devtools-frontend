// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as Replay from '../../models/replay/replay.js';
import * as UI from '../../ui/legacy/legacy.js';

const {REPLAY_LIMITS, REPLAY_RESPONSE_BUDGET_MS} = Replay.ReplayLimits;
type RecordingUsage = Replay.ReplayLimits.RecordingUsage;
// 한도 도달 전에 실행 범위를 조절할 수 있도록 20%를 남겨 두고 안내하는 초기 UI 정책이다.
const WARNING_USAGE_PERCENT = 80;

const USAGE_LABELS: Record<keyof RecordingUsage, string> = {
  positions: '실행 위치',
  consoleInputs: '콘솔 입력',
  consoleBytes: '콘솔 원문',
  breakpoints: '기록 지점',
  pendingSources: '콘솔 소스',
};

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
    this.#meter.setAttribute('aria-label', '기록 한도 사용률');
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
    this.element.setAttribute('aria-busy', String(busy));
    this.button.setEnabled(enabled && !busy);
    this.#status = status;
    if (busy) {
      this.#status = calibrating ? '최초 정지 위치를 다시 열어 복원 시간을 측정하고 있습니다.' : '이전 실행 위치로 복원 중입니다.';
    }
    this.#loadingLabel.textContent = calibrating ? '측정 중' : '복원 중';
    this.button.setTitle(`${this.#status}\n${this.#usageTitle}`);
    this.#loading.hidden = !busy;
  }

  updateUsage(usage: RecordingUsage, error: string|null, estimatedReplayMs: number|null): void {
    // 서로 단위가 다른 한도 중 가장 먼저 소진될 항목의 비율을 표시한다. 전체 힙 사용률은 아니다.
    const keys = Object.keys(REPLAY_LIMITS) as Array<keyof RecordingUsage>;
    const ratio = Math.max(
        ...keys.map(key => usage[key] / REPLAY_LIMITS[key]), (estimatedReplayMs ?? 0) / REPLAY_RESPONSE_BUDGET_MS);
    const percent = Math.min(100, ratio * 100);
    const timeDescription = estimatedReplayMs === null ? '복원 시간 측정 준비 중' :
        `예상 복원 약 ${(estimatedReplayMs / 1000).toFixed(1)}초 / 기준 3초 미만`;
    const description = keys.map(key => {
      const unit = key === 'consoleBytes' ? '바이트' : '개';
      return `${USAGE_LABELS[key]} ${usage[key].toLocaleString('ko-KR')} / ${REPLAY_LIMITS[key].toLocaleString('ko-KR')}${unit}`;
    }).join('\n');
    const title = error ? `기록 종료 · 저장된 기록 해제\n${error}` : `기록 한도 ${percent.toFixed(1)}% 사용\n${timeDescription}\n${description}`;
    this.#meter.setAttribute('aria-valuenow', String(percent));
    this.#meter.setAttribute('aria-valuetext', error ? '기록 종료 · 저장된 기록 해제' : title);
    this.#fill.style.width = `${percent}%`;
    this.element.classList.toggle('recording-warning', percent >= WARNING_USAGE_PERCENT);
    this.element.classList.toggle('recording-ended', Boolean(error));
    this.#usageTitle = title;
    this.button.setTitle(`${this.#status}\n${title}`);
    UI.Tooltip.Tooltip.install(this.#meter, title);
  }
}
