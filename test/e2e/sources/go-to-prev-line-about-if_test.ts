// Copyright 2022 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import {assert} from 'chai';

import {click, getBrowserAndPages, goToResource, step, waitFor, waitForFunction} from '../../shared/helper.js';
import {executionLineHighlighted, PAUSE_INDICATOR_SELECTOR, STEP_INTO_BUTTON} from '../helpers/sources-helpers.js';

const BEFORE_LINE_CODE = '    if (!isSunnyDay) {';
const AFTER_LINE_CODE = '      const h = \'　　　　　🍇\';';
const GO_TO_PREV_LINE_BUTTON = '[aria-label="goToPrevLine"]';

describe('Sources Tab', () => {
  it('디버거로 인해 멈췄을 경우, 거꾸로 가기 버튼이 보여야 한다.', async () => {
    const {target} = getBrowserAndPages();
    await step('if문 예제 코드가 제공된다.', async () => {
      await goToResource('sources/go-to-prev-line-about-if.html');
    });

    await step('debugger 표현식에서 멈춘다.', async () => {
      target.evaluate('test();');
      await waitFor(PAUSE_INDICATOR_SELECTOR);
    });

    await step('거꾸로 가기 버튼이 보인다.', async () => {
      const goToPrevLineButton = await waitFor(GO_TO_PREV_LINE_BUTTON);

      assert.exists(goToPrevLineButton);
    });
  });

  it('거꾸로 가기 버튼을 클릭했을 때, 조건문에 의해 도달할 수 없는 줄은 건너뛴다.', async () => {
    const {target} = getBrowserAndPages();
    await step('if문 예제 코드가 제공된다.', async () => {
      await goToResource('sources/go-to-prev-line-about-if.html');
    });

    await step('debugger 표현식에서 멈춘다.', async () => {
      target.evaluate('test();');
      await waitFor(PAUSE_INDICATOR_SELECTOR);
    });

    await step('도달할 수 없는 줄 이전 줄까지 이동한다.', async () => {
      for (let i = 0; i < 7; i += 1) {
        await click(STEP_INTO_BUTTON);
      }

      const arrived = await waitForFunction(async () => {
        const beforeLineHandle = await executionLineHighlighted();
        const beforeText = await beforeLineHandle.evaluate(line => line.textContent);

        return beforeText === BEFORE_LINE_CODE;
      });

      assert.isTrue(arrived);
    });

    await step('도달할 수 없는 줄 다음 줄까지 이동한다.', async () => {
      await click(STEP_INTO_BUTTON);

      const arrived = await waitForFunction(async () => {
        const afterLineHandle = await executionLineHighlighted();
        const afterText = await afterLineHandle.evaluate(line => line.textContent);

        return afterText === AFTER_LINE_CODE;
      });

      assert.isTrue(arrived);
    });

    await step('거꾸로 가기 버튼을 클릭한다.', async () => {
      await click(GO_TO_PREV_LINE_BUTTON);
    });

    await step('도달할 수 없는 줄 이전 줄에서 멈춘다.', async () => {
      const arrived = await waitForFunction(async () => {
        const beforeLineHandle = await executionLineHighlighted();
        const beforeText = await beforeLineHandle.evaluate(line => line.textContent);

        return beforeText === BEFORE_LINE_CODE;
      });

      assert.isTrue(arrived);
    });
  });
});
