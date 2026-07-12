import type { Mirror } from "../../rrweb-snapshot/index.ts";
import { EventType, IncrementalSource } from "../../rrweb-types/index.ts";
import type {
  eventWithoutTime,
  mutationCallbackParam,
  serializedNodeWithId,
  mutationCallBack,
} from "../../rrweb-types/index.ts";
import type { StylesheetManager } from "./stylesheet-manager";
import { CrossOriginIframeManager } from "./cross-origin-iframe-manager.ts";
import { isNodeInSubtrees } from "../utils.ts";

declare const __ORANGE_REPLAY_INCLUDE_CROSS_ORIGIN_IFRAMES__: boolean | undefined;
const includesCrossOriginIframes =
  typeof __ORANGE_REPLAY_INCLUDE_CROSS_ORIGIN_IFRAMES__ === "undefined" ||
  __ORANGE_REPLAY_INCLUDE_CROSS_ORIGIN_IFRAMES__;

type IframesByOwnerDocument = Map<Document, HTMLIFrameElement[]>;
type IframeClearTask = [iframe: HTMLIFrameElement, document: Document, finish: boolean];

function groupIframesByOwnerDocument(iframes: Iterable<HTMLIFrameElement>): IframesByOwnerDocument {
  const grouped = new Map<Document, HTMLIFrameElement[]>();
  for (const iframe of iframes) {
    const owner = iframe.ownerDocument;
    if (owner === null) continue;
    const children = grouped.get(owner);
    if (children === undefined) grouped.set(owner, [iframe]);
    else children.push(iframe);
  }
  return grouped;
}

export class IframeManager {
  declare private readonly crossOriginManager?: CrossOriginIframeManager;
  private mirror: Mirror;
  private mutationCb: mutationCallBack;
  private wrappedEmit: (e: eventWithoutTime, isCheckout?: boolean, timestamp?: number) => void;
  private loadListener?: (iframeEl: HTMLIFrameElement) => (() => void) | undefined;
  private stylesheetManager: StylesheetManager;
  private observedDocuments = new WeakSet<Document>();
  private capturedDocuments = new WeakSet<Document>();
  private currentDocuments = new WeakMap<HTMLIFrameElement, Document>();
  private documentOwners = new WeakMap<Document, HTMLIFrameElement>();
  private iframeLoadCleanups = new Map<HTMLIFrameElement, () => void>();
  private observerCleanups = new Map<HTMLIFrameElement, () => void>();
  private snapshotListener?: (iframe: HTMLIFrameElement, doc: Document) => void;
  private documentRemovedListener?: (doc: Document) => void;

  constructor(options: {
    mirror: Mirror;
    mutationCb: mutationCallBack;
    stylesheetManager: StylesheetManager;
    recordCrossOriginIframes: boolean;
    shouldRecordIframe?: (iframe: HTMLIFrameElement) => boolean;
    wrappedEmit: (e: eventWithoutTime, isCheckout?: boolean, timestamp?: number) => void;
  }) {
    this.mutationCb = options.mutationCb;
    this.wrappedEmit = options.wrappedEmit;
    this.stylesheetManager = options.stylesheetManager;
    this.mirror = options.mirror;
    if (includesCrossOriginIframes) {
      this.crossOriginManager = new CrossOriginIframeManager({
        mirror: this.mirror,
        stylesheetManager: this.stylesheetManager,
        wrappedEmit: this.wrappedEmit,
        shouldRecordIframe: options.shouldRecordIframe ?? (() => true),
        enabled: options.recordCrossOriginIframes,
      });
    }
  }

  public get crossOriginIframeMirror() {
    return includesCrossOriginIframes ? this.crossOriginManager?.nodeMirror : undefined;
  }

  public get crossOriginIframeStyleMirror() {
    return includesCrossOriginIframes ? this.crossOriginManager?.styleMirror : undefined;
  }

  public addIframe(iframeEl: HTMLIFrameElement, capturedDocument?: Document) {
    if (includesCrossOriginIframes) this.crossOriginManager?.addIframe(iframeEl);
    if (capturedDocument !== undefined) {
      this.trackDocument(iframeEl, capturedDocument);
      this.capturedDocuments.add(capturedDocument);
    }
    if (!this.iframeLoadCleanups.has(iframeEl)) {
      const handleLoad = () => {
        const doc = iframeEl.contentDocument;
        if (doc === null) {
          this.clearDocument(iframeEl);
        } else if (doc.readyState === "complete") {
          this.snapshotLoadedIframe(doc, iframeEl);
        }
      };
      iframeEl.addEventListener("load", handleLoad);
      this.iframeLoadCleanups.set(iframeEl, () => iframeEl.removeEventListener("load", handleLoad));
    }
  }

  public addLoadListener(cb: (iframeEl: HTMLIFrameElement) => (() => void) | undefined) {
    this.loadListener = cb;
  }

  public addSnapshotListener(cb: (iframe: HTMLIFrameElement, doc: Document) => void) {
    this.snapshotListener = cb;
  }

  public addDocumentRemovedListener(cb: (doc: Document) => void) {
    this.documentRemovedListener = cb;
  }

  public snapshotLoadedIframe(doc: Document, iframe?: HTMLIFrameElement) {
    if (
      this.snapshotListener === undefined ||
      doc.readyState !== "complete" ||
      this.capturedDocuments.has(doc)
    )
      return;
    const owner = iframe ?? (doc.defaultView?.frameElement as HTMLIFrameElement | null);
    if (owner === null || owner === undefined || owner.nodeName !== "IFRAME") return;
    this.capturedDocuments.add(doc);
    this.addIframe(owner, doc);
    this.snapshotListener(owner, doc);
  }

