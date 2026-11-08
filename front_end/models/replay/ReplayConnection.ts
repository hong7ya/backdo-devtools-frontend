// Copyright 2026 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as Common from '../../core/common/common.js';
import type * as Platform from '../../core/platform/platform.js';
import * as ProtocolClient from '../../core/protocol_client/protocol_client.js';
import * as SDK from '../../core/sdk/sdk.js';

import {type CalibrationProcess, measureRoundTrip} from './ReplayCalibration.js';
import {ReplayController} from './ReplayController.js';
import {type ConnectionRequest, readConnectionRequest, replaceConnectionAddress, type TargetKind, validateWebSocketURL} from './ReplayEndpoint.js';

export interface TargetAddress {
  ws: string;
  kind: TargetKind;
  pageURL?: string;
}

/** 외부 연동 계약. 더미 생성 실패·취소 때도 생성자가 소유한 프로세스를 정리해야 한다. */
export interface TargetLifecycle {
  discover(port: number, kind: TargetKind): Promise<string>;
  restart(target: TargetAddress): Promise<string>;
  createCalibrationProcess?(kind: TargetKind, signal: AbortSignal): Promise<CalibrationProcess>;
}

interface ConnectionOptions {
  kind: TargetKind;
  name: string;
  onTargetCreated: (target: SDK.Target.Target) => void;
  onConnectionLost: (message: Platform.UIString.LocalizedString) => void;
}

/** 브라우저와 Node 진입점이 함께 사용하는 연결·주소 갱신 경로. */
export class ReplayConnection {
  static #instance: ReplayConnection;
  #lifecycle: TargetLifecycle|null = null;
  #address: TargetAddress|null = null;
  #target: SDK.Target.Target|null = null;
  #pageURLToRestore = '';
  readonly #controller: ReplayController;

  constructor(controller = ReplayController.instance()) {
    this.#controller = controller;
  }

  static instance(): ReplayConnection {
    this.#instance ??= new ReplayConnection();
    return this.#instance;
  }

  setLifecycle(lifecycle: TargetLifecycle|null): void {
    this.#lifecycle = lifecycle;
    this.#controller.setRestartHandler(lifecycle ? () => this.#restartTarget() : null);
    const createProcess = lifecycle?.createCalibrationProcess?.bind(lifecycle);
    this.#controller.setCalibrationHandler(createProcess ? async signal => {
      const address = this.#address;
      if (!address) {
        throw new Error('CDP 응답 시간을 측정할 연결 정보가 없습니다.');
      }
      return await measureRoundTrip(
          cancellation => createProcess(address.kind, cancellation), address.ws, signal);
    } : null);
  }

  async initialize(options: ConnectionOptions, url = new URL(location.href)): Promise<boolean> {
    try {
      const request = readConnectionRequest(url);
      if (!request) {
        return false;
      }
      const ws = await this.resolve(request, options.kind);
      const connect = (address: string): Promise<void> => this.#connectTarget(address, options);
      this.#controller.configure(connect);
      await SDK.Connections.initMainConnection(() => connect(ws), options.onConnectionLost);
    } catch (error) {
      Common.Console.Console.instance().error(`BackDo 연결: ${error instanceof Error ? error.message : String(error)}`);
    }
    return true;
  }

  async resolve(request: ConnectionRequest, kind: TargetKind): Promise<string> {
    return 'ws' in request ? validateWebSocketURL(request.ws) : await this.#discoverTarget(request.port, kind);
  }

  async #connectTarget(ws: string, options: ConnectionOptions): Promise<void> {
    const address = validateWebSocketURL(ws);
    ProtocolClient.InspectorBackend.Connection.setFactory(() => new SDK.Connections.WebSocketConnection(
        address as Platform.DevToolsPath.UrlString, message => {
          this.#controller.fail(new Error(message));
          if (!this.#controller.busy) {
            options.onConnectionLost(message);
          }
        }));
    this.#address = {ws: address, kind: options.kind};
    const manager = SDK.TargetManager.TargetManager.instance();
    const type = options.kind === 'node' ? SDK.Target.Type.NODE : SDK.Target.Type.FRAME;
    const target = manager.createTarget('main', options.name, type, null);
    this.#target = target;
    manager.setScopeTarget(target);
    options.onTargetCreated(target);
    this.#controller.attach(target);
    const response = await target.runtimeAgent().invoke_runIfWaitingForDebugger();
    if (response.getError()) {
      throw new Error(response.getError());
    }
    replaceConnectionAddress(address);
    if (options.kind === 'page' && this.#pageURLToRestore && this.#pageURLToRestore !== 'about:blank') {
      const navigation = await target.pageAgent().invoke_navigate({url: this.#pageURLToRestore});
      if (navigation.getError() || navigation.errorText) {
        throw new Error(navigation.getError() || navigation.errorText);
      }
    }
  }

  async #discoverTarget(port: number, kind: TargetKind): Promise<string> {
    if (!this.#lifecycle) {
      throw new Error('포트 조회 연동이 아직 없습니다. 현재는 /json/list에서 확인한 ws 주소로 연결할 수 있습니다.');
    }
    return validateWebSocketURL(await this.#lifecycle.discover(port, kind));
  }

  async #restartTarget(): Promise<string> {
    if (!this.#lifecycle || !this.#address) {
      throw new Error('대상 프로세스 재시작 연동이 없습니다.');
    }
    const target = {...this.#address};
    if (target.kind === 'page') {
      this.#pageURLToRestore = this.#target?.inspectedURL() ?? '';
      target.pageURL = this.#pageURLToRestore;
    }
    return validateWebSocketURL(await this.#lifecycle.restart(target));
  }
}
