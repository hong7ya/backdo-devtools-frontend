// Copyright 2018 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import '../shell/shell.js';
import '../../panels/js_timeline/js_timeline-meta.js';
import '../../panels/mobile_throttling/mobile_throttling-meta.js';
import '../../panels/network/network-meta.js';

import * as Common from '../../core/common/common.js';
import * as Host from '../../core/host/host.js';
import * as i18n from '../../core/i18n/i18n.js';
import type * as Platform from '../../core/platform/platform.js';
import * as ProtocolClient from '../../core/protocol_client/protocol_client.js';
import * as SDK from '../../core/sdk/sdk.js';
import * as Replay from '../../models/replay/replay.js';
import type * as Sources from '../../panels/sources/sources.js';
import * as Components from '../../ui/legacy/components/utils/utils.js';
import * as UI from '../../ui/legacy/legacy.js';
import * as Main from '../main/main.js';

const UIStrings = {
  /**
   *@description Text that refers to the main target.
   */
  main: 'Main',
  /**
   *@description Title of the 'Scripts' tool in the Network Navigator View, which is part of the Sources tool
   */
  networkTitle: 'Scripts',
  /**
   *@description Command for showing the 'Scripts' tool in the Network Navigator View, which is part of the Sources tool
   */
  showNode: 'Show Scripts',
};

const str_ = i18n.i18n.registerUIStrings('entrypoints/js_app/js_app.ts', UIStrings);
const i18nString = i18n.i18n.getLocalizedString.bind(undefined, str_);
const i18nLazyString = i18n.i18n.getLazilyComputedLocalizedString.bind(undefined, str_);

let jsMainImplInstance: JsMainImpl;
let loadedSourcesModule: (typeof Sources|undefined);

async function loadSourcesModule(): Promise<typeof Sources> {
  if (!loadedSourcesModule) {
    loadedSourcesModule = await import('../../panels/sources/sources.js');
  }
  return loadedSourcesModule;
}
export class JsMainImpl implements Common.Runnable.Runnable {
  static instance(opts: {forceNew: boolean|null} = {forceNew: null}): JsMainImpl {
    const {forceNew} = opts;
    if (!jsMainImplInstance || forceNew) {
      jsMainImplInstance = new JsMainImpl();
    }

    return jsMainImplInstance;
  }

  async run(): Promise<void> {
    Host.userMetrics.actionTaken(Host.UserMetrics.Action.ConnectToNodeJSDirectly);
    const token = new URL(location.href).searchParams.get('backdoSession');
    if (token) {
      const replay = Replay.ReplayController.ReplayController.instance();
      const connect = async (ws: string): Promise<void> => {
        ProtocolClient.InspectorBackend.Connection.setFactory(() => new SDK.Connections.WebSocketConnection(
            ws as Platform.DevToolsPath.UrlString, message => replay.fail(new Error(message))));
        const manager = SDK.TargetManager.TargetManager.instance();
        const target = manager.createTarget('main', i18nString(UIStrings.main), SDK.Target.Type.NODE, null);
        manager.setScopeTarget(target);
        UI.Context.Context.instance().setFlavor(SDK.Target.Target, target);
        replay.attach(target);
        const response = await target.runtimeAgent().invoke_runIfWaitingForDebugger();
        if (response.getError()) {
          throw new Error(response.getError());
        }
        const url = new URL(location.href);
        url.searchParams.delete('wss');
        url.searchParams.set('ws', ws.replace(/^ws:\/\//, ''));
        history.replaceState(history.state, '', url);
      };
      try {
        const session = await replay.configure(token, connect);
        await SDK.Connections.initMainConnection(
            () => connect(session.ws), Components.TargetDetachedDialog.TargetDetachedDialog.connectionLost);
      } catch (error) {
        replay.fail(error);
      }
      return;
    }
    void SDK.Connections.initMainConnection(async () => {
      const target = SDK.TargetManager.TargetManager.instance().createTarget(
          'main', i18nString(UIStrings.main), SDK.Target.Type.NODE, null);
      void target.runtimeAgent().invoke_runIfWaitingForDebugger();
    }, Components.TargetDetachedDialog.TargetDetachedDialog.connectionLost);
  }
}

UI.ViewManager.registerViewExtension({
  location: UI.ViewManager.ViewLocationValues.NAVIGATOR_VIEW,
  id: 'navigator-network',
  title: i18nLazyString(UIStrings.networkTitle),
  commandPrompt: i18nLazyString(UIStrings.showNode),
  order: 2,
  persistence: UI.ViewManager.ViewPersistence.PERMANENT,
  async loadView() {
    const Sources = await loadSourcesModule();
    return Sources.SourcesNavigator.NetworkNavigatorView.instance();
  },
});

Common.Runnable.registerEarlyInitializationRunnable(JsMainImpl.instance);
new Main.MainImpl.MainImpl();
