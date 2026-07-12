import { genId, type Mirror } from "../../rrweb-snapshot/index.ts";
import {
  EventType,
  IncrementalSource,
  NodeType,
  type eventWithTime,
  type eventWithoutTime,
  type serializedNodeWithId,
} from "../../rrweb-types/index.ts";
import type { CrossOriginIframeMessageEvent } from "../types.ts";
import CrossOriginIframeMirror from "./cross-origin-iframe-mirror.ts";
import type { StylesheetManager } from "./stylesheet-manager.ts";

export class CrossOriginIframeManager {
  public readonly nodeMirror = new CrossOriginIframeMirror(genId);
  public readonly styleMirror: CrossOriginIframeMirror;
  private readonly iframeByWindow = new WeakMap<MessageEventSource, HTMLIFrameElement>();
  private readonly rootIdByIframe = new WeakMap<HTMLIFrameElement, number>();
  private readonly nestedWindowCleanups: Array<() => void> = [];
  private readonly mirror: Mirror;
  private readonly wrappedEmit: (
    event: eventWithoutTime,
    isCheckout?: boolean,
    timestamp?: number,
  ) => void;
  private readonly shouldRecordIframe: (iframe: HTMLIFrameElement) => boolean;
  private readonly enabled: boolean;
  private readonly handleWindowMessage = (message: MessageEvent) => this.handleMessage(message);

  public constructor(options: {
    mirror: Mirror;
    stylesheetManager: StylesheetManager;
    wrappedEmit: (event: eventWithoutTime, isCheckout?: boolean, timestamp?: number) => void;
    shouldRecordIframe: (iframe: HTMLIFrameElement) => boolean;
    enabled: boolean;
  }) {
    this.mirror = options.mirror;
    this.wrappedEmit = options.wrappedEmit;
    this.shouldRecordIframe = options.shouldRecordIframe;
    this.enabled = options.enabled;
    this.styleMirror = new CrossOriginIframeMirror(
      options.stylesheetManager.styleMirror.generateId.bind(options.stylesheetManager.styleMirror),
    );
    if (this.enabled) window.addEventListener("message", this.handleWindowMessage);
  }

  public addIframe(iframe: HTMLIFrameElement): void {
    if (!this.enabled) return;
    if (iframe.contentWindow !== null) this.iframeByWindow.set(iframe.contentWindow, iframe);
  }

  public observeNestedIframes(iframe: HTMLIFrameElement): void {
    if (!this.enabled) return;
    const nestedWindow = iframe.contentWindow;
    if (nestedWindow === null) return;
    nestedWindow.addEventListener("message", this.handleWindowMessage);
    this.nestedWindowCleanups.push(() =>
      nestedWindow.removeEventListener("message", this.handleWindowMessage),
    );
  }

  public stop(): void {
    window.removeEventListener("message", this.handleWindowMessage);
    this.clearNestedIframes();
  }

  public clearNestedIframes(): void {
    for (const cleanup of this.nestedWindowCleanups.splice(0)) cleanup();
  }

  private handleMessage(message: MessageEvent | CrossOriginIframeMessageEvent): void {
    const crossOriginMessage = message as CrossOriginIframeMessageEvent;
    if (
      crossOriginMessage.data.type !== "rrweb" ||
      crossOriginMessage.origin !== crossOriginMessage.data.origin ||
      message.source === null
    ) {
      return;
    }
    const iframe = this.iframeByWindow.get(message.source);
    if (iframe === undefined || !this.shouldRecordIframe(iframe)) return;
    const event = this.transformEvent(iframe, crossOriginMessage.data.event);
    if (event !== false) this.wrappedEmit(event, crossOriginMessage.data.isCheckout);
  }

  private transformEvent(iframe: HTMLIFrameElement, event: eventWithTime): eventWithTime | false {
    switch (event.type) {
      case EventType.FullSnapshot: {
        this.nodeMirror.reset(iframe);
        this.styleMirror.reset(iframe);
        this.replaceIdOnNode(event.data.node, iframe);
        const rootId = event.data.node.id;
        this.rootIdByIframe.set(iframe, rootId);
        this.patchRootIdOnNode(event.data.node, rootId);
        return {
          timestamp: event.timestamp,
          type: EventType.IncrementalSnapshot,
          data: {
            source: IncrementalSource.Mutation,
            adds: [
              {
                parentId: this.mirror.getId(iframe),
                nextId: null,
                node: event.data.node,
              },
            ],
            removes: [],
            texts: [],
            attributes: [],
            isAttachIframe: true,
          },
        };
      }
      case EventType.Meta:
      case EventType.Load:
      case EventType.DomContentLoaded:
        return false;
      case EventType.Plugin:
        return event;
      case EventType.Custom:
        this.replaceIds(
          event.data.payload as {
            id?: unknown;
            parentId?: unknown;
            previousId?: unknown;
            nextId?: unknown;
          },
          iframe,
          ["id", "parentId", "previousId", "nextId"],
        );
        return event;
      case EventType.IncrementalSnapshot:
        return this.transformIncrementalEvent(iframe, event);
    }
    return false;
  }