  public reset(final = true) {
    for (const cleanup of this.iframeLoadCleanups.values()) cleanup();
    for (const cleanup of this.observerCleanups.values()) cleanup();
    this.iframeLoadCleanups.clear();
    this.observerCleanups.clear();
    this.observedDocuments = new WeakSet();
    this.capturedDocuments = new WeakSet();
    this.currentDocuments = new WeakMap();
    this.documentOwners = new WeakMap();
    if (includesCrossOriginIframes) {
      if (final) this.crossOriginManager?.stop();
      else this.crossOriginManager?.clearNestedIframes();
    }
  }

  public observeIframe(iframeEl: HTMLIFrameElement) {
    const doc = iframeEl.contentDocument;
    if (doc === null) {
      this.clearDocument(iframeEl);
      return;
    }
    if (this.observedDocuments.has(doc)) return;
    this.trackDocument(iframeEl, doc);
    this.observedDocuments.add(doc);
    const cleanup = this.loadListener?.(iframeEl);
    if (cleanup !== undefined) this.observerCleanups.set(iframeEl, cleanup);
  }

  public isCurrentDocument(doc: Document | null): boolean {
    if (doc === null) return true;
    const owner = this.documentOwners.get(doc);
    return owner === undefined || this.isCurrentIframe(owner, doc);
  }

  public isCurrentIframe(iframe: HTMLIFrameElement, expected?: Document): boolean {
    const doc = expected ?? this.currentDocuments.get(iframe);
    if (doc === undefined) return false;
    try {
      return (
        iframe.isConnected &&
        this.isCurrentDocument(iframe.ownerDocument) &&
        iframe.contentDocument === doc
      );
    } catch {
      return false;
    }
  }

  public removeContainedIframes(roots: readonly Node[]): void {
    if (roots.length === 0) return;
    const iframesByOwnerDocument = groupIframesByOwnerDocument(this.iframeLoadCleanups.keys());
    for (const [iframe, cleanup] of this.iframeLoadCleanups) {
      if (!isNodeInSubtrees(iframe, roots)) continue;
      cleanup();
      this.iframeLoadCleanups.delete(iframe);
      this.clearDocument(iframe, iframesByOwnerDocument);
    }
  }

  public attachIframe(
    iframeEl: HTMLIFrameElement,
    childSn: serializedNodeWithId,
    timestamp?: number,
  ) {
    const mutation: mutationCallbackParam = {
      adds: [
        {
          parentId: this.mirror.getId(iframeEl),
          nextId: null,
          node: childSn,
        },
      ],
      removes: [],
      texts: [],
      attributes: [],
      isAttachIframe: true,
    };
    if (timestamp === undefined) {
      this.mutationCb(mutation);
    } else {
      this.wrappedEmit(
        {
          type: EventType.IncrementalSnapshot,
          data: { source: IncrementalSource.Mutation, ...mutation },
        },
        undefined,
        timestamp,
      );
    }

    if (includesCrossOriginIframes) this.crossOriginManager?.observeNestedIframes(iframeEl);

    this.observeIframe(iframeEl);

    if (
      iframeEl.contentDocument &&
      iframeEl.contentDocument.adoptedStyleSheets &&
      iframeEl.contentDocument.adoptedStyleSheets.length > 0
    )
      this.stylesheetManager.adoptStyleSheets(
        iframeEl.contentDocument.adoptedStyleSheets,
        this.mirror.getId(iframeEl.contentDocument),
      );
  }

  private trackDocument(iframe: HTMLIFrameElement, doc: Document): void {
    const previous = this.currentDocuments.get(iframe);
    if (previous !== undefined && previous !== doc) {
      this.clearDocument(iframe);
    }
    this.currentDocuments.set(iframe, doc);
    this.documentOwners.set(doc, iframe);
  }

  private clearDocument(
    iframe: HTMLIFrameElement,
    iframesByOwnerDocument = groupIframesByOwnerDocument(this.iframeLoadCleanups.keys()),
  ): void {
    const firstDocument = this.currentDocuments.get(iframe);
    if (firstDocument === undefined) return;
    const pending: IframeClearTask[] = [[iframe, firstDocument, false]];

    while (pending.length > 0) {
      const [currentIframe, currentDocument, finish] = pending.pop()!;
      if (!finish) {
        pending.push([currentIframe, currentDocument, true]);
        const nestedIframes = iframesByOwnerDocument.get(currentDocument) ?? [];
        for (let index = nestedIframes.length - 1; index >= 0; index -= 1) {
          const nestedIframe = nestedIframes[index]!;
          const cleanup = this.iframeLoadCleanups.get(nestedIframe);
          const nestedDocument = this.currentDocuments.get(nestedIframe);
          if (cleanup === undefined) continue;
          cleanup();
          this.iframeLoadCleanups.delete(nestedIframe);
          if (nestedDocument !== undefined) {
            pending.push([nestedIframe, nestedDocument, false]);
          }
        }
        continue;
      }

      this.observerCleanups.get(currentIframe)?.();
      this.observerCleanups.delete(currentIframe);
      if (this.mirror.hasNode(currentDocument)) this.mirror.removeNodeFromMap(currentDocument);
      this.observedDocuments.delete(currentDocument);
      this.capturedDocuments.delete(currentDocument);
      this.currentDocuments.delete(currentIframe);
      this.documentRemovedListener?.(currentDocument);
    }
  }
}
