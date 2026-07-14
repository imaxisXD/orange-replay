import {
  genId,
  snapshotInChunks,
  slimDOMDefaults,
  closestPrivacyElement,
  needMaskingText,
  yieldForPaint,
  type MaskInputOptions,
  type CapturedTopology,
  type SnapshotOptions,
  createMirror,
  getSnapshotEstimatedBytes,
} from "../../rrweb-snapshot/index.ts";
import { initObservers, mutationBuffers } from "./observer";
import {
  on,
  getWindowWidth,
  getWindowHeight,
  getWindowScroll,
  polyfill,
  hasShadowRoot,
  isSerializedIframe,
  nowTimestamp,
  isBlocked,
} from "../utils";
import type { recordOptions } from "../types";
import {
  EventType,
  type eventWithoutTime,
  type eventWithTime,
  IncrementalSource,
  NodeType,
  type listenerHandler,
  type mutationCallbackParam,
  type scrollCallback,
  type canvasMutationParam,
  type adoptedStyleSheetParam,
  type addedNodeMutation,
  type removedNodeMutation,
  type mutationRecord,
  type mousemoveCallBack,
  type mouseInteractionCallBack,
  type viewportResizeCallback,
  type inputCallback,
  type mediaInteractionCallback,
  type styleSheetRuleCallback,
  type styleDeclarationCallback,
  type canvasMutationCallback,
  type fontCallback,
  type selectionCallback,
  type customElementCallback,
} from "../../rrweb-types/index.ts";
import type { CrossOriginIframeMessageEventContent } from "../types";
import { IframeManager } from "./iframe-manager";
import { ShadowDomManager } from "./shadow-dom-manager";
import { CanvasManager } from "./observers/canvas/canvas-manager";
import { ImageManager } from "./observers/image-manager.ts";
import { StylesheetManager } from "./stylesheet-manager";
import ProcessedNodeManager from "./processed-node-manager";
import { callbackWrapper, registerErrorHandler, unregisterErrorHandler } from "./error-handler";
import dom from "../../rrweb-utils/index.ts";
import {
  estimateEventBytes,
  estimateMutationAttributeBytes,
  estimateMutationTextBytes,
  estimateStringBytes,
  estimateValueBytes,
} from "./event-size.ts";

let wrappedEmit!: (e: eventWithoutTime, isCheckout?: boolean, timestamp?: number) => void;

let takeFullSnapshot!: (isCheckout?: boolean) => void;
let recording = false;

declare const __ORANGE_REPLAY_INCLUDE_CROSS_ORIGIN_IFRAMES__: boolean | undefined;
declare const __ORANGE_REPLAY_SDK_PROFILE__: boolean | undefined;
const isOrangeReplaySdk =
  typeof __ORANGE_REPLAY_SDK_PROFILE__ !== "undefined" && __ORANGE_REPLAY_SDK_PROFILE__;
const MAX_QUEUED_SNAPSHOT_EVENTS = 256;
const MAX_QUEUED_SNAPSHOT_BYTES = 4 * 1_024 * 1_024;
const MAX_QUEUED_IFRAME_ATTACHMENTS = 64;

function unescapeCssIdentifier(value: string): string {
  return value.replace(/\\([\da-f]{1,6}\s?|[\s\S])/gi, (_match, escaped: string) => {
    const point = Number.parseInt(escaped, 16);
    if (Number.isNaN(point)) return escaped;
    return String.fromCodePoint(point === 0 || point > 0x10ffff ? 0xfffd : point);
  });
}

function isDisposableQueuedEvent(event: eventWithTime): boolean {
  if (event.type !== EventType.IncrementalSnapshot) return false;
  return (
    event.data.source === IncrementalSource.CanvasMutation ||
    event.data.source === IncrementalSource.MouseMove ||
    event.data.source === IncrementalSource.TouchMove ||
    event.data.source === IncrementalSource.Drag ||
    event.data.source === IncrementalSource.MouseInteraction ||
    event.data.source === IncrementalSource.Scroll
  );
}

let currentMirror = createMirror();
const publicMirror = isOrangeReplaySdk
  ? currentMirror
  : new Proxy(currentMirror, {
      get(_target, property) {
        const value = currentMirror[property as keyof typeof currentMirror] as unknown;
        return typeof value === "function"
          ? (...args: unknown[]) =>
              (
                currentMirror[property as keyof typeof currentMirror] as (
                  ...currentArgs: unknown[]
                ) => unknown
              ).apply(currentMirror, args)
          : value;
      },
    });

if (!isOrangeReplaySdk) {
  // The generic fork keeps rrweb's legacy compatibility repair. The SDK
  // bundle targets ES2022 browsers and does not need an iframe at startup.
  try {
    if (Array.from([1], (x) => x * 2)[0] !== 2) {
      const cleanFrame = document.createElement("iframe");
      document.body.appendChild(cleanFrame);
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Array.from is static and doesn't rely on binding
      Array.from = cleanFrame.contentWindow?.Array.from || Array.from;
      document.body.removeChild(cleanFrame);
    }
  } catch (err) {
    console.debug("Unable to override Array.from", err);
  }
}