  private transformIncrementalEvent(
    iframe: HTMLIFrameElement,
    event: Extract<eventWithTime, { type: EventType.IncrementalSnapshot }>,
  ): eventWithTime | false {
    switch (event.data.source) {
      case IncrementalSource.Mutation:
        for (const addition of event.data.adds) {
          this.replaceIds(addition, iframe, ["parentId", "nextId", "previousId"]);
          this.replaceIdOnNode(addition.node, iframe);
          const rootId = this.rootIdByIframe.get(iframe);
          if (rootId !== undefined) this.patchRootIdOnNode(addition.node, rootId);
        }
        for (const removal of event.data.removes) {
          this.replaceIds(removal, iframe, ["parentId", "id"]);
        }
        for (const attribute of event.data.attributes) this.replaceIds(attribute, iframe, ["id"]);
        for (const text of event.data.texts) this.replaceIds(text, iframe, ["id"]);
        return event;
      case IncrementalSource.Drag:
      case IncrementalSource.TouchMove:
      case IncrementalSource.MouseMove:
        for (const position of event.data.positions) this.replaceIds(position, iframe, ["id"]);
        return event;
      case IncrementalSource.ViewportResize:
        return false;
      case IncrementalSource.MediaInteraction:
      case IncrementalSource.MouseInteraction:
      case IncrementalSource.Scroll:
      case IncrementalSource.CanvasMutation:
      case IncrementalSource.Input:
        this.replaceIds(event.data, iframe, ["id"]);
        return event;
      case IncrementalSource.StyleSheetRule:
      case IncrementalSource.StyleDeclaration:
        this.replaceIds(event.data, iframe, ["id"]);
        this.replaceStyleIds(event.data, iframe, ["styleId"]);
        return event;
      case IncrementalSource.Font:
        return event;
      case IncrementalSource.Selection:
        for (const range of event.data.ranges) this.replaceIds(range, iframe, ["start", "end"]);
        return event;
      case IncrementalSource.AdoptedStyleSheet:
        this.replaceIds(event.data, iframe, ["id"]);
        this.replaceStyleIds(event.data, iframe, ["styleIds"]);
        for (const style of event.data.styles ?? []) {
          this.replaceStyleIds(style, iframe, ["styleId"]);
        }
        return event;
    }
    return false;
  }

  private replace<T extends Record<string, unknown>>(
    iframeMirror: CrossOriginIframeMirror,
    object: T,
    iframe: HTMLIFrameElement,
    keys: Array<keyof T>,
  ): T {
    for (const key of keys) {
      const value = object[key];
      if (Array.isArray(value)) {
        object[key] = iframeMirror.getIds(iframe, value as number[]) as T[keyof T];
      } else if (typeof value === "number") {
        object[key] = iframeMirror.getId(iframe, value) as T[keyof T];
      }
    }
    return object;
  }

  private replaceIds<T extends Record<string, unknown>>(
    object: T,
    iframe: HTMLIFrameElement,
    keys: Array<keyof T>,
  ): T {
    return this.replace(this.nodeMirror, object, iframe, keys);
  }

  private replaceStyleIds<T extends Record<string, unknown>>(
    object: T,
    iframe: HTMLIFrameElement,
    keys: Array<keyof T>,
  ): T {
    return this.replace(this.styleMirror, object, iframe, keys);
  }

  private replaceIdOnNode(node: serializedNodeWithId, iframe: HTMLIFrameElement): void {
    this.replaceIds(node, iframe, ["id", "rootId"]);
    if ("childNodes" in node) {
      for (const child of node.childNodes) this.replaceIdOnNode(child, iframe);
    }
  }

  private patchRootIdOnNode(node: serializedNodeWithId, rootId: number): void {
    if (node.type !== NodeType.Document && !node.rootId) node.rootId = rootId;
    if ("childNodes" in node) {
      for (const child of node.childNodes) this.patchRootIdOnNode(child, rootId);
    }
  }
}
