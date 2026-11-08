// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import type * as Protocol from '../../generated/protocol.js';

import {TargetManager} from './TargetManager.js';

/** 사용자 설정을 바꾸지 않고 모든 종류의 중단점 적용을 함께 멈추고 복구한다. */
export class UserBreakpoints {
  static readonly #instances = new WeakMap<TargetManager, UserBreakpoints>();
  readonly #updates = new Map<object|string, () => Promise<void>>();
  #suspended = false;
  #updating = false;

  static instance(): UserBreakpoints {
    const targetManager = TargetManager.instance();
    let instance = this.#instances.get(targetManager);
    if (!instance) {
      instance = new UserBreakpoints();
      this.#instances.set(targetManager, instance);
    }
    return instance;
  }

  get suspended(): boolean {
    return this.#suspended;
  }

  get updating(): boolean {
    return this.#updating;
  }

  register(owner: object|string, update: () => Promise<void>): void {
    this.#updates.set(owner, update);
  }

  unregister(owner: object|string): void {
    this.#updates.delete(owner);
  }

  async setSuspended(suspended: boolean): Promise<void> {
    // 새 대상과 복원 중 추가된 중단점도 즉시 같은 정책을 따른다.
    this.#suspended = suspended;
    this.#updating = true;
    try {
      await finishUpdates([...this.#updates.values()].map(update => Promise.resolve().then(update)));
    } catch (error) {
      throw new AggregateError([error],
          suspended ? '사용자 중단점을 잠시 해제하지 못했습니다.' : '사용자 중단점을 다시 적용하지 못했습니다.');
    } finally {
      this.#updating = false;
    }
  }
}

/** 설정 복구를 성공으로 표시하기 전에 실제 CDP 응답까지 확인한다. */
export async function apply(pending: Promise<Protocol.ProtocolResponseWithError>): Promise<void> {
  const response = await pending;
  const error = response.getError();
  if (error) {
    throw new Error(error);
  }
}

/** 일부 종류가 실패해도 다른 중단점의 적용이 끝나기 전에 복원을 완료하지 않는다. */
export async function finishUpdates(updates: Array<Promise<unknown>>): Promise<void> {
  const results = await Promise.allSettled(updates);
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length) {
    throw new AggregateError(failures.map(result => result.reason), '중단점 적용 실패');
  }
}