function record<T = eventWithTime>(options: recordOptions<T> = {}): listenerHandler | undefined {
  const {
    emit,
    checkoutEveryNms,
    checkoutEveryNth,
    blockSelector = null,
    ignoreSelector = null,
    maskTextSelector = null,
    recordCanvas = false,
    errorHandler,
  } = options;
  const blockClass = isOrangeReplaySdk ? "rr-block" : (options.blockClass ?? "rr-block");
  const ignoreClass = isOrangeReplaySdk ? "rr-ignore" : (options.ignoreClass ?? "rr-ignore");
  const maskTextClass = isOrangeReplaySdk ? "rr-mask" : (options.maskTextClass ?? "rr-mask");
  const inlineStylesheet = isOrangeReplaySdk ? true : (options.inlineStylesheet ?? true);
  const maskAllInputs = isOrangeReplaySdk ? true : options.maskAllInputs;
  const _maskInputOptions = isOrangeReplaySdk ? undefined : options.maskInputOptions;
  const _slimDOMOptions = isOrangeReplaySdk ? undefined : options.slimDOMOptions;
  const maskInputFn = isOrangeReplaySdk ? undefined : options.maskInputFn;
  const maskTextFn = isOrangeReplaySdk ? undefined : options.maskTextFn;
  const hooks = isOrangeReplaySdk ? undefined : options.hooks;
  const packFn = isOrangeReplaySdk ? undefined : options.packFn;
  const sampling = isOrangeReplaySdk ? {} : (options.sampling ?? {});
  const dataURLOptions = isOrangeReplaySdk ? {} : (options.dataURLOptions ?? {});
  const mousemoveWait = isOrangeReplaySdk ? undefined : options.mousemoveWait;
  const recordDOM = isOrangeReplaySdk ? true : (options.recordDOM ?? true);
  const requestedCrossOriginIframes = isOrangeReplaySdk
    ? false
    : (options.recordCrossOriginIframes ?? false);
  const recordAfter = isOrangeReplaySdk
    ? "load"
    : options.recordAfter === "DOMContentLoaded"
      ? options.recordAfter
      : "load";
  const userTriggeredOnInput = isOrangeReplaySdk ? false : (options.userTriggeredOnInput ?? false);
  const collectFonts = isOrangeReplaySdk ? false : (options.collectFonts ?? false);
  const inlineImages = isOrangeReplaySdk ? true : (options.inlineImages ?? false);
  const plugins = isOrangeReplaySdk ? undefined : options.plugins;
  const keepIframeSrcFn = isOrangeReplaySdk
    ? () => false
    : (options.keepIframeSrcFn ?? (() => false));
  const ignoreCSSAttributes = isOrangeReplaySdk
    ? new Set<string>()
    : (options.ignoreCSSAttributes ?? new Set<string>());
  const snapshotTimeSliceMs = isOrangeReplaySdk ? 4 : options.snapshotTimeSliceMs;
  const prepareForSnapshotPart = options.prepareForSnapshotPart;
  const deferIframeDocuments = isOrangeReplaySdk || prepareForSnapshotPart !== undefined;

  registerErrorHandler(errorHandler);

  const recordCrossOriginIframes =
    (typeof __ORANGE_REPLAY_INCLUDE_CROSS_ORIGIN_IFRAMES__ === "undefined" ||
      __ORANGE_REPLAY_INCLUDE_CROSS_ORIGIN_IFRAMES__) &&
    requestedCrossOriginIframes;

  const inEmittingFrame = recordCrossOriginIframes ? window.parent === window : true;

  let passEmitsToParent = false;
  if (!inEmittingFrame) {
    try {
      // throws if parent is cross-origin
      if (window.parent.document) {
        passEmitsToParent = false; // if parent is same origin we collect iframe events from the parent
      }
    } catch (e) {
      passEmitsToParent = true;
    }
  }

  // runtime checks for user options
  if (inEmittingFrame && !emit) {
    throw new Error("emit function is required");
  }
  if (!inEmittingFrame && !passEmitsToParent) {
    return () => {
      /* no-op since in this case we don't need to record anything from this frame in particular */
    };
  }
  // move departed options to new options
  if (!isOrangeReplaySdk && mousemoveWait !== undefined && sampling.mousemove === undefined) {
    sampling.mousemove = mousemoveWait;
  }

  // A stopped chunked snapshot can finish later. Each recording owns its
  // mirror so that old cleanup cannot change IDs reserved by a new recording.
  const mirror = createMirror();
  if (!isOrangeReplaySdk) currentMirror = mirror;

  const maskInputOptions: MaskInputOptions = isOrangeReplaySdk
    ? {}
    : maskAllInputs === true
      ? {
          color: true,
          date: true,
          "datetime-local": true,
          email: true,
          month: true,
          number: true,
          range: true,
          search: true,
          tel: true,
          text: true,
          time: true,
          url: true,
          week: true,
          textarea: true,
          select: true,
          password: true,
        }
      : _maskInputOptions !== undefined
        ? _maskInputOptions
        : { password: true };

  const slimDOMOptions: ReturnType<typeof slimDOMDefaults> = isOrangeReplaySdk
    ? {}
    : slimDOMDefaults(_slimDOMOptions);

  // Only mutations that can change a configured privacy match invalidate the
  // privacy pass. This keeps unrelated counters and style animation from
  // restarting a large snapshot.
  const privacyAttributeNames = new Set(["class"]);
  const privacySelectors = [blockSelector, maskTextSelector].filter(
    (selector): selector is string => selector !== null,
  );
  let privacyUsesText = false;
  for (const selector of privacySelectors) {
    const normalizedSelector = unescapeCssIdentifier(selector).toLowerCase();
    if (normalizedSelector.includes("#")) privacyAttributeNames.add("id");
    for (const match of normalizedSelector.matchAll(/\[\s*([^\s~|^$*=\]]+)/g)) {
      privacyAttributeNames.add(match[1]!);
    }
    if (normalizedSelector.includes(":lang")) privacyAttributeNames.add("lang");
    if (normalizedSelector.includes(":dir")) privacyAttributeNames.add("dir");
    if (normalizedSelector.includes(":empty")) privacyUsesText = true;
  }

  if (!isOrangeReplaySdk) polyfill();

  let lastFullSnapshotEvent: eventWithTime;
  let incrementalSnapshotCount = 0;
  let stopped = false;
  let snapshotTaskActive = false;
  let fullSnapshotRunning = false;
  let queuedSnapshotCheckout: boolean | undefined;
  let snapshotGeneration = 0;
  let snapshotQueueOverflow = false;
  let topologyRevision = 0;
  let privacyRevision = 0;
  let mirrorResetNeeded = false;
  let hasCommittedSnapshot = false;
  let snapshotRetryNeeded = false;
  let snapshotRetryTimer: ReturnType<typeof setTimeout> | undefined;
  const queuedSnapshotEvents: Array<{
    event: eventWithTime;
    isCheckout?: boolean;
    bytes: number;
    textIndexById?: Map<number, number>;
    attributeIndexById?: Map<number, number>;
  }> = [];
  const queuedIframeAttachments: typeof queuedSnapshotEvents = [];
  let queuedSnapshotBytes = 0;
  type PendingIframeLoad = {
    iframe: HTMLIFrameElement;
    document: Document;
    node: Parameters<IframeManager["attachIframe"]>[1];
    timestamp: number;
  };
  const pendingIframeLoads: PendingIframeLoad[] = [];
  const queuedIframeSnapshots = new Map<Document, HTMLIFrameElement>();
  const restartAfterQueueOverflow = () => {
    queuedSnapshotEvents.splice(0);
    queuedIframeAttachments.splice(0);
    queuedSnapshotBytes = 0;
    snapshotQueueOverflow = true;
    queuedSnapshotCheckout = true;
  };

  const eventProcessor = (e: eventWithTime): T => {
    if (!isOrangeReplaySdk) {
      for (const plugin of plugins || []) {
        if (plugin.eventProcessor) {
          e = plugin.eventProcessor(e);
        }
      }
    }
    if (
      !isOrangeReplaySdk &&
      packFn &&
      // Disable packing events which will be emitted to parent frames.
      !passEmitsToParent
    ) {
      e = packFn(e) as unknown as eventWithTime;
    }
    return e as unknown as T;
  };
  const deliverEvent = (e: eventWithTime, isCheckout?: boolean) => {
    if (stopped) return;
    if (inEmittingFrame) {
      emit?.(eventProcessor(e), isCheckout);
    } else if (passEmitsToParent) {
      const message: CrossOriginIframeMessageEventContent<T> = {
        type: "rrweb",
        event: eventProcessor(e),
        origin: window.location.origin,
        isCheckout,
      };
      window.parent.postMessage(message, "*");
    }

    if (e.type === EventType.FullSnapshot) {
      lastFullSnapshotEvent = e;
      incrementalSnapshotCount = 0;
    } else if (e.type === EventType.IncrementalSnapshot) {
      // attach iframe should be considered as full snapshot
      if (e.data.source === IncrementalSource.Mutation && e.data.isAttachIframe) {
        return;
      }

      incrementalSnapshotCount++;
      const exceedCount = checkoutEveryNth && incrementalSnapshotCount >= checkoutEveryNth;
      const exceedTime =
        checkoutEveryNms && e.timestamp - lastFullSnapshotEvent.timestamp > checkoutEveryNms;
      if (exceedCount || exceedTime) {
        takeFullSnapshot(true);
      }
    }
  };
  const mergeQueuedMutationUpdate = (event: eventWithTime, isCheckout?: boolean) => {
    if (
      event.type !== EventType.IncrementalSnapshot ||
      event.data.source !== IncrementalSource.Mutation ||
      event.data.isAttachIframe === true ||
      event.data.adds.length > 0 ||
      event.data.removes.length > 0
    )
      return false;
    const previous = queuedSnapshotEvents[queuedSnapshotEvents.length - 1];
    if (
      previous?.event.type !== EventType.IncrementalSnapshot ||
      previous.event.data.source !== IncrementalSource.Mutation ||
      previous.event.data.isAttachIframe === true ||
      previous.event.data.adds.length > 0 ||
      previous.event.data.removes.length > 0
    )
      return false;
    let byteChange = 0;
    previous.textIndexById ??= new Map(
      previous.event.data.texts.map((text, index) => [text.id, index]),
    );
    previous.attributeIndexById ??= new Map(
      previous.event.data.attributes.map((attribute, index) => [attribute.id, index]),
    );
    for (const text of event.data.texts) {
      const oldIndex = previous.textIndexById.get(text.id);
      if (oldIndex === undefined) {
        previous.textIndexById.set(text.id, previous.event.data.texts.length);
        previous.event.data.texts.push(text);
        byteChange += estimateMutationTextBytes(text.value);
      } else {
        const old = previous.event.data.texts[oldIndex]!;
        byteChange += estimateStringBytes(text.value) - estimateStringBytes(old.value);
        old.value = text.value;
      }
    }
    for (const attribute of event.data.attributes) {
      const oldIndex = previous.attributeIndexById.get(attribute.id);
      if (oldIndex === undefined) {
        previous.attributeIndexById.set(attribute.id, previous.event.data.attributes.length);
        previous.event.data.attributes.push(attribute);
        byteChange += estimateMutationAttributeBytes(attribute.attributes);
      } else {
        const oldAttributes = previous.event.data.attributes[oldIndex]!.attributes;
        for (const [name, value] of Object.entries(attribute.attributes)) {
          byteChange += Object.hasOwn(oldAttributes, name)
            ? estimateValueBytes(value) - estimateValueBytes(oldAttributes[name])
            : name.length * 2 + estimateValueBytes(value);
          oldAttributes[name] = value;
        }
      }
    }
    previous.event.timestamp = event.timestamp;
    previous.isCheckout ||= isCheckout;
    previous.bytes = Math.max(256, previous.bytes + byteChange);
    queuedSnapshotBytes = Math.max(0, queuedSnapshotBytes + byteChange);
    return true;
  };
  const sendEvent = (e: eventWithTime, isCheckout?: boolean) => {
    if (stopped) return;
    if (
      recordDOM &&
      !hasCommittedSnapshot &&
      !fullSnapshotRunning &&
      e.type !== EventType.Meta &&
      e.type !== EventType.FullSnapshot &&
      e.type !== EventType.DomContentLoaded &&
      e.type !== EventType.Load
    )
      return;
    if (mirrorResetNeeded && !fullSnapshotRunning && e.type === EventType.IncrementalSnapshot)
      return;
    if (
      !isOrangeReplaySdk &&
      mutationBuffers[0]?.isFrozen() &&
      e.type !== EventType.FullSnapshot &&
      !(e.type === EventType.IncrementalSnapshot && e.data.source === IncrementalSource.Mutation)
    ) {
      // we've got a user initiated event so first we need to apply
      // all DOM changes that have been buffering during paused state
      for (const buffer of mutationBuffers) buffer.unfreeze();
    }

    if (
      fullSnapshotRunning &&
      e.type === EventType.IncrementalSnapshot &&
      e.data.source === IncrementalSource.Mutation &&
      e.data.isAttachIframe === true
    ) {
      // Iframe baselines are part of the structural checkpoint. Keep them out
      // of the bounded live catch-up queue so many iframes cannot trigger the
      // same checkpoint forever.
      if (queuedIframeAttachments.length < MAX_QUEUED_IFRAME_ATTACHMENTS) {
        queuedIframeAttachments.push({ event: e, isCheckout, bytes: 0 });
      } else {
        restartAfterQueueOverflow();
      }
      return;
    }

    if (fullSnapshotRunning && e.type !== EventType.Meta && e.type !== EventType.FullSnapshot) {
      if (!snapshotQueueOverflow) {
        if (mergeQueuedMutationUpdate(e, isCheckout)) {
          if (queuedSnapshotBytes <= MAX_QUEUED_SNAPSHOT_BYTES) return;
        }
        const bytes = estimateEventBytes(e);
        const queueIsFull =
          queuedSnapshotEvents.length >= MAX_QUEUED_SNAPSHOT_EVENTS ||
          queuedSnapshotBytes + bytes > MAX_QUEUED_SNAPSHOT_BYTES;
        if (!queueIsFull) {
          queuedSnapshotEvents.push({ event: e, isCheckout, bytes });
          queuedSnapshotBytes += bytes;
        } else if (!isDisposableQueuedEvent(e)) {
          // A page that mutates faster than catch-up can run needs a fresh
          // checkpoint. Bound memory and cancel this stale baseline.
          restartAfterQueueOverflow();
        }
      }
      return;
    }

    deliverEvent(e, isCheckout);
  };
  wrappedEmit = (r: eventWithoutTime, isCheckout?: boolean, timestamp = nowTimestamp()) => {
    const event = r as eventWithTime;
    event.timestamp = timestamp;
    sendEvent(event, isCheckout);
  };

  const wrappedMutationEmit = (m: mutationCallbackParam) => {
    wrappedEmit({
      type: EventType.IncrementalSnapshot,
      data: {
        source: IncrementalSource.Mutation,
        ...m,
      },
    });
  };
  const wrappedScrollEmit: scrollCallback = (p) =>
    wrappedEmit({
      type: EventType.IncrementalSnapshot,
      data: {
        source: IncrementalSource.Scroll,
        ...p,
      },
    });
  const wrappedCanvasMutationEmit = (p: canvasMutationParam) =>
    wrappedEmit({
      type: EventType.IncrementalSnapshot,
      data: {
        source: IncrementalSource.CanvasMutation,
        ...p,
      },
    });

  const wrappedAdoptedStyleSheetEmit = (a: adoptedStyleSheetParam) =>
    wrappedEmit({
      type: EventType.IncrementalSnapshot,
      data: {
        source: IncrementalSource.AdoptedStyleSheet,
        ...a,
      },
    });

  const stylesheetManager = new StylesheetManager({
    mutationCb: wrappedMutationEmit,
    adoptedStyleSheetCb: wrappedAdoptedStyleSheetEmit,
  });

  const iframeManager = new IframeManager({
    mirror,
    mutationCb: wrappedMutationEmit,
    stylesheetManager: stylesheetManager,
    recordCrossOriginIframes,
    shouldRecordIframe: (iframe: HTMLIFrameElement) =>
      iframe.isConnected &&
      !isBlocked(iframe, blockClass, blockSelector, true) &&
      !isBlocked(iframe, maskTextClass, maskTextSelector, true),
    wrappedEmit,
  });
  const isCurrentIframeDocument = (iframe: HTMLIFrameElement, doc: Document) =>
    iframeManager.isCurrentIframe(iframe, doc);

  /**
   * Exposes mirror to the plugins
   */
  if (!isOrangeReplaySdk) {
    for (const plugin of plugins || []) {
      if (plugin.getMirror)
        plugin.getMirror({
          nodeMirror: mirror,
          crossOriginIframeMirror: iframeManager.crossOriginIframeMirror,
          crossOriginIframeStyleMirror: iframeManager.crossOriginIframeStyleMirror,
        });
    }
  }

  const processedNodeManager = new ProcessedNodeManager();

  const canvasManager = new CanvasManager({
    recordCanvas,
    mutationCb: wrappedCanvasMutationEmit,
    win: window,
    blockClass,
    blockSelector,
    mirror,
    sampling: sampling.canvas,
    dataURLOptions,
  });

  const imageManager = new ImageManager({
    inlineImages,
    mutationCb: wrappedMutationEmit,
    win: window,
    blockClass,
    blockSelector,
    mirror,
    dataURLOptions,
  });

  const shadowDomManager = new ShadowDomManager({
    mutationCb: wrappedMutationEmit,
    scrollCb: wrappedScrollEmit,
    bypassOptions: {
      blockClass,
      blockSelector,
      maskTextClass,
      maskTextSelector,
      inlineStylesheet,
      maskInputOptions,
      dataURLOptions,
      maskTextFn,
      maskInputFn,
      // CanvasManager captures pixels with canvas.toBlob(), which lets the
      // browser encode the image without holding up the current frame. Do not
      // also call canvas.toDataURL() while walking the full DOM snapshot.
      recordCanvas: false,
      inlineImages,
      sampling,
      slimDOMOptions,
      iframeManager,
      stylesheetManager,
      canvasManager,
      imageManager,
      keepIframeSrcFn,
      processedNodeManager,
    },
    mirror,
  });

  iframeManager.addDocumentRemovedListener((iframeDocument: Document) => {
    queuedIframeSnapshots.delete(iframeDocument);
    shadowDomManager.removeDocument(iframeDocument);
    imageManager.removeContainedImages([iframeDocument]);
  });

  const scheduleSnapshotRetry = () => {
    snapshotRetryNeeded = true;
    if (snapshotRetryTimer !== undefined) clearTimeout(snapshotRetryTimer);
    snapshotRetryTimer = setTimeout(() => {
      snapshotRetryTimer = undefined;
      if (stopped || !snapshotRetryNeeded) return;
      snapshotRetryNeeded = false;
      takeFullSnapshot(true);
    }, 50);
  };

  const maskSnapshotText = async (
    addition: addedNodeMutation,
    privacyNode: Node,
    maybeYield: () => Promise<void>,
  ) => {
    const parentName =
      privacyNode.nodeType === privacyNode.TEXT_NODE ? privacyNode.parentNode?.nodeName : undefined;
    const pending = [
      {
        node: addition.node,
        rawText: parentName === "STYLE" || parentName === "SCRIPT",
      },
    ];
    const privacyElement = closestPrivacyElement(privacyNode) as HTMLElement | null;
    while (pending.length > 0) {
      const { node: snapshotNode, rawText } = pending.pop()!;
      if (snapshotNode.type === NodeType.Text && !rawText) {
        snapshotNode.textContent =
          !isOrangeReplaySdk && maskTextFn
            ? maskTextFn(snapshotNode.textContent, privacyElement)
            : snapshotNode.textContent.replace(/[\S]/g, "*");
      } else if (
        snapshotNode.type === NodeType.Document ||
        snapshotNode.type === NodeType.Element
      ) {
        const childIsRawText =
          snapshotNode.type === NodeType.Element &&
          (snapshotNode.tagName === "style" || snapshotNode.tagName === "script");
        for (const child of snapshotNode.childNodes) {
          pending.push({ node: child, rawText: childIsRawText });
        }
      }
      await maybeYield();
    }
  };

  const flushQueuedIframeAttachments = async () => {
    let deliveredCount = 0;
    let sliceStartedAt = performance.now();
    const maybeYield = async () => {
      if (performance.now() - sliceStartedAt < 4) return;
      await yieldForPaint(window);
      sliceStartedAt = performance.now();
    };
    while (queuedIframeAttachments.length > 0) {
      const queued = queuedIframeAttachments.splice(0);
      for (const entry of queued) {
        const event = entry.event;
        if (
          event.type !== EventType.IncrementalSnapshot ||
          event.data.source !== IncrementalSource.Mutation ||
          event.data.isAttachIframe !== true
        )
          continue;
        const owner = mirror.getNode(event.data.adds[0]?.parentId ?? -1);
        if (
          owner === null ||
          owner.nodeName !== "IFRAME" ||
          !iframeManager.isCurrentIframe(owner as HTMLIFrameElement) ||
          isBlocked(owner, blockClass, blockSelector, true)
        )
          continue;
        if (isBlocked(owner, maskTextClass, maskTextSelector, true)) {
          for (const addition of event.data.adds) {
            await maskSnapshotText(addition, owner, maybeYield);
          }
          if (
            !iframeManager.isCurrentIframe(owner as HTMLIFrameElement) ||
            isBlocked(owner, blockClass, blockSelector, true)
          )
            continue;
        }
        deliverEvent(event, entry.isCheckout);
        deliveredCount += 1;
        await maybeYield();
      }
    }
    return deliveredCount;
  };

  const flushQueuedSnapshotEvents = async () => {
    const timeSliceMs = snapshotTimeSliceMs && snapshotTimeSliceMs > 0 ? snapshotTimeSliceMs : 4;
    let sliceStartedAt = performance.now();
    const maybeYield = async () => {
      if (performance.now() - sliceStartedAt < timeSliceMs) return;
      await yieldForPaint(window);
      sliceStartedAt = performance.now();
    };
    const isBlockedId = (id: number) => {
      const node = mirror.getNode(id);
      return (
        node === null ||
        !iframeManager.isCurrentDocument(node.ownerDocument) ||
        isBlocked(node, blockClass, blockSelector, true)
      );
    };
    const keepQueuedEvent = async (event: eventWithTime) => {
      if (event.type !== EventType.IncrementalSnapshot) return true;
      switch (event.data.source) {
        case IncrementalSource.CanvasMutation:
        case IncrementalSource.Input:
        case IncrementalSource.MouseInteraction:
        case IncrementalSource.Scroll:
        case IncrementalSource.MediaInteraction:
          return !isBlockedId(event.data.id);
        case IncrementalSource.MouseMove:
        case IncrementalSource.TouchMove:
        case IncrementalSource.Drag:
          event.data.positions = event.data.positions.filter(
            (position) => !isBlockedId(position.id),
          );
          return event.data.positions.length > 0;
        case IncrementalSource.Selection:
          event.data.ranges = event.data.ranges.filter(
            (range) => !isBlockedId(range.start) && !isBlockedId(range.end),
          );
          return event.data.ranges.length > 0;
        case IncrementalSource.StyleSheetRule:
        case IncrementalSource.StyleDeclaration:
          return event.data.id === undefined || !isBlockedId(event.data.id);
        case IncrementalSource.AdoptedStyleSheet:
          return !isBlockedId(event.data.id);
        case IncrementalSource.Mutation: {
          const texts: typeof event.data.texts = [];
          for (const text of event.data.texts) {
            const node = mirror.getNode(text.id);
            if (
              node !== null &&
              iframeManager.isCurrentDocument(node.ownerDocument) &&
              !isBlocked(node, blockClass, blockSelector, true)
            ) {
              if (
                text.value !== null &&
                needMaskingText(node, maskTextClass, maskTextSelector, true)
              ) {
                text.value =
                  !isOrangeReplaySdk && maskTextFn
                    ? maskTextFn(text.value, closestPrivacyElement(node) as HTMLElement | null)
                    : text.value.replace(/[\S]/g, "*");
              }
              texts.push(text);
            }
            await maybeYield();
          }
          event.data.texts = texts;
          const attributes: typeof event.data.attributes = [];
          for (const attribute of event.data.attributes) {
            if (!isBlockedId(attribute.id)) attributes.push(attribute);
            await maybeYield();
          }
          event.data.attributes = attributes;
          const adds: addedNodeMutation[] = [];
          for (const addition of event.data.adds) {
            const node = mirror.getNode(
              event.data.isAttachIframe === true ? addition.parentId : addition.node.id,
            );
            if (
              node !== null &&
              iframeManager.isCurrentDocument(node.ownerDocument) &&
              !isBlocked(node, blockClass, blockSelector, true)
            ) {
              if (needMaskingText(node, maskTextClass, maskTextSelector, true)) {
                await maskSnapshotText(addition, node, maybeYield);
              }
              adds.push(addition);
            }
            await maybeYield();
          }
          event.data.adds = adds;
          return (
            event.data.texts.length > 0 ||
            event.data.attributes.length > 0 ||
            event.data.adds.length > 0 ||
            event.data.removes.length > 0
          );
        }
        default:
          return true;
      }
    };

    // Events are appended in capture order. Drain that ordered queue in short
    // slices; events produced during a yield are appended and drained next.
    while (queuedSnapshotEvents.length > 0 && !snapshotQueueOverflow) {
      const queued = queuedSnapshotEvents.splice(0);
      queuedSnapshotBytes = 0;
      for (const entry of queued) {
        let keepEvent = false;
        let privacyWasStable = false;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const checkedRevision = privacyRevision;
          keepEvent = await keepQueuedEvent(entry.event);
          if (privacyRevision === checkedRevision) {
            privacyWasStable = true;
            break;
          }
        }
        if (!privacyWasStable) {
          restartAfterQueueOverflow();
          break;
        }
        if (keepEvent) deliverEvent(entry.event, entry.isCheckout);
        await maybeYield();
        if (snapshotQueueOverflow) break;
      }
    }
  };

  const attachPendingIframes = async (iframeLoads: PendingIframeLoad[]) => {
    for (let index = 0; index < iframeLoads.length; index += 1) {
      const pending = iframeLoads[index]!;
      if (
        !stopped &&
        !snapshotQueueOverflow &&
        isCurrentIframeDocument(pending.iframe, pending.document) &&
        !isBlocked(pending.iframe, blockClass, blockSelector, true)
      ) {
        if (queuedIframeAttachments.length >= MAX_QUEUED_IFRAME_ATTACHMENTS) {
          await flushQueuedIframeAttachments();
          if (stopped || snapshotQueueOverflow) return;
          await yieldForPaint(window);
        }
        iframeManager.attachIframe(pending.iframe, pending.node, pending.timestamp);
        shadowDomManager.observeAttachShadow(pending.iframe);
      }
    }
    iframeLoads.length = 0;
    await flushQueuedIframeAttachments();
  };

  type ReconciliationTopology = Pick<
    CapturedTopology,
    "length" | "getLiveId" | "getParentIndex" | "getNextLiveId"
  >;
  const reconcileTopologyEvents = async (topology: ReconciliationTopology) => {
    const entriesAtTopologyCut = queuedSnapshotEvents.length;
    const referencedIds = new Set<number>();
    const timeSliceMs =
      snapshotTimeSliceMs !== undefined && snapshotTimeSliceMs > 0 ? snapshotTimeSliceMs : 4;
    let sliceStartedAt = performance.now();
    for (let index = 0; index < entriesAtTopologyCut; index += 1) {
      if (snapshotQueueOverflow) return;
      const entry = queuedSnapshotEvents[index]!;
      const event = entry.event;
      if (
        event.type === EventType.IncrementalSnapshot &&
        event.data.source === IncrementalSource.Mutation &&
        event.data.isAttachIframe !== true
      ) {
        for (const addition of event.data.adds) referencedIds.add(addition.node.id);
        for (const removal of event.data.removes) referencedIds.add(removal.id);
      }
      if (performance.now() - sliceStartedAt >= timeSliceMs) {
        await yieldForPaint(window);
        sliceStartedAt = performance.now();
      }
    }
    if (referencedIds.size === 0) return;
    const capturedPositionById = new Map<number, { parentId: number; nextId: number | null }>();
    for (let index = 0; index < topology.length; index += 1) {
      if (snapshotQueueOverflow) return;
      const id = topology.getLiveId(index) ?? -1;
      if (referencedIds.has(id)) {
        const parentIndex = topology.getParentIndex(index) ?? -1;
        capturedPositionById.set(id, {
          parentId: parentIndex === -1 ? -1 : (topology.getLiveId(parentIndex) ?? -1),
          nextId: topology.getNextLiveId(index) ?? null,
        });
      }
      if (performance.now() - sliceStartedAt >= timeSliceMs) {
        await yieldForPaint(window);
        sliceStartedAt = performance.now();
      }
    }

    const redundantAdditions = new WeakSet<addedNodeMutation>();
    const redundantRemovals = new WeakSet<removedNodeMutation>();
    const pendingAdditionsById = new Map<number, addedNodeMutation[]>();
    const pendingRemovalsById = new Map<number, removedNodeMutation[]>();
    for (let index = 0; index < entriesAtTopologyCut; index += 1) {
      if (snapshotQueueOverflow) return;
      const event = queuedSnapshotEvents[index]!.event;
      if (
        event.type !== EventType.IncrementalSnapshot ||
        event.data.source !== IncrementalSource.Mutation ||
        event.data.isAttachIframe === true
      )
        continue;
      for (const removal of event.data.removes) {
        const pending = pendingRemovalsById.get(removal.id) ?? [];
        pending.push(removal);
        pendingRemovalsById.set(removal.id, pending);
      }
      for (const addition of event.data.adds) {
        const pendingAdditions = pendingAdditionsById.get(addition.node.id) ?? [];
        pendingAdditions.push(addition);
        pendingAdditionsById.set(addition.node.id, pendingAdditions);
        const captured = capturedPositionById.get(addition.node.id);
        if (captured?.parentId === addition.parentId && captured.nextId === addition.nextId) {
          for (const pendingAddition of pendingAdditions) {
            redundantAdditions.add(pendingAddition);
          }
          pendingAdditions.splice(0);
          const pendingRemovals = pendingRemovalsById.get(addition.node.id) ?? [];
          for (const pendingRemoval of pendingRemovals) redundantRemovals.add(pendingRemoval);
          pendingRemovals.splice(0);
        }
      }
      if (performance.now() - sliceStartedAt >= timeSliceMs) {
        await yieldForPaint(window);
        sliceStartedAt = performance.now();
      }
    }
    for (let index = entriesAtTopologyCut - 1; index >= 0; index -= 1) {
      if (snapshotQueueOverflow) return;
      const event = queuedSnapshotEvents[index]!.event;
      if (
        event.type !== EventType.IncrementalSnapshot ||
        event.data.source !== IncrementalSource.Mutation ||
        event.data.isAttachIframe === true
      )
        continue;
      event.data.adds = event.data.adds.filter((addition) => !redundantAdditions.has(addition));
      event.data.removes = event.data.removes.filter((removal) => !redundantRemovals.has(removal));
      if (
        event.data.adds.length === 0 &&
        event.data.removes.length === 0 &&
        event.data.texts.length === 0 &&
        event.data.attributes.length === 0
      ) {
        queuedSnapshotEvents.splice(index, 1);
      }
      if (performance.now() - sliceStartedAt >= timeSliceMs) {
        await yieldForPaint(window);
        sliceStartedAt = performance.now();
      }
    }
    queuedSnapshotBytes = queuedSnapshotEvents.reduce((bytes, entry) => bytes + entry.bytes, 0);
  };
  const createSnapshotOptions = (
    candidateMirror: ReturnType<typeof createMirror>,
    generation: number,
    snapshotTimestamp: number,
    iframeLoads: PendingIframeLoad[],
  ): SnapshotOptions => ({
    mirror: candidateMirror,
    reuseIdsFrom: mirror,
    blockClass,
    blockSelector,
    maskTextClass,
    maskTextSelector,
    inlineStylesheet,
    maskAllInputs: maskInputOptions,
    maskTextFn,
    maskInputFn,
    slimDOM: slimDOMOptions,
    dataURLOptions,
    recordCanvas: false,
    inlineImages,
    deferInlineImages: true,
    onSerialize: (node) => {
      canvasManager.trackCanvas(node);
      imageManager.trackImage(node);
      if (
        isSerializedIframe(node, candidateMirror) &&
        !isBlocked(node, blockClass, blockSelector, true)
      ) {
        iframeManager.addIframe(node as HTMLIFrameElement);
      }
      if (hasShadowRoot(node) && !isBlocked(node, blockClass, blockSelector, true)) {
        const shadowRoot = dom.shadowRoot(node as Node);
        if (shadowRoot !== null) {
          shadowDomManager.addShadowRoot(shadowRoot, shadowRoot.ownerDocument);
        }
      }
    },
    onIframeLoad: (iframe, childSnapshot, capturedDocument) => {
      if (generation !== snapshotGeneration || stopped || capturedDocument === undefined) return;
      iframeLoads.push({
        iframe,
        document: capturedDocument,
        node: childSnapshot,
        timestamp: snapshotTimestamp,
      });
    },
    onIframeReady: (iframeDocument) => iframeManager.snapshotLoadedIframe(iframeDocument),
    onStylesheetLoad: (linkElement, childSnapshot) => {
      if (generation !== snapshotGeneration || stopped) return;
      stylesheetManager.attachLinkElement(linkElement, childSnapshot);
    },
    keepIframeSrcFn,
  });

  const registerSnapshotIframe = (iframe: HTMLIFrameElement, iframeDocument: Document) => {
    iframeManager.addIframe(iframe, iframeDocument);
    if (deferIframeDocuments) {
      queuedIframeSnapshots.set(iframeDocument, iframe);
      return;
    }
    queuedIframeSnapshots.delete(iframeDocument);
    iframeManager.observeIframe(iframe);
    shadowDomManager.observeAttachShadow(iframe);
  };

  const protectLiveMirrorAfterAbort = () => {
    mirrorResetNeeded = true;
    queuedIframeSnapshots.clear();
    if (!snapshotRetryNeeded && queuedSnapshotCheckout === undefined) {
      queuedSnapshotCheckout = true;
    }
  };

  const runFullSnapshot = async (isCheckout: boolean) => {
    if (prepareForSnapshotPart !== undefined) await prepareForSnapshotPart();
    if (stopped || queuedSnapshotCheckout !== undefined) return;
    if (mirrorResetNeeded) {
      iframeManager.reset(false);
      shadowDomManager.init();
      mirror.reset();
      queuedIframeSnapshots.clear();
      mirrorResetNeeded = false;
    }
    const generation = ++snapshotGeneration;
    const candidateMirror = createMirror();
    let committed = false;
    let snapshotStarted = false;
    let snapshotUnstable = false;
    const snapshotTimestamp = nowTimestamp();
    pendingIframeLoads.splice(0);
    snapshotQueueOverflow = false;
    mirror.startIdReservation(genId);
    fullSnapshotRunning = true;

    try {
      wrappedEmit(
        {
          type: EventType.Meta,
          data: {
            href: window.location.href,
            width: getWindowWidth(),
            height: getWindowHeight(),
          },
        },
        isCheckout,
        snapshotTimestamp,
      );
      const node = await snapshotInChunks(
        document,
        createSnapshotOptions(candidateMirror, generation, snapshotTimestamp, pendingIframeLoads),
        {
          timeSliceMs: snapshotTimeSliceMs,
          shouldStop: () => stopped || snapshotQueueOverflow || mirrorResetNeeded,
          skipPreparation: generation > 1,
          beforeSnapshot: () => {
            // Native records still waiting before this exact cut are already
            // represented by the full snapshot baseline.
            for (const buffer of mutationBuffers) buffer.discardPendingRecords();
            for (let index = queuedSnapshotEvents.length - 1; index >= 0; index -= 1) {
              const event = queuedSnapshotEvents[index]!.event;
              if (
                event.type === EventType.IncrementalSnapshot &&
                ((event.data.source === IncrementalSource.Mutation &&
                  event.data.isAttachIframe !== true) ||
                  event.data.source === IncrementalSource.StyleSheetRule ||
                  event.data.source === IncrementalSource.StyleDeclaration ||
                  event.data.source === IncrementalSource.AdoptedStyleSheet)
              ) {
                queuedSnapshotEvents.splice(index, 1);
              }
            }
            queuedSnapshotBytes = queuedSnapshotEvents.reduce(
              (bytes, entry) => bytes + entry.bytes,
              0,
            );
            stylesheetManager.reset();
            snapshotStarted = true;
            canvasManager.prepareForFullSnapshot();
            imageManager.prepareForFullSnapshot();
          },
          afterCapturedTopology: reconcileTopologyEvents,
          getTopologyRevision: () => topologyRevision,
          getPrivacyRevision: () => privacyRevision,
          deferIframeDocuments,
          onSnapshotUnstable: () => {
            snapshotUnstable = true;
            queuedSnapshotCheckout = undefined;
            scheduleSnapshotRetry();
          },
          onShadowRoot: (shadowRoot) => {
            shadowDomManager.addShadowRoot(shadowRoot, shadowRoot.ownerDocument);
          },
          onIframeDocument: registerSnapshotIframe,
        },
      );
      if (
        stopped ||
        snapshotQueueOverflow ||
        mirrorResetNeeded ||
        queuedSnapshotCheckout !== undefined
      )
        return;
      if (node === null) {
        if (snapshotUnstable || mirrorResetNeeded || queuedSnapshotCheckout !== undefined) return;
        throw new Error("Snapshot error.");
      }

      const fullSnapshotEvent: eventWithTime = {
        type: EventType.FullSnapshot,
        timestamp: snapshotTimestamp,
        data: {
          node,
          initialOffset: getWindowScroll(window),
        },
      };
      const deliveryPrivacyRevision = privacyRevision;
      if (prepareForSnapshotPart !== undefined) {
        await prepareForSnapshotPart(
          getSnapshotEstimatedBytes(node) ?? estimateEventBytes(fullSnapshotEvent),
        );
      }
      if (privacyRevision !== deliveryPrivacyRevision) {
        snapshotUnstable = true;
        scheduleSnapshotRetry();
        return;
      }
      if (stopped || snapshotQueueOverflow || mirrorResetNeeded) return;
      sendEvent(fullSnapshotEvent, isCheckout);
      hasCommittedSnapshot = true;
      committed = true;
    } finally {
      mirror.stopIdReservation();
      if (committed) {
        try {
          // The iframe baseline must be visible before any mutations collected
          // from its document while the sliced snapshot was running.
          await attachPendingIframes(pendingIframeLoads);
          shadowDomManager.emitAdoptedStyleSheetsForSnapshot();
          if (document.adoptedStyleSheets && document.adoptedStyleSheets.length > 0) {
            stylesheetManager.adoptStyleSheets(document.adoptedStyleSheets, mirror.getId(document));
          }
          if (
            (deferIframeDocuments || queuedIframeSnapshots.size === 0) &&
            queuedSnapshotCheckout === undefined
          ) {
            await flushQueuedSnapshotEvents();
          }
        } finally {
          fullSnapshotRunning = false;
        }
      } else {
        if (snapshotStarted && !stopped) protectLiveMirrorAfterAbort();
        queuedSnapshotEvents.splice(0);
        queuedIframeAttachments.splice(0);
        queuedSnapshotBytes = 0;
        pendingIframeLoads.splice(0);
        fullSnapshotRunning = false;
      }
      if (snapshotStarted) imageManager.finishFullSnapshot();
    }
  };

  const runIframeSnapshot = async (iframe: HTMLIFrameElement, iframeDocument: Document) => {
    const isCurrentDocument = () => isCurrentIframeDocument(iframe, iframeDocument);
    if (prepareForSnapshotPart !== undefined) await prepareForSnapshotPart();
    if (
      stopped ||
      queuedSnapshotCheckout !== undefined ||
      !isCurrentDocument() ||
      isBlocked(iframe, blockClass, blockSelector, true)
    )
      return;
    const generation = ++snapshotGeneration;
    const candidateMirror = createMirror();
    const snapshotTimestamp = nowTimestamp();
    const nestedIframeLoads: PendingIframeLoad[] = [];
    let snapshotUnstable = false;
    let snapshotStarted = false;
    let attached = false;
    mirror.startIdReservation(genId);
    fullSnapshotRunning = true;

    try {
      if (!isCurrentDocument() || isBlocked(iframe, blockClass, blockSelector, true)) return;
      iframeManager.observeIframe(iframe);
      shadowDomManager.observeAttachShadow(iframe);
      snapshotStarted = true;
      const node = await snapshotInChunks(
        iframeDocument,
        createSnapshotOptions(candidateMirror, generation, snapshotTimestamp, nestedIframeLoads),
        {
          timeSliceMs: snapshotTimeSliceMs,
          skipPreparation: true,
          privacyParent: iframe,
          shouldStop: () =>
            stopped ||
            snapshotQueueOverflow ||
            mirrorResetNeeded ||
            !isCurrentDocument() ||
            isBlocked(iframe, blockClass, blockSelector, true),
          afterCapturedTopology: reconcileTopologyEvents,
          getTopologyRevision: () => topologyRevision,
          getPrivacyRevision: () => privacyRevision,
          deferIframeDocuments,
          onSnapshotUnstable: () => {
            snapshotUnstable = true;
            queuedSnapshotCheckout = undefined;
            scheduleSnapshotRetry();
          },
          onShadowRoot: (shadowRoot) => {
            shadowDomManager.addShadowRoot(shadowRoot, shadowRoot.ownerDocument);
          },
          onIframeDocument: registerSnapshotIframe,
        },
      );
      if (stopped || snapshotUnstable || mirrorResetNeeded || node === null || !isCurrentDocument())
        return;

      const deliveryPrivacyRevision = privacyRevision;
      if (prepareForSnapshotPart !== undefined) {
        await prepareForSnapshotPart(getSnapshotEstimatedBytes(node) ?? 128 * 1_024);
      }
      if (privacyRevision !== deliveryPrivacyRevision) {
        snapshotUnstable = true;
        scheduleSnapshotRetry();
        return;
      }
      if (
        stopped ||
        mirrorResetNeeded ||
        queuedSnapshotCheckout !== undefined ||
        !isCurrentDocument() ||
        isBlocked(iframe, blockClass, blockSelector, true)
      )
        return;
      iframeManager.attachIframe(iframe, node, snapshotTimestamp);
      shadowDomManager.observeAttachShadow(iframe);
      attached = (await flushQueuedIframeAttachments()) > 0;
      if (!attached) return;
      await attachPendingIframes(nestedIframeLoads);
      if (iframeDocument.adoptedStyleSheets?.length > 0) {
        stylesheetManager.adoptStyleSheets(
          iframeDocument.adoptedStyleSheets,
          mirror.getId(iframeDocument),
        );
      }
    } finally {
      if (snapshotStarted && !attached && !stopped) protectLiveMirrorAfterAbort();
      mirror.stopIdReservation();
      try {
        if (
          !stopped &&
          (deferIframeDocuments || queuedIframeSnapshots.size === 0) &&
          queuedSnapshotCheckout === undefined
        ) {
          await flushQueuedSnapshotEvents();
        }
      } finally {
        fullSnapshotRunning = false;
      }
    }
  };

  const startSnapshotTask = (task: () => Promise<void>) => {
    snapshotTaskActive = true;
    void task()
      .catch((error) => {
        if (errorHandler?.(error) !== true) console.warn(error);
      })
      .finally(() => {
        snapshotTaskActive = false;
        if (stopped) return;
        if (queuedSnapshotCheckout !== undefined) {
          const nextCheckout = queuedSnapshotCheckout;
          queuedSnapshotCheckout = undefined;
          takeFullSnapshot(nextCheckout);
          return;
        }
        const nextIframe = queuedIframeSnapshots.entries().next().value as
          | [Document, HTMLIFrameElement]
          | undefined;
        if (nextIframe !== undefined) {
          const [nextDocument, nextOwner] = nextIframe;
          queuedIframeSnapshots.delete(nextDocument);
          startSnapshotTask(() => runIframeSnapshot(nextOwner, nextDocument));
        }
      });
  };

  const takeIframeSnapshot = (iframe: HTMLIFrameElement, iframeDocument: Document) => {
    if (
      (!isOrangeReplaySdk && !recordDOM) ||
      stopped ||
      isBlocked(iframe, blockClass, blockSelector, true)
    )
      return;
    queuedIframeSnapshots.set(iframeDocument, iframe);
    if (snapshotTaskActive) return;
    queuedIframeSnapshots.delete(iframeDocument);
    startSnapshotTask(() => runIframeSnapshot(iframe, iframeDocument));
  };

  takeFullSnapshot = (isCheckout = false) => {
    if ((!isOrangeReplaySdk && !recordDOM) || stopped) return;
    if (snapshotTaskActive) {
      queuedSnapshotCheckout = (queuedSnapshotCheckout ?? false) || isCheckout;
      return;
    }

    snapshotRetryNeeded = false;
    if (snapshotRetryTimer !== undefined) {
      clearTimeout(snapshotRetryTimer);
      snapshotRetryTimer = undefined;
    }

    startSnapshotTask(() => runFullSnapshot(isCheckout));
  };

  try {
    const handlers: listenerHandler[] = [];

    const observe = (doc: Document, iframeOwner?: HTMLIFrameElement) => {
      const shouldRecord = () => {
        return (
          iframeOwner === undefined ||
          (isCurrentIframeDocument(iframeOwner, doc) &&
            !isBlocked(iframeOwner, blockClass, blockSelector, true) &&
            !isBlocked(iframeOwner, maskTextClass, maskTextSelector, true))
        );
      };
      const emitForDocument: typeof wrappedEmit = (event, isCheckout, timestamp) => {
        if (shouldRecord()) wrappedEmit(event, isCheckout, timestamp);
      };
      const mutationCb = (mutation: mutationCallbackParam) => {
        if (!shouldRecord()) return;
        wrappedMutationEmit(mutation);
      };
      return callbackWrapper(initObservers as unknown as (...args: unknown[]) => listenerHandler)(
        {
          mutationCb,
          mousemoveCb: (
            positions: Parameters<mousemoveCallBack>[0],
            source: Parameters<mousemoveCallBack>[1],
          ) =>
            emitForDocument({
              type: EventType.IncrementalSnapshot,
              data: {
                source,
                positions,
              },
            }),
          mouseInteractionCb: (d: Parameters<mouseInteractionCallBack>[0]) =>
            emitForDocument({
              type: EventType.IncrementalSnapshot,
              data: {
                source: IncrementalSource.MouseInteraction,
                ...d,
              },
            }),
          scrollCb: (position: Parameters<scrollCallback>[0]) => {
            if (shouldRecord()) wrappedScrollEmit(position);
          },
          viewportResizeCb: (d: Parameters<viewportResizeCallback>[0]) =>
            emitForDocument({
              type: EventType.IncrementalSnapshot,
              data: {
                source: IncrementalSource.ViewportResize,
                ...d,
              },
            }),
          inputCb: (v: Parameters<inputCallback>[0]) =>
            emitForDocument({
              type: EventType.IncrementalSnapshot,
              data: {
                source: IncrementalSource.Input,
                ...v,
              },
            }),
          mediaInteractionCb: (p: Parameters<mediaInteractionCallback>[0]) =>
            emitForDocument({
              type: EventType.IncrementalSnapshot,
              data: {
                source: IncrementalSource.MediaInteraction,
                ...p,
              },
            }),
          styleSheetRuleCb: (r: Parameters<styleSheetRuleCallback>[0]) =>
            emitForDocument({
              type: EventType.IncrementalSnapshot,
              data: {
                source: IncrementalSource.StyleSheetRule,
                ...r,
              },
            }),
          styleDeclarationCb: (r: Parameters<styleDeclarationCallback>[0]) =>
            emitForDocument({
              type: EventType.IncrementalSnapshot,
              data: {
                source: IncrementalSource.StyleDeclaration,
                ...r,
              },
            }),
          canvasMutationCb: (mutation: Parameters<canvasMutationCallback>[0]) => {
            if (shouldRecord()) wrappedCanvasMutationEmit(mutation);
          },
          fontCb: (p: Parameters<fontCallback>[0]) =>
            emitForDocument({
              type: EventType.IncrementalSnapshot,
              data: {
                source: IncrementalSource.Font,
                ...p,
              },
            }),
          selectionCb: (p: Parameters<selectionCallback>[0]) => {
            emitForDocument({
              type: EventType.IncrementalSnapshot,
              data: {
                source: IncrementalSource.Selection,
                ...p,
              },
            });
          },
          customElementCb: (c: Parameters<customElementCallback>[0]) => {
            emitForDocument({
              type: EventType.IncrementalSnapshot,
              data: {
                source: IncrementalSource.CustomElement,
                ...c,
              },
            });
          },
          blockClass,
          ignoreClass,
          ignoreSelector,
          maskTextClass,
          maskTextSelector,
          maskInputOptions,
          inlineStylesheet,
          sampling,
          recordDOM,
          // Newly added canvases are picked up by CanvasManager on its next
          // frame. Serializing their pixels here would use synchronous
          // canvas.toDataURL() and can freeze the host page.
          recordCanvas: false,
          inlineImages,
          userTriggeredOnInput,
          collectFonts,
          doc,
          shouldRecord,
          maskInputFn,
          maskTextFn,
          keepIframeSrcFn,
          blockSelector,
          slimDOMOptions,
          dataURLOptions,
          mirror,
          iframeManager,
          stylesheetManager,
          shadowDomManager,
          processedNodeManager,
          canvasManager,
          imageManager,
          mutationObservedCb: (mutations: readonly mutationRecord[]) => {
            if (!shouldRecord()) return;
            let topologyChanged = false;
            let privacyChanged = false;
            for (const mutation of mutations) {
              if (mutation.type === "childList") {
                topologyChanged = true;
                privacyChanged = true;
              } else if (
                mutation.type === "attributes" &&
                mutation.attributeName !== null &&
                privacyAttributeNames.has(mutation.attributeName.toLowerCase())
              ) {
                privacyChanged = true;
              } else if (mutation.type === "characterData" && privacyUsesText) {
                privacyChanged = true;
              }
            }
            if (topologyChanged) topologyRevision += 1;
            if (privacyChanged) {
              privacyRevision += 1;
              if (snapshotRetryNeeded) scheduleSnapshotRetry();
            }
          },
          // A very large added or removed subtree would make rrweb walk
          // thousands of nodes in one MutationObserver task. Replace that
          // mutation batch with a normal sliced checkpoint instead.
          largeMutationCb: () => {
            if (!shouldRecord()) return;
            mirrorResetNeeded = true;
            scheduleSnapshotRetry();
          },
          ignoreCSSAttributes,
          plugins: isOrangeReplaySdk
            ? []
            : plugins
                ?.filter((p) => p.observer)
                ?.map((p) => ({
                  observer: p.observer!,
                  options: p.options,
                  callback: (payload: object) =>
                    emitForDocument({
                      type: EventType.Plugin,
                      data: {
                        plugin: p.name,
                        payload,
                      },
                    }),
                })) || [],
        },
        isOrangeReplaySdk ? {} : hooks,
      ) as listenerHandler;
    };

    iframeManager.addLoadListener((iframeEl: HTMLIFrameElement) => {
      try {
        const iframeDocument = iframeEl.contentDocument;
        if (iframeDocument === null) return;
        return observe(iframeDocument, iframeEl);
      } catch (error) {
        // TODO: handle internal error
        console.warn(error);
      }
    });
    iframeManager.addSnapshotListener((iframe: HTMLIFrameElement, iframeDocument: Document) => {
      if (isBlocked(iframe, blockClass, blockSelector, true)) return;
      iframeManager.observeIframe(iframe);
      shadowDomManager.observeAttachShadow(iframe);
      takeIframeSnapshot(iframe, iframeDocument);
    });

    const init = () => {
      handlers.push(observe(document));
      recording = true;
      takeFullSnapshot();
    };
    if (["interactive", "complete"].includes(document.readyState)) {
      init();
    } else {
      handlers.push(
        on("DOMContentLoaded", () => {
          wrappedEmit({
            type: EventType.DomContentLoaded,
            data: {},
          });
          if (!isOrangeReplaySdk && recordAfter === "DOMContentLoaded") init();
        }),
      );
      handlers.push(
        on(
          "load",
          () => {
            wrappedEmit({
              type: EventType.Load,
              data: {},
            });
            if (isOrangeReplaySdk || recordAfter === "load") init();
          },
          window,
        ),
      );
    }
    return () => {
      stopped = true;
      if (snapshotRetryTimer !== undefined) clearTimeout(snapshotRetryTimer);
      queuedSnapshotEvents.splice(0);
      queuedIframeAttachments.splice(0);
      queuedSnapshotBytes = 0;
      pendingIframeLoads.splice(0);
      queuedIframeSnapshots.clear();
      handlers.forEach((handler) => {
        try {
          handler();
        } catch (error) {
          const msg = String(error).toLowerCase();
          /**
           * https://github.com/rrweb-io/rrweb/pull/1695
           * This error can occur in a known scenario:
           * If an iframe is initially same-origin and observed, but later its 
           location is changed in an opaque way to a cross-origin URL (perhaps within the iframe via its `document.location` or a redirect) 
           * attempting to execute the handler in the stop record function will 
           throw a "cannot access cross-origin frame" error.
           * This error is expected and can be safely ignored.
           */
          if (!msg.includes("cross-origin")) {
            console.warn(error);
          }
        }
      });
      shadowDomManager.reset();
      canvasManager.reset();
      imageManager.reset();
      iframeManager.reset();
      recording = false;
      unregisterErrorHandler();
    };
  } catch (error) {
    // TODO: handle internal error
    console.warn(error);
  }
}

record.addCustomEvent = <T>(tag: string, payload: T) => {
  if (!recording) {
    throw new Error("please add custom event after start recording");
  }
  wrappedEmit({
    type: EventType.Custom,
    data: {
      tag,
      payload,
    },
  });
};

if (!isOrangeReplaySdk) {
  record.freezePage = () => {
    for (const buffer of mutationBuffers) buffer.freeze();
  };
  record.mirror = publicMirror;
}

record.takeFullSnapshot = (isCheckout?: boolean) => {
  if (!recording) {
    throw new Error("please take full snapshot after start recording");
  }
  takeFullSnapshot(isCheckout);
};

export default record;
