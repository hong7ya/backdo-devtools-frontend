// Copyright 2014 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as Common from '../../core/common/common.js';
import * as i18n from '../../core/i18n/i18n.js';
import * as SDK from '../../core/sdk/sdk.js';
import * as Replay from '../../models/replay/replay.js';
import * as UI from '../../ui/legacy/legacy.js';

import {ScreencastView} from './ScreencastView.js';

const UIStrings = {
  /**
   *@description Tooltip text that appears when hovering over largeicon phone button in Screencast App of the Remote Devices tab when toggling screencast
   */
  toggleScreencast: 'Toggle screencast',
};
const str_ = i18n.i18n.registerUIStrings('panels/screencast/ScreencastApp.ts', UIStrings);
const i18nString = i18n.i18n.getLocalizedString.bind(undefined, str_);
let appInstance: ScreencastApp;

export class ScreencastApp implements Common.App.App,
                                      SDK.TargetManager.SDKModelObserver<SDK.ScreenCaptureModel.ScreenCaptureModel> {
  private readonly enabledSetting: Common.Settings.Setting<boolean>;
  toggleButton: UI.Toolbar.ToolbarToggle;
  private rootSplitWidget?: UI.SplitWidget.SplitWidget;
  private screenCaptureModel?: SDK.ScreenCaptureModel.ScreenCaptureModel;
  private screencastView?: ScreencastView;
  rootView?: UI.RootView.RootView;
  constructor() {
    this.enabledSetting = Common.Settings.Settings.instance().createSetting('screencast-enabled', true);
    this.toggleButton = new UI.Toolbar.ToolbarToggle(i18nString(UIStrings.toggleScreencast), 'devices');
    this.toggleButton.setToggled(this.enabledSetting.get());
    this.toggleButton.setEnabled(false);
    this.toggleButton.addEventListener(UI.Toolbar.ToolbarButton.Events.CLICK, this.toggleButtonClicked, this);
    SDK.TargetManager.TargetManager.instance().observeModels(SDK.ScreenCaptureModel.ScreenCaptureModel, this);
    Replay.ReplayController.ReplayController.instance().addEventListener(
        Replay.ReplayController.Events.CHANGED, this.onReplayStateChanged, this);
  }

  static instance(): ScreencastApp {
    if (!appInstance) {
      appInstance = new ScreencastApp();
    }
    return appInstance;
  }

  presentUI(document: Document): void {
    this.rootView = new UI.RootView.RootView();

    this.rootSplitWidget =
        new UI.SplitWidget.SplitWidget(false, true, 'inspector-view.screencast-split-view-state', 300, 300);
    this.rootSplitWidget.setVertical(true);
    this.rootSplitWidget.setSecondIsSidebar(true);
    this.rootSplitWidget.show(this.rootView.element);
    this.rootSplitWidget.hideMain();

    this.rootSplitWidget.setSidebarWidget(UI.InspectorView.InspectorView.instance());
    UI.InspectorView.InspectorView.instance().setOwnerSplit(this.rootSplitWidget);
    this.rootView.attachToDocument(document);
    this.rootView.focus();
  }

  modelAdded(screenCaptureModel: SDK.ScreenCaptureModel.ScreenCaptureModel): void {
    if (screenCaptureModel.target() !== SDK.TargetManager.TargetManager.instance().primaryPageTarget()) {
      return;
    }
    this.screenCaptureModel = screenCaptureModel;
    this.toggleButton.setEnabled(true);
    this.screencastView?.detach();
    this.screencastView = new ScreencastView(screenCaptureModel);
    if (this.rootSplitWidget) {
      this.rootSplitWidget.setMainWidget(this.screencastView);
    }
    this.screencastView.initialize();
    this.screencastView.setReplayInProgress(Replay.ReplayController.ReplayController.instance().busy);
    this.onScreencastEnabledChanged();
  }

  modelRemoved(screenCaptureModel: SDK.ScreenCaptureModel.ScreenCaptureModel): void {
    if (this.screenCaptureModel !== screenCaptureModel) {
      return;
    }
    delete this.screenCaptureModel;
    this.toggleButton.setEnabled(false);
    if (Replay.ReplayController.ReplayController.instance().busy && this.screencastView) {
      // 프로세스 교체 중에도 마지막 프레임과 분할 폭을 유지하되 종료한 대상에 입력하지 않는다.
      this.screencastView.setReplayInProgress(true);
      return;
    }
    this.clearScreencastView();
  }

  private clearScreencastView(): void {
    if (this.screencastView) {
      this.screencastView.detach();
      delete this.screencastView;
    }
    this.onScreencastEnabledChanged();
  }

  private onReplayStateChanged(): void {
    const busy = Replay.ReplayController.ReplayController.instance().busy;
    if (!busy && !this.screenCaptureModel && this.screencastView) {
      // 새 대상이 만들어지지 못한 경우에는 이전 프레임을 계속 연결된 화면처럼 남기지 않는다.
      this.clearScreencastView();
      return;
    }
    this.screencastView?.setReplayInProgress(busy);
  }

  private toggleButtonClicked(): void {
    const enabled = this.toggleButton.isToggled();
    this.enabledSetting.set(enabled);
    this.onScreencastEnabledChanged();
  }

  private onScreencastEnabledChanged(): void {
    if (!this.rootSplitWidget) {
      return;
    }
    const enabled = Boolean(this.enabledSetting.get() && this.screencastView);
    this.toggleButton.setToggled(enabled);
    if (enabled) {
      this.rootSplitWidget.showBoth();
    } else {
      this.rootSplitWidget.hideMain();
    }
  }
}

let toolbarButtonProviderInstance: ToolbarButtonProvider;

export class ToolbarButtonProvider implements UI.Toolbar.Provider {
  static instance(opts: {forceNew: boolean} = {forceNew: false}): ToolbarButtonProvider {
    const {forceNew} = opts;
    if (!toolbarButtonProviderInstance || forceNew) {
      toolbarButtonProviderInstance = new ToolbarButtonProvider();
    }

    return toolbarButtonProviderInstance;
  }

  item(): UI.Toolbar.ToolbarItem|null {
    return ScreencastApp.instance().toggleButton;
  }
}

let screencastAppProviderInstance: ScreencastAppProvider;

export class ScreencastAppProvider implements Common.AppProvider.AppProvider {
  static instance(opts: {forceNew: boolean} = {forceNew: false}): ScreencastAppProvider {
    const {forceNew} = opts;
    if (!screencastAppProviderInstance || forceNew) {
      screencastAppProviderInstance = new ScreencastAppProvider();
    }

    return screencastAppProviderInstance;
  }

  createApp(): Common.App.App {
    return ScreencastApp.instance();
  }
}
