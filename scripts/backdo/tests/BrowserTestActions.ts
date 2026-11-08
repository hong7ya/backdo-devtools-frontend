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
