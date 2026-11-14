// Copyright 2017 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as SDK from '../../core/sdk/sdk.js';
import type * as ProtocolProxyApi from '../../generated/protocol-proxy-api.js';
import * as Protocol from '../../generated/protocol.js';

const BUTTONS = [
  Protocol.Input.MouseButton.Left,
  Protocol.Input.MouseButton.Middle,
  Protocol.Input.MouseButton.Right,
  Protocol.Input.MouseButton.Back,
  Protocol.Input.MouseButton.Forward,
];
const MOUSE_EVENT_TYPES: {[key: string]: Protocol.Input.DispatchMouseEventRequestType} = {
  mousedown: Protocol.Input.DispatchMouseEventRequestType.MousePressed,
  mouseup: Protocol.Input.DispatchMouseEventRequestType.MouseReleased,
  mousemove: Protocol.Input.DispatchMouseEventRequestType.MouseMoved,
};

export const enum Events {
  USER_INPUT = 'UserInput',
}

export type UserInput = {
  type: 'mouse',
  params: Protocol.Input.DispatchMouseEventRequest,
}|{type: 'key', params: Protocol.Input.DispatchKeyEventRequest};

export interface UserInputEvent {
  input: UserInput;
  completion: Promise<void>;
}

interface EventTypes {
  [Events.USER_INPUT]: UserInputEvent;
}

export class InputModel extends SDK.SDKModel.SDKModel<EventTypes> {
  private readonly inputAgent: ProtocolProxyApi.InputApi;
  private activeMouseOffsetTop: number|null;

  constructor(target: SDK.Target.Target) {
    super(target);
    this.inputAgent = target.inputAgent();
    this.activeMouseOffsetTop = null;
  }

  emitKeyEvent(event: KeyboardEvent): void {
    let type: Protocol.Input.DispatchKeyEventRequestType;
    switch (event.type) {
      case 'keydown':
        type = Protocol.Input.DispatchKeyEventRequestType.KeyDown;
        break;
      case 'keyup':
        type = Protocol.Input.DispatchKeyEventRequestType.KeyUp;
        break;
      case 'keypress':
        type = Protocol.Input.DispatchKeyEventRequestType.Char;
        break;
      default:
        return;
    }
    const text = event.type === 'keypress' ? String.fromCharCode(event.charCode) : undefined;
    const params: Protocol.Input.DispatchKeyEventRequest = {
      type,
      modifiers: this.modifiersForEvent(event),
      text,
      unmodifiedText: text ? text.toLowerCase() : undefined,
      keyIdentifier: (event as {keyIdentifier?: string}).keyIdentifier,
      code: event.code,
      key: event.key,
      windowsVirtualKeyCode: event.keyCode,
      autoRepeat: event.repeat,
      isKeypad: event.location === 3,
      isSystemKey: false,
      location: event.location !== 3 ? event.location : undefined,
    };
    this.dispatchInput({type: 'key', params});
  }

  emitMouseEvent(event: MouseEvent, offsetTop: number, zoom: number): void {
    if (!(event.type in MOUSE_EVENT_TYPES)) {
      return;
    }
    if (event.type === 'mousedown' || this.activeMouseOffsetTop === null) {
      this.activeMouseOffsetTop = offsetTop;
    }
    const params: Protocol.Input.DispatchMouseEventRequest = {
      type: MOUSE_EVENT_TYPES[event.type],
      x: Math.round(event.offsetX / zoom),
      y: Math.round(event.offsetY / zoom - this.activeMouseOffsetTop),
      modifiers: this.modifiersForEvent(event),
      button: BUTTONS[event.button],
      buttons: event.buttons,
      clickCount: event.detail,
    };
    this.dispatchInput({type: 'mouse', params});
    if (event.type === 'mouseup') {
      this.activeMouseOffsetTop = null;
    }
  }

  emitWheelEvent(event: WheelEvent, offsetTop: number, zoom: number): void {
    if (this.activeMouseOffsetTop === null) {
      this.activeMouseOffsetTop = offsetTop;
    }
    const params: Protocol.Input.DispatchMouseEventRequest = {
      type: Protocol.Input.DispatchMouseEventRequestType.MouseWheel,
      x: Math.round(event.offsetX / zoom),
      y: Math.round(event.offsetY / zoom - this.activeMouseOffsetTop),
      modifiers: this.modifiersForEvent(event),
      button: BUTTONS[event.button],
      buttons: event.buttons,
      clickCount: event.detail,
      deltaX: event.deltaX / zoom,
      deltaY: event.deltaY / zoom,
    };
    this.dispatchInput({type: 'mouse', params});
  }

  private dispatchInput(input: UserInput): void {
    const completion = Promise.withResolvers<void>();
    this.dispatchEventToListeners(Events.USER_INPUT, {input, completion: completion.promise});
    const response = input.type === 'key' ? this.inputAgent.invoke_dispatchKeyEvent(input.params) :
                                            this.inputAgent.invoke_dispatchMouseEvent(input.params);
    void response.then(() => completion.resolve());
  }

  private modifiersForEvent(event: KeyboardEvent|MouseEvent): number {
    return Number(event.getModifierState('Alt')) | (Number(event.getModifierState('Control')) << 1) |
        (Number(event.getModifierState('Meta')) << 2) | (Number(event.getModifierState('Shift')) << 3);
  }
}

SDK.SDKModel.SDKModel.register(InputModel, {
  capabilities: SDK.Target.Capability.INPUT,
  autostart: false,
});
