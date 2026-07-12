import type { MutationBufferParam } from "../types";
import type {
  mutationCallBack,
  scrollCallback,
  SamplingStrategy,
} from "../../rrweb-types/index.ts";
import {
  initMutationObserver,
  initScrollObserver,
  initAdoptedStyleSheetObserver,
} from "./observer";
import { inDom, isBlocked, isNodeInSubtrees } from "../utils";
import type { Mirror } from "../../rrweb-snapshot/index.ts";
import { isNativeShadowDom } from "../../rrweb-snapshot/index.ts";
import dom, { patch } from "../../rrweb-utils/index.ts";

type BypassOptions = Omit<
  MutationBufferParam,
  "doc" | "mutationCb" | "mirror" | "shadowDomManager"
> & {
  sampling: SamplingStrategy;
};

export class ShadowDomManager {
  private shadowDoms = new WeakSet<ShadowRoot>();
  private trackedShadowRoots = new Map<ShadowRoot, Array<() => void>>();
  private mutationCb: mutationCallBack;
  private scrollCb: scrollCallback;
  private bypassOptions: BypassOptions;
  private mirror: Mirror;
  private restoreHandlers = new Map<Document, () => void>();
  private iframeOwners = new Map<Document, HTMLIFrameElement>();
  private observedIframeDocuments = new WeakSet<Document>();
  private iframeDocuments = new WeakMap<HTMLIFrameElement, Document>();

  constructor(options: {
    mutationCb: mutationCallBack;
    scrollCb: scrollCallback;
    bypassOptions: BypassOptions;
    mirror: Mirror;
  }) {
    this.mutationCb = options.mutationCb;
    this.scrollCb = options.scrollCb;
    this.bypassOptions = options.bypassOptions;
    this.mirror = options.mirror;

    this.init();
  }

  public init() {
    this.reset();
    // Patch 'attachShadow' to observe newly added shadow doms.
    this.patchAttachShadow(Element, document);
  }

  public addShadowRoot(shadowRoot: ShadowRoot, doc: Document) {
    if (!isNativeShadowDom(shadowRoot)) return;
    if (this.shadowDoms.has(shadowRoot)) return;
    this.shadowDoms.add(shadowRoot);
    const rootCleanups: Array<() => void> = [];
    this.trackedShadowRoots.set(shadowRoot, rootCleanups);
    const shouldRecord = () => {
      const host = dom.host(shadowRoot);
      return (
        !isBlocked(host, this.bypassOptions.blockClass, this.bypassOptions.blockSelector, true) &&
        host !== null &&
        inDom(host)
      );
    };
    const [, cleanupMutationObserver] = initMutationObserver(
      {
        ...this.bypassOptions,
        doc,
        mutationCb: (mutation: Parameters<mutationCallBack>[0]) => {
          if (shouldRecord()) this.mutationCb(mutation);
        },
        mirror: this.mirror,
        shadowDomManager: this,
      },
      shadowRoot,
    );
    rootCleanups.push(cleanupMutationObserver);
    rootCleanups.push(
      initScrollObserver({
        ...this.bypassOptions,
        scrollCb: (position: Parameters<scrollCallback>[0]) => {
          if (shouldRecord()) this.scrollCb(position);
        },
        // https://gist.github.com/praveenpuglia/0832da687ed5a5d7a0907046c9ef1813
        // scroll is not allowed to pass the boundary, so we need to listen the shadow document
        doc: shadowRoot as unknown as Document,
        mirror: this.mirror,
      }),
    );
    // Defer this to avoid adoptedStyleSheet events being created before the full snapshot is created or attachShadow action is recorded.
    setTimeout(() => {
      const activeCleanups = this.trackedShadowRoots.get(shadowRoot);
      if (activeCleanups === undefined) return;
      if (
        shouldRecord() &&
        shadowRoot.adoptedStyleSheets &&
        shadowRoot.adoptedStyleSheets.length > 0
      )
        this.bypassOptions.stylesheetManager.adoptStyleSheets(
          shadowRoot.adoptedStyleSheets,
          this.mirror.getId(dom.host(shadowRoot)),
        );
      activeCleanups.push(
        initAdoptedStyleSheetObserver(
          {
            mirror: this.mirror,
            stylesheetManager: this.bypassOptions.stylesheetManager,
          },
          shadowRoot,
          shouldRecord,
        ),
      );
    }, 0);
  }

