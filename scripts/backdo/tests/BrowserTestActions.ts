// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import type {Page} from 'puppeteer-core';

import {typeIntoConsole} from '../../../test/e2e/helpers/console-helpers.js';
import {pasteText} from '../../../test/shared/helper.js';

export async function enterConsoleCode(page: Page, source: string): Promise<void> {
  await page.locator('pierce/#tab-console').click();
  if (!source.includes('\n')) {
    await typeIntoConsole(page, source);
    return;
  }
  // 기존 콘솔 도우미의 한 줄 자동완성 대기를 여러 줄 원문에는 적용하지 않는다.
  await page.locator('pierce/[aria-label="Console prompt"]').click();
  await pasteText(source, page);
  await page.keyboard.press('Enter');
}

/** Console 패널을 통해 현재 연결된 Chrome 또는 Node에서 식을 평가한다. */
export async function evaluateInConsole(page: Page, expression: string): Promise<string> {
  await page.locator('pierce/#tab-console').click();
  const messages = await page.waitForSelector('pierce/#console-messages', {visible: true});
  if (!messages) {
    throw new Error('Console 메시지 영역을 찾지 못했습니다.');
  }
  // 같은 식을 다시 입력해도 기존 명령의 결과를 이번 결과로 읽지 않는다.
  const previousCommands =
      await messages.evaluateHandle(element => new Set(element.querySelectorAll('.console-user-command')));
  try {
    await enterConsoleCode(page, expression);
    const result = await page.waitForFunction((element, previous, input) => {
      const command = Array.from(element.querySelectorAll('.console-user-command'))
                          .findLast(command => !previous.has(command) && command.textContent?.trim() === input);
      const output = command?.closest('.console-message-wrapper')
                         ?.nextElementSibling?.querySelector('.console-user-command-result');
      return output ? {text: output.textContent?.trim() ?? ''} : null;
    }, {timeout: 15_000}, messages, previousCommands, expression);
    try {
      const value = await result.jsonValue();
      if (!value) {
        throw new Error(`이번 Console 명령의 결과가 없습니다: ${expression}`);
      }
      return value.text;
    } finally {
      await result.dispose();
    }
  } finally {
    await previousCommands.dispose();
    await messages.dispose();
  }
}