  public emitAdoptedStyleSheetsForSnapshot() {
    for (const shadowRoot of this.trackedShadowRoots.keys()) {
      const hostId = this.mirror.getId(dom.host(shadowRoot));
      const adoptedStyleSheets = shadowRoot.adoptedStyleSheets;
      if (
        hostId > 0 &&
        !isBlocked(
          dom.host(shadowRoot),
          this.bypassOptions.blockClass,
          this.bypassOptions.blockSelector,
          true,
        ) &&
        adoptedStyleSheets &&
        adoptedStyleSheets.length > 0
      ) {
        this.bypassOptions.stylesheetManager.adoptStyleSheets(adoptedStyleSheets, hostId);
      }
    }
  }

  public removeContainedRoots(roots: readonly Node[]): void {
    if (roots.length === 0) return;
    for (const [shadowRoot, cleanups] of this.trackedShadowRoots) {
      const host = dom.host(shadowRoot);
      if (host === null || !isNodeInSubtrees(host, roots)) continue;
      for (const cleanup of cleanups) cleanup();
      this.trackedShadowRoots.delete(shadowRoot);
      this.shadowDoms.delete(shadowRoot);
    }
    for (const [doc] of this.restoreHandlers) {
      if (doc === document) continue;
      const frame = this.iframeOwners.get(doc);
      if (frame == null || !isNodeInSubtrees(frame, roots)) continue;
      this.removeDocument(doc);
    }
  }

  /**
   * Monkey patch 'attachShadow' of an IFrameElement to observe newly added shadow doms.
   */
  public observeAttachShadow(iframeElement: HTMLIFrameElement) {
    if (!iframeElement.contentWindow || !iframeElement.contentDocument) return;
    const iframeDocument = iframeElement.contentDocument;
    const previousDocument = this.iframeDocuments.get(iframeElement);
    if (previousDocument !== undefined && previousDocument !== iframeDocument) {
      this.removeDocument(previousDocument);
    }
    if (this.observedIframeDocuments.has(iframeDocument)) return;
    this.iframeDocuments.set(iframeElement, iframeDocument);
    this.iframeOwners.set(iframeDocument, iframeElement);
    this.observedIframeDocuments.add(iframeDocument);

    this.patchAttachShadow(
      (
        iframeElement.contentWindow as Window & {
          Element: { prototype: Element };
        }
      ).Element,
      iframeDocument,
    );
  }

  /**
   * Patch 'attachShadow' to observe newly added shadow doms.
   */
  private patchAttachShadow(
    element: {
      prototype: Element;
    },
    doc: Document,
  ) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const manager = this;
    this.restoreHandlers.set(
      doc,
      patch(
        element.prototype,
        "attachShadow",
        function (original: (init: ShadowRootInit) => ShadowRoot) {
          return function (this: Element, option: ShadowRootInit) {
            const sRoot = original.call(this, option);
            // For the shadow dom elements in the document, monitor their dom mutations.
            // For shadow dom elements that aren't in the document yet,
            // we start monitoring them once their shadow dom host is appended to the document.
            const shadowRootEl = dom.shadowRoot(this);
            if (shadowRootEl && inDom(this)) manager.addShadowRoot(shadowRootEl, doc);
            return sRoot;
          };
        },
      ),
    );
  }

  public reset() {
    this.restoreHandlers.forEach((handler) => {
      try {
        handler();
      } catch (e) {
        //
      }
    });
    this.restoreHandlers.clear();
    this.iframeOwners.clear();
    for (const cleanups of this.trackedShadowRoots.values()) {
      for (const cleanup of cleanups) cleanup();
    }
    this.shadowDoms = new WeakSet();
    this.trackedShadowRoots.clear();
    this.observedIframeDocuments = new WeakSet();
    this.iframeDocuments = new WeakMap();
  }

  public removeDocument(doc: Document): void {
    for (const [shadowRoot, cleanups] of this.trackedShadowRoots) {
      const host = dom.host(shadowRoot);
      if (host?.ownerDocument !== doc) continue;
      for (const cleanup of cleanups) cleanup();
      this.trackedShadowRoots.delete(shadowRoot);
      this.shadowDoms.delete(shadowRoot);
    }
    this.restoreHandlers.get(doc)?.();
    this.restoreHandlers.delete(doc);
    const iframe = this.iframeOwners.get(doc);
    if (iframe !== undefined) this.iframeDocuments.delete(iframe);
    this.iframeOwners.delete(doc);
    this.observedIframeDocuments.delete(doc);
  }
}
