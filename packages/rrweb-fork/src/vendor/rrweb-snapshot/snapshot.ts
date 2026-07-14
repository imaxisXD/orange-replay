import type {
  MaskInputOptions,
  SlimDOMOptions,
  MaskTextFn,
  MaskInputFn,
  KeepIframeSrcFn,
  ICanvas,
  DialogAttributes,
} from "./types";
import { NodeType } from "../rrweb-types/index.ts";
import type {
  serializedNode,
  serializedNodeWithId,
  serializedElementNodeWithId,
  elementNode,
  attributes,
  mediaAttributes,
  DataURLOptions,
} from "../rrweb-types/index.ts";
import {
  Mirror,
  is2DCanvasBlank,
  isElement,
  isShadowRoot,
  maskInputValue,
  isNativeShadowDom,
  stringifyStylesheet,
  getInputType,
  toLowerCase,
  extractFileExtension,
  absolutifyURLs,
  markCssSplits,
} from "./snapshot-utils";
import dom, {
  getSnapshotChildNodes,
  getSnapshotNextSibling,
  getSnapshotShadowRoot,
} from "../rrweb-utils/index.ts";

let _id = 1;
const tagNameRegex = new RegExp("[^a-z0-9-_:]");

export const IGNORED_NODE = -2;
const snapshotEstimatedBytes = new WeakMap<object, number>();

declare const __ORANGE_REPLAY_SDK_PROFILE__: boolean | undefined;
const isOrangeReplaySdk =
  typeof __ORANGE_REPLAY_SDK_PROFILE__ !== "undefined" && __ORANGE_REPLAY_SDK_PROFILE__;

export function getSnapshotEstimatedBytes(node: serializedNodeWithId): number | undefined {
  return snapshotEstimatedBytes.get(node);
}

export function genId(): number {
  return _id++;
}

function getValidTagName(element: HTMLElement): Lowercase<string> {
  if (element instanceof HTMLFormElement) {
    return "form";
  }

  const processedTagName = toLowerCase(element.tagName);

  if (tagNameRegex.test(processedTagName)) {
    // if the tag name is odd and we cannot extract
    // anything from the string, then we return a
    // generic div
    return "div";
  }

  return processedTagName;
}

let canvasService: HTMLCanvasElement | null;
let canvasCtx: CanvasRenderingContext2D | null;
const MAX_INLINE_IMAGE_PIXELS = 4_000_000;
const MAX_INLINE_IMAGE_DATA_URL_CHARACTERS = 2_000_000;

function keepInlineImage(target: attributes, dataURL: string): void {
  if (dataURL.length <= MAX_INLINE_IMAGE_DATA_URL_CHARACTERS) {
    target.rr_dataURL = dataURL;
  }
}

// eslint-disable-next-line no-control-regex
const SRCSET_NOT_SPACES = /^[^ \t\n\r\u000c]+/; // Don't use \s, to avoid matching non-breaking space
// eslint-disable-next-line no-control-regex
const SRCSET_COMMAS_OR_SPACES = /^[, \t\n\r\u000c]+/;
function getAbsoluteSrcsetString(doc: Document, attributeValue: string) {
  /*
    run absoluteToDoc over every url in the srcset

    this is adapted from https://github.com/albell/parse-srcset/
    without the parsing of the descriptors (we return these as-is)
    parce-srcset is in turn based on
    https://html.spec.whatwg.org/multipage/embedded-content.html#parse-a-srcset-attribute
  */
  if (attributeValue.trim() === "") {
    return attributeValue;
  }

  let pos = 0;

  function collectCharacters(regEx: RegExp) {
    let chars: string;
    const match = regEx.exec(attributeValue.substring(pos));
    if (match) {
      chars = match[0];
      pos += chars.length;
      return chars;
    }
    return "";
  }

  const output = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    collectCharacters(SRCSET_COMMAS_OR_SPACES);
    if (pos >= attributeValue.length) {
      break;
    }
    // don't split on commas within urls
    let url = collectCharacters(SRCSET_NOT_SPACES);
    if (url.slice(-1) === ",") {
      // aside: according to spec more than one comma at the end is a parse error, but we ignore that
      url = absoluteToDoc(doc, url.substring(0, url.length - 1));
      // the trailing comma splits the srcset, so the interpretion is that
      // another url will follow, and the descriptor is empty
      output.push(url);
    } else {
      let descriptorsStr = "";
      url = absoluteToDoc(doc, url);
      let inParens = false;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const c = attributeValue.charAt(pos);
        if (c === "") {
          output.push((url + descriptorsStr).trim());
          break;
        } else if (!inParens) {
          if (c === ",") {
            pos += 1;
            output.push((url + descriptorsStr).trim());
            break; // parse the next url
          } else if (c === "(") {
            inParens = true;
          }
        } else {
          // in parenthesis; ignore commas
          // (parenthesis may be supported by future additions to spec)
          if (c === ")") {
            inParens = false;
          }
        }
        descriptorsStr += c;
        pos += 1;
      }
    }
  }
  return output.join(", ");
}

const cachedDocument = new WeakMap<Document, HTMLAnchorElement>();

export function absoluteToDoc(doc: Document, attributeValue: string): string {
  if (!attributeValue || attributeValue.trim() === "") {
    return attributeValue;
  }

  return getHref(doc, attributeValue);
}

function isSVGElement(el: Element): boolean {
  return Boolean(el.tagName === "svg" || (el as SVGElement).ownerSVGElement);
}

function getHref(doc: Document, customHref?: string) {
  let a = cachedDocument.get(doc);
  if (!a) {
    a = doc.createElement("a");
    cachedDocument.set(doc, a);
  }
  if (!customHref) {
    customHref = "";
  } else if (customHref.startsWith("blob:") || customHref.startsWith("data:")) {
    return customHref;
  }
  // note: using `new URL` is slower. See #1434 or https://jsbench.me/uqlud17rxo/1
  a.setAttribute("href", customHref);
  return a.href;
}

export function transformAttribute(
  doc: Document,
  tagName: Lowercase<string>,
  name: Lowercase<string>,
  value: string | null,
): string | null {
  if (!value) {
    return value;
  }

  // relative path in attribute
  if (name === "src" || (name === "href" && !(tagName === "use" && value[0] === "#"))) {
    // href starts with a # is an id pointer for svg
    return absoluteToDoc(doc, value);
  } else if (name === "xlink:href" && value[0] !== "#") {
    // xlink:href starts with # is an id pointer
    return absoluteToDoc(doc, value);
  } else if (name === "background" && ["table", "td", "th"].includes(tagName)) {
    return absoluteToDoc(doc, value);
  } else if (name === "srcset") {
    return getAbsoluteSrcsetString(doc, value);
  } else if (name === "style") {
    return absolutifyURLs(value, getHref(doc));
  } else if (tagName === "object" && name === "data") {
    return absoluteToDoc(doc, value);
  }

  return value;
}

export function ignoreAttribute(
  tagName: string,
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _value: unknown,
): boolean {
  return ["video", "audio"].includes(tagName) && name === "autoplay";
}

export function _isBlockedElement(
  element: HTMLElement,
  blockClass: string | RegExp,
  blockSelector: string | null,
): boolean {
  try {
    if (isOrangeReplaySdk || typeof blockClass === "string") {
      if (element.classList.contains(blockClass as string)) {
        return true;
      }
    } else {
      for (let eIndex = element.classList.length; eIndex--; ) {
        const className = element.classList[eIndex];
        blockClass.lastIndex = 0;
        if (blockClass.test(className)) {
          return true;
        }
      }
    }
    if (blockSelector) {
      return element.matches(blockSelector);
    }
  } catch (e) {
    //
  }

  return false;
}

export function classMatchesRegex(
  node: Node | null,
  regex: RegExp,
  checkAncestors: boolean,
): boolean {
  let element = closestPrivacyElement(node);
  while (element !== null) {
    for (let eIndex = element.classList.length; eIndex--; ) {
      const className = element.classList[eIndex];
      regex.lastIndex = 0;
      if (regex.test(className)) return true;
    }
    if (!checkAncestors) return false;
    element = privacyParentElement(element);
  }
  return false;
}

export function closestPrivacyElement(node: Node | null): Element | null {
  if (node === null) return null;
  if (node.nodeType === node.ELEMENT_NODE) return node as Element;
  const parent = dom.parentElement(node);
  if (parent !== null) return parent;
  const root = node.getRootNode?.();
  const host = (root as ShadowRoot | undefined)?.host;
  if (host !== undefined && host.nodeType === 1) return host;
  try {
    return node.ownerDocument?.defaultView?.frameElement ?? null;
  } catch {
    return null;
  }
}

export function privacyParentElement(element: Element): Element | null {
  if (element.parentElement !== null) return element.parentElement;
  const root = element.getRootNode?.();
  const host = (root as ShadowRoot | undefined)?.host;
  if (host !== undefined && host.nodeType === 1) return host;
  try {
    return element.ownerDocument.defaultView?.frameElement ?? null;
  } catch {
    return null;
  }
}

function matchesPrivacyTree(
  node: Node,
  privacyClass: string | RegExp,
  privacySelector: string | null,
): boolean {
  let element = closestPrivacyElement(node);
  while (element !== null) {
    if (_isBlockedElement(element as HTMLElement, privacyClass, privacySelector)) return true;
    element = privacyParentElement(element);
  }
  return false;
}

export function needMaskingText(
  node: Node,
  maskTextClass: string | RegExp,
  maskTextSelector: string | null,
  checkAncestors: boolean,
): boolean {
  if (isElement(node)) {
    if (!dom.childNodes(node).length) {
      // optimisation: we can avoid any of the below checks on leaf elements
      // as masking is applied to child text nodes only
      return false;
    }
  }
  let currentElement = closestPrivacyElement(node);
  while (currentElement !== null) {
    try {
      if (isOrangeReplaySdk || typeof maskTextClass === "string") {
        if (currentElement.classList.contains(maskTextClass as string)) return true;
      } else if (classMatchesRegex(currentElement, maskTextClass, false)) {
        return true;
      }
      if (maskTextSelector && currentElement.matches(maskTextSelector)) return true;
    } catch (e) {
      // Invalid selectors should not stop recording.
    }
    if (!checkAncestors) return false;
    currentElement = privacyParentElement(currentElement);
  }
  return false;
}

// https://stackoverflow.com/a/36155560
function onceIframeLoaded(
  iframeEl: HTMLIFrameElement,
  listener: () => unknown,
  iframeLoadTimeout: number,
  skipCurrentLoad = false,
) {
  const win = iframeEl.contentWindow;
  if (!win) {
    return;
  }
  // document is loading
  let fired = false;

  let readyState: DocumentReadyState;
  try {
    readyState = win.document.readyState;
  } catch (error) {
    return;
  }
  if (readyState !== "complete") {
    const timer = setTimeout(() => {
      if (!fired) {
        listener();
        fired = true;
      }
    }, iframeLoadTimeout);
    iframeEl.addEventListener("load", () => {
      clearTimeout(timer);
      fired = true;
      listener();
    });
    return;
  }
  // check blank frame for Chrome
  const blankUrl = "about:blank";
  if (win.location.href !== blankUrl || iframeEl.src === blankUrl || iframeEl.src === "") {
    // iframe was already loaded, make sure we wait to trigger the listener
    // till _after_ the mutation that found this iframe has had time to process
    if (!skipCurrentLoad) setTimeout(listener, 0);

    return iframeEl.addEventListener("load", listener); // keep listing for future loads
  }
  // use default listener
  iframeEl.addEventListener("load", listener);
}

function getLoadedIframeDocument(iframe: HTMLIFrameElement): Document | null {
  try {
    const win = iframe.contentWindow;
    const doc = iframe.contentDocument;
    if (win === null || doc === null || doc.readyState !== "complete") return null;
    const blankUrl = "about:blank";
    return win.location.href !== blankUrl || iframe.src === blankUrl || iframe.src === ""
      ? doc
      : null;
  } catch {
    return null;
  }
}

function onceStylesheetLoaded(
  link: HTMLLinkElement,
  listener: () => unknown,
  styleSheetLoadTimeout: number,
) {
  let fired = false;
  let styleSheetLoaded: StyleSheet | null;
  try {
    styleSheetLoaded = link.sheet;
  } catch (error) {
    return;
  }

  if (styleSheetLoaded) return;

  const timer = setTimeout(() => {
    if (!fired) {
      listener();
      fired = true;
    }
  }, styleSheetLoadTimeout);

  link.addEventListener("load", () => {
    clearTimeout(timer);
    fired = true;
    listener();
  });
}

function serializeNode(
  n: Node,
  options: {
    doc: Document;
    mirror: Mirror;
    blockClass: string | RegExp;
    blockSelector: string | null;
    needsBlock?: boolean;
    needsMask: boolean;
    inlineStylesheet: boolean;
    maskInputOptions: MaskInputOptions;
    maskTextFn: MaskTextFn | undefined;
    maskInputFn: MaskInputFn | undefined;
    dataURLOptions?: DataURLOptions;
    inlineImages: boolean;
    deferInlineImages: boolean;
    recordCanvas: boolean;
    keepIframeSrcFn: KeepIframeSrcFn;
    /**
     * `newlyAddedElement: true` skips scrollTop and scrollLeft check
     */
    newlyAddedElement?: boolean;
    cssCaptured?: boolean;
  },
  snapshotParent?: Node | null,
): serializedNode | false {
  const {
    doc,
    mirror,
    blockClass,
    blockSelector,
    needsBlock,
    needsMask,
    inlineStylesheet,
    maskInputOptions = {},
    maskTextFn,
    maskInputFn,
    dataURLOptions = {},
    inlineImages,
    deferInlineImages,
    recordCanvas,
    keepIframeSrcFn,
    newlyAddedElement = false,
    cssCaptured = false,
  } = options;
  // Only record root id when document object is not the base document
  const rootId = getRootId(doc, mirror);
  switch (n.nodeType) {
    case n.DOCUMENT_NODE:
      if ((n as Document).compatMode !== "CSS1Compat") {
        return {
          type: NodeType.Document,
          childNodes: [],
          compatMode: (n as Document).compatMode, // probably "BackCompat"
        };
      } else {
        return {
          type: NodeType.Document,
          childNodes: [],
        };
      }
    case n.DOCUMENT_TYPE_NODE:
      return {
        type: NodeType.DocumentType,
        name: (n as DocumentType).name,
        publicId: (n as DocumentType).publicId,
        systemId: (n as DocumentType).systemId,
        rootId,
      };
    case n.ELEMENT_NODE:
      return serializeElementNode(n as HTMLElement, {
        doc,
        blockClass,
        blockSelector,
        needsBlock,
        inlineStylesheet,
        maskInputOptions,
        maskInputFn,
        dataURLOptions,
        inlineImages,
        deferInlineImages,
        recordCanvas,
        keepIframeSrcFn,
        newlyAddedElement,
        rootId,
      });
    case n.TEXT_NODE:
      return serializeTextNode(
        n as Text,
        {
          doc,
          needsMask,
          maskTextFn,
          rootId,
          cssCaptured,
        },
        snapshotParent,
      );
    case n.CDATA_SECTION_NODE:
      return {
        type: NodeType.CDATA,
        textContent: "",
        rootId,
      };
    case n.COMMENT_NODE:
      return {
        type: NodeType.Comment,
        textContent: dom.textContent(n as Comment) || "",
        rootId,
      };
    default:
      return false;
  }
}

function getRootId(doc: Document, mirror: Mirror): number | undefined {
  if (!mirror.hasNode(doc)) return undefined;
  const docId = mirror.getId(doc);
  return docId === 1 ? undefined : docId;
}

function serializeTextNode(
  n: Text,
  options: {
    doc: Document;
    needsMask: boolean;
    maskTextFn: MaskTextFn | undefined;
    rootId: number | undefined;
    cssCaptured?: boolean;
  },
  snapshotParent?: Node | null,
): serializedNode {
  const { needsMask, maskTextFn, rootId, cssCaptured } = options;
  // The parent node may not be a html element which has a tagName attribute.
  // So just let it be undefined which is ok in this use case.
  const parent = snapshotParent === undefined ? dom.parentNode(n) : snapshotParent;
  const parentTagName = parent && (parent as HTMLElement).tagName;
  let textContent: string | null = "";
  const isStyle = parentTagName === "STYLE" ? true : undefined;
  const isScript = parentTagName === "SCRIPT" ? true : undefined;
  if (isScript) {
    textContent = "SCRIPT_PLACEHOLDER";
  } else if (!cssCaptured) {
    textContent = dom.textContent(n);
    if (isStyle && textContent) {
      // mutation only: we don't need to use stringifyStylesheet
      // as a <style> text node mutation obliterates any previous
      // programmatic rule manipulation (.insertRule etc.)
      // so the current textContent represents the most up to date state
      textContent = absolutifyURLs(textContent, getHref(options.doc));
    }
  }
  if (!isStyle && !isScript && textContent && needsMask) {
    textContent =
      !isOrangeReplaySdk && maskTextFn
        ? maskTextFn(
            textContent,
            parent !== null && parent.nodeType === parent.ELEMENT_NODE
              ? (parent as HTMLElement)
              : null,
          )
        : textContent.replace(/[\S]/g, "*");
  }

  return {
    type: NodeType.Text,
    textContent: textContent || "",
    rootId,
  };
}

function serializeElementNode(
  n: HTMLElement,
  options: {
    doc: Document;
    blockClass: string | RegExp;
    blockSelector: string | null;
    needsBlock?: boolean;
    inlineStylesheet?: boolean;
    maskInputOptions: MaskInputOptions;
    maskInputFn: MaskInputFn | undefined;
    dataURLOptions?: DataURLOptions;
    inlineImages: boolean;
    deferInlineImages: boolean;
    recordCanvas: boolean;
    keepIframeSrcFn: KeepIframeSrcFn;
    /**
     * `newlyAddedElement: true` skips scrollTop and scrollLeft check
     */
    newlyAddedElement?: boolean;
    rootId: number | undefined;
  },
): serializedNode | false {
  const {
    doc,
    blockClass,
    blockSelector,
    needsBlock,
    inlineStylesheet,
    maskInputOptions = {},
    maskInputFn,
    dataURLOptions = {},
    inlineImages,
    deferInlineImages,
    recordCanvas,
    keepIframeSrcFn,
    newlyAddedElement = false,
    rootId,
  } = options;
  const needBlock = needsBlock ?? _isBlockedElement(n, blockClass, blockSelector);
  const tagName = getValidTagName(n);
  let attributes: attributes = {};
  const len = n.attributes.length;
  for (let i = 0; i < len; i++) {
    const attr = n.attributes[i];
    if (!ignoreAttribute(tagName, attr.name, attr.value)) {
      attributes[attr.name] = transformAttribute(doc, tagName, toLowerCase(attr.name), attr.value);
    }
  }
  // remote css
  if (tagName === "link" && inlineStylesheet) {
    //TODO: maybe replace this `.styleSheets` with original one
    const stylesheet = Array.from(doc.styleSheets).find((s) => {
      return s.href === (n as HTMLLinkElement).href;
    });
    let cssText: string | null = null;
    if (stylesheet) {
      cssText = stringifyStylesheet(stylesheet);
    }
    if (cssText) {
      delete attributes.rel;
      delete attributes.href;
      attributes._cssText = cssText;
    }
  }
  if (tagName === "style" && (n as HTMLStyleElement).sheet) {
    let cssText = stringifyStylesheet((n as HTMLStyleElement).sheet as CSSStyleSheet);
    if (cssText) {
      if (n.childNodes.length > 1) {
        cssText = markCssSplits(cssText, n as HTMLStyleElement);
      }
      attributes._cssText = cssText;
    }
  }
  // form fields
  if (["input", "textarea", "select"].includes(tagName)) {
    const value = (n as HTMLInputElement | HTMLTextAreaElement).value;
    const checked = (n as HTMLInputElement).checked;
    if (isOrangeReplaySdk) {
      // Attribute values can be older than the live property. Always replace
      // them, including empty, checkbox, and radio values.
      attributes.value = "*".repeat(value.length);
      if (checked) attributes.checked = true;
      else delete attributes.checked;
    } else if (
      attributes.type !== "radio" &&
      attributes.type !== "checkbox" &&
      attributes.type !== "submit" &&
      attributes.type !== "button" &&
      value
    ) {
      attributes.value = maskInputValue({
        element: n,
        type: getInputType(n),
        tagName,
        value,
        maskInputOptions,
        maskInputFn,
      });
    } else if (checked) {
      attributes.checked = checked;
    }
  }
  if (tagName === "option") {
    if (isOrangeReplaySdk && typeof attributes.value === "string") {
      attributes.value = "*".repeat(attributes.value.length);
    }
    if ((n as HTMLOptionElement).selected && !isOrangeReplaySdk && !maskInputOptions["select"]) {
      attributes.selected = true;
    } else {
      // ignore the html attribute (which corresponds to DOM (n as HTMLOptionElement).defaultSelected)
      // if it's already been changed
      delete attributes.selected;
    }
  }

  if (tagName === "dialog" && (n as HTMLDialogElement).open) {
    // register what type of dialog is this
    // `modal` or `non-modal`
    // this is used to trigger `showModal()` or `show()` on replay (outside of rrweb-snapshot, in rrweb)
    (attributes as DialogAttributes).rr_open_mode = n.matches("dialog:modal")
      ? "modal"
      : "non-modal";
  }

  // canvas image data
  if (!isOrangeReplaySdk && tagName === "canvas" && recordCanvas) {
    try {
      if ((n as ICanvas).__context === "2d") {
        // only record this on 2d canvas
        if (!is2DCanvasBlank(n as HTMLCanvasElement)) {
          keepInlineImage(
            attributes,
            (n as HTMLCanvasElement).toDataURL(dataURLOptions.type, dataURLOptions.quality),
          );
        }
      } else if (!("__context" in n)) {
        // context is unknown, better not call getContext to trigger it
        const canvasDataURL = (n as HTMLCanvasElement).toDataURL(
          dataURLOptions.type,
          dataURLOptions.quality,
        );

        // create blank canvas of same dimensions
        const blankCanvas = doc.createElement("canvas");
        blankCanvas.width = (n as HTMLCanvasElement).width;
        blankCanvas.height = (n as HTMLCanvasElement).height;
        const blankCanvasDataURL = blankCanvas.toDataURL(
          dataURLOptions.type,
          dataURLOptions.quality,
        );

        // no need to save dataURL if it's the same as blank canvas
        if (canvasDataURL !== blankCanvasDataURL) {
          keepInlineImage(attributes, canvasDataURL);
        }
      }
    } catch {
      // A tainted canvas is unreadable. Keep recording the rest of the page.
    }
  }
  if (tagName === "img" && (isOrangeReplaySdk || inlineImages)) {
    if (isOrangeReplaySdk || deferInlineImages) {
      // ImageManager seals these pixels after the recorder snapshot. Remove
      // network sources so replay cannot contact the recorded website first.
      delete attributes.src;
      delete attributes.srcset;
      delete attributes.imagesrcset;
    } else {
      if (!canvasService) {
        canvasService = doc.createElement("canvas");
        canvasCtx = canvasService.getContext("2d");
      }
      const image = n as HTMLImageElement;
      const recordInlineImage = () => {
        image.removeEventListener("load", recordInlineImage);
        if (
          image.naturalWidth <= 0 ||
          image.naturalHeight <= 0 ||
          image.naturalWidth * image.naturalHeight > MAX_INLINE_IMAGE_PIXELS ||
          canvasCtx === null
        ) {
          return;
        }
        try {
          canvasService!.width = image.naturalWidth;
          canvasService!.height = image.naturalHeight;
          canvasCtx.drawImage(image, 0, 0);
          keepInlineImage(
            attributes,
            canvasService!.toDataURL(dataURLOptions.type, dataURLOptions.quality),
          );
        } catch {
          // Cross-origin images without CORS cannot be read.
        }
      };
      if (image.complete && image.naturalWidth !== 0) recordInlineImage();
      else image.addEventListener("load", recordInlineImage, { once: true });
    }
  }
  // media elements
  if (["audio", "video"].includes(tagName)) {
    const mediaAttributes = attributes as mediaAttributes;
    mediaAttributes.rr_mediaState = (n as HTMLMediaElement).paused ? "paused" : "played";
    mediaAttributes.rr_mediaCurrentTime = (n as HTMLMediaElement).currentTime;
    mediaAttributes.rr_mediaPlaybackRate = (n as HTMLMediaElement).playbackRate;
    mediaAttributes.rr_mediaMuted = (n as HTMLMediaElement).muted;
    mediaAttributes.rr_mediaLoop = (n as HTMLMediaElement).loop;
    mediaAttributes.rr_mediaVolume = (n as HTMLMediaElement).volume;
  }
  // Scroll
  if (!newlyAddedElement) {
    // `scrollTop` and `scrollLeft` are expensive calls because they trigger reflow.
    // Since `scrollTop` & `scrollLeft` are always 0 when an element is added to the DOM.
    // And scrolls also get picked up by rrweb's ScrollObserver
    // So we can safely skip the `scrollTop/Left` calls for newly added elements
    if (n.scrollLeft) {
      attributes.rr_scrollLeft = n.scrollLeft;
    }
    if (n.scrollTop) {
      attributes.rr_scrollTop = n.scrollTop;
    }
  }
  // block element
  if (needBlock) {
    const { width, height } = n.getBoundingClientRect();
    attributes = {
      class: attributes.class,
      rr_width: `${width}px`,
      rr_height: `${height}px`,
    };
  }
  // iframe
  if (tagName === "iframe" && (isOrangeReplaySdk || !keepIframeSrcFn(attributes.src as string))) {
    if (!(n as HTMLIFrameElement).contentDocument) {
      // we can't record it directly as we can't see into it
      // preserve the src attribute so a decision can be taken at replay time
      attributes.rr_src = attributes.src;
    }
    delete attributes.src; // prevent auto loading
  }

  let isCustomElement: true | undefined;
  try {
    if (customElements.get(tagName)) isCustomElement = true;
  } catch (e) {
    // In case old browsers don't support customElements
  }

  return {
    type: NodeType.Element,
    tagName,
    attributes,
    childNodes: [],
    isSVG: isSVGElement(n as Element) || undefined,
    needBlock,
    rootId,
    isCustom: isCustomElement,
  };
}

function lowerIfExists(maybeAttr: string | number | boolean | undefined | null): string {
  if (maybeAttr === undefined || maybeAttr === null) {
    return "";
  } else {
    return (maybeAttr as string).toLowerCase();
  }
}

export function slimDOMDefaults(
  _slimDOMOptions: SlimDOMOptions | "all" | true | false | undefined,
) {
  if (_slimDOMOptions === true || _slimDOMOptions === "all") {
    // if true: set of sensible options that should not throw away any information
    return {
      script: true,
      comment: true,
      headFavicon: true,
      headWhitespace: true,
      headMetaSocial: true,
      headMetaRobots: true,
      headMetaHttpEquiv: true,
      headMetaVerification: true,
      // the following are off for slimDOMOptions === true,
      // as they destroy some (hidden) info:
      headMetaAuthorship: _slimDOMOptions === "all",
      headMetaDescKeywords: _slimDOMOptions === "all",
      headTitleMutations: _slimDOMOptions === "all",
    };
  } else if (_slimDOMOptions) {
    return _slimDOMOptions;
  }
  return {};
}

function slimDOMExcluded(sn: serializedNode, slimDOMOptions: SlimDOMOptions): boolean {
  if (slimDOMOptions.comment && sn.type === NodeType.Comment) {
    // TODO: convert IE conditional comments to real nodes
    return true;
  } else if (sn.type === NodeType.Element) {
    if (
      slimDOMOptions.script &&
      // script tag
      (sn.tagName === "script" ||
        // (module)preload link
        (sn.tagName === "link" &&
          ((sn.attributes.rel === "preload" && sn.attributes.as === "script") ||
            sn.attributes.rel === "modulepreload")) ||
        // prefetch link
        (sn.tagName === "link" &&
          sn.attributes.rel === "prefetch" &&
          typeof sn.attributes.href === "string" &&
          extractFileExtension(sn.attributes.href) === "js"))
    ) {
      return true;
    } else if (
      slimDOMOptions.headFavicon &&
      ((sn.tagName === "link" && sn.attributes.rel === "shortcut icon") ||
        (sn.tagName === "meta" &&
          (lowerIfExists(sn.attributes.name).match(/^msapplication-tile(image|color)$/) ||
            lowerIfExists(sn.attributes.name) === "application-name" ||
            lowerIfExists(sn.attributes.rel) === "icon" ||
            lowerIfExists(sn.attributes.rel) === "apple-touch-icon" ||
            lowerIfExists(sn.attributes.rel) === "shortcut icon")))
    ) {
      return true;
    } else if (sn.tagName === "meta") {
      if (
        slimDOMOptions.headMetaDescKeywords &&
        lowerIfExists(sn.attributes.name).match(/^description|keywords$/)
      ) {
        return true;
      } else if (
        slimDOMOptions.headMetaSocial &&
        (lowerIfExists(sn.attributes.property).match(/^(og|twitter|fb):/) || // og = opengraph (facebook)
          lowerIfExists(sn.attributes.name).match(/^(og|twitter):/) ||
          lowerIfExists(sn.attributes.name) === "pinterest")
      ) {
        return true;
      } else if (
        slimDOMOptions.headMetaRobots &&
        (lowerIfExists(sn.attributes.name) === "robots" ||
          lowerIfExists(sn.attributes.name) === "googlebot" ||
          lowerIfExists(sn.attributes.name) === "bingbot")
      ) {
        return true;
      } else if (slimDOMOptions.headMetaHttpEquiv && sn.attributes["http-equiv"] !== undefined) {
        // e.g. X-UA-Compatible, Content-Type, Content-Language,
        // cache-control, X-Translated-By
        return true;
      } else if (
        slimDOMOptions.headMetaAuthorship &&
        (lowerIfExists(sn.attributes.name) === "author" ||
          lowerIfExists(sn.attributes.name) === "generator" ||
          lowerIfExists(sn.attributes.name) === "framework" ||
          lowerIfExists(sn.attributes.name) === "publisher" ||
          lowerIfExists(sn.attributes.name) === "progid" ||
          lowerIfExists(sn.attributes.property).match(/^article:/) ||
          lowerIfExists(sn.attributes.property).match(/^product:/))
      ) {
        return true;
      } else if (
        slimDOMOptions.headMetaVerification &&
        (lowerIfExists(sn.attributes.name) === "google-site-verification" ||
          lowerIfExists(sn.attributes.name) === "yandex-verification" ||
          lowerIfExists(sn.attributes.name) === "csrf-token" ||
          lowerIfExists(sn.attributes.name) === "p:domain_verify" ||
          lowerIfExists(sn.attributes.name) === "verify-v1" ||
          lowerIfExists(sn.attributes.name) === "verification" ||
          lowerIfExists(sn.attributes.name) === "shopify-checkout-api-token")
      ) {
        return true;
      }
    }
  }
  return false;
}

export function serializeNodeWithId(
  n: Node,
  options: {
    doc: Document;
    mirror: Mirror;
    blockClass: string | RegExp;
    blockSelector: string | null;
    needsBlock?: boolean;
    maskTextClass: string | RegExp;
    maskTextSelector: string | null;
    skipChild: boolean;
    inlineStylesheet?: boolean;
    newlyAddedElement?: boolean;
    maskInputOptions?: MaskInputOptions;
    needsMask?: boolean;
    maskTextFn?: MaskTextFn;
    maskInputFn?: MaskInputFn;
    slimDOMOptions?: SlimDOMOptions;
    dataURLOptions?: DataURLOptions;
    keepIframeSrcFn?: KeepIframeSrcFn;
    inlineImages?: boolean;
    deferInlineImages?: boolean;
    recordCanvas?: boolean;
    preserveWhiteSpace?: boolean;
    onSerialize?: (n: Node) => unknown;
    onIframeLoad?: (
      iframeNode: HTMLIFrameElement,
      node: serializedElementNodeWithId,
      capturedDocument?: Document,
    ) => unknown;
    iframeLoadTimeout?: number;
    onStylesheetLoad?: (linkNode: HTMLLinkElement, node: serializedElementNodeWithId) => unknown;
    stylesheetLoadTimeout?: number;
    cssCaptured?: boolean;
    reservedId?: number;
    reuseIdsFrom?: Mirror;
    onIframeReady?: (doc: Document) => void;
    skipIframeInitialLoad?: boolean;
  },
  snapshotParent?: Node | null,
): serializedNodeWithId | null {
  const {
    doc,
    mirror,
    blockClass,
    blockSelector,
    needsBlock,
    maskTextClass,
    maskTextSelector,
    skipChild = false,
    inlineStylesheet = true,
    maskInputOptions = {},
    maskTextFn,
    maskInputFn,
    slimDOMOptions = {},
    dataURLOptions = {},
    inlineImages = false,
    deferInlineImages = false,
    recordCanvas = false,
    onSerialize,
    onIframeLoad,
    iframeLoadTimeout = 5000,
    onStylesheetLoad,
    stylesheetLoadTimeout = 5000,
    keepIframeSrcFn = () => false,
    newlyAddedElement = false,
    cssCaptured = false,
    reservedId,
    reuseIdsFrom,
    onIframeReady,
    skipIframeInitialLoad = false,
  } = options;
  let { needsMask } = options;
  let { preserveWhiteSpace = true } = options;

  if (!needsMask) {
    // perf: if needsMask = true, children won't also need to check
    const checkAncestors = needsMask === undefined; // if false, we've already checked ancestors
    needsMask = needMaskingText(n as Element, maskTextClass, maskTextSelector, checkAncestors);
  }

  const _serializedNode = serializeNode(
    n,
    {
      doc,
      mirror,
      blockClass,
      blockSelector,
      needsBlock,
      needsMask,
      inlineStylesheet,
      maskInputOptions,
      maskTextFn,
      maskInputFn,
      dataURLOptions,
      inlineImages,
      deferInlineImages,
      recordCanvas,
      keepIframeSrcFn,
      newlyAddedElement,
      cssCaptured,
    },
    snapshotParent,
  );
  if (!_serializedNode) {
    // TODO: dev only
    console.warn(n, "not serialized");
    return null;
  }

  let id: number;
  if (
    !isOrangeReplaySdk &&
    (slimDOMExcluded(_serializedNode, slimDOMOptions) ||
      (!preserveWhiteSpace &&
        _serializedNode.type === NodeType.Text &&
        !_serializedNode.textContent.replace(/^\s+|\s+$/gm, "").length))
  ) {
    id = IGNORED_NODE;
  } else {
    const currentId = mirror.hasNode(n) ? mirror.getId(n) : -1;
    const previousId = currentId > 0 ? currentId : (reservedId ?? reuseIdsFrom?.getId(n) ?? -1);
    id = previousId > 0 ? previousId : genId();
  }

  const serializedNode = Object.assign(_serializedNode, { id });
  // add IGNORED_NODE to mirror to track nextSiblings
  mirror.add(n, serializedNode);

  if (id === IGNORED_NODE) {
    return null; // slimDOM
  }

  if (onSerialize) {
    onSerialize(n);
  }
  let recordChild = !skipChild;
  let nodeWasBlocked = false;
  if (serializedNode.type === NodeType.Element) {
    nodeWasBlocked = serializedNode.needBlock === true;
    recordChild = recordChild && !serializedNode.needBlock;
    // this property was not needed in replay side
    delete serializedNode.needBlock;
    const shadowRootEl = dom.shadowRoot(n);
    if (shadowRootEl && isNativeShadowDom(shadowRootEl)) serializedNode.isShadowHost = true;
  }
  if (
    (serializedNode.type === NodeType.Document || serializedNode.type === NodeType.Element) &&
    recordChild
  ) {
    if (
      !isOrangeReplaySdk &&
      slimDOMOptions.headWhitespace &&
      serializedNode.type === NodeType.Element &&
      serializedNode.tagName === "head"
      // would impede performance: || getComputedStyle(n)['white-space'] === 'normal'
    ) {
      preserveWhiteSpace = false;
    }
    const bypassOptions = {
      doc,
      mirror,
      blockClass,
      blockSelector,
      needsMask,
      maskTextClass,
      maskTextSelector,
      skipChild,
      inlineStylesheet,
      maskInputOptions,
      maskTextFn,
      maskInputFn,
      slimDOMOptions,
      dataURLOptions,
      inlineImages,
      deferInlineImages,
      recordCanvas,
      preserveWhiteSpace,
      onSerialize,
      onIframeLoad,
      onIframeReady,
      iframeLoadTimeout,
      onStylesheetLoad,
      stylesheetLoadTimeout,
      keepIframeSrcFn,
      cssCaptured: false,
      reuseIdsFrom,
    };

    if (
      serializedNode.type === NodeType.Element &&
      serializedNode.tagName === "textarea" &&
      (serializedNode as elementNode).attributes.value !== undefined
    ) {
      // value parameter in DOM reflects the correct value, so ignore childNode
    } else {
      if (
        serializedNode.type === NodeType.Element &&
        (serializedNode as elementNode).attributes._cssText !== undefined &&
        typeof serializedNode.attributes._cssText === "string"
      ) {
        bypassOptions.cssCaptured = true;
      }
      for (const childN of Array.from(dom.childNodes(n))) {
        const serializedChildNode = serializeNodeWithId(childN, bypassOptions);
        if (serializedChildNode) {
          serializedNode.childNodes.push(serializedChildNode);
        }
      }
    }

    let shadowRootEl: ShadowRoot | null = null;
    if (isElement(n) && (shadowRootEl = dom.shadowRoot(n))) {
      for (const childN of Array.from(dom.childNodes(shadowRootEl))) {
        const serializedChildNode = serializeNodeWithId(childN, bypassOptions);
        if (serializedChildNode) {
          isNativeShadowDom(shadowRootEl) && (serializedChildNode.isShadow = true);
          serializedNode.childNodes.push(serializedChildNode);
        }
      }
    }
  }

  const liveParent = dom.parentNode(n);
  if (liveParent && isShadowRoot(liveParent) && isNativeShadowDom(liveParent)) {
    serializedNode.isShadow = true;
  }

  if (
    serializedNode.type === NodeType.Element &&
    serializedNode.tagName === "iframe" &&
    !nodeWasBlocked
  ) {
    const iframe = n as HTMLIFrameElement;
    if (onIframeReady !== undefined) {
      const iframeDoc = iframe.contentDocument;
      if (!skipIframeInitialLoad && iframeDoc?.readyState === "complete") {
        onIframeReady(iframeDoc);
      }
    } else {
      onceIframeLoaded(
        iframe,
        () => {
          const iframeDoc = iframe.contentDocument;
          if (!iframeDoc || !onIframeLoad) return;
          const serializedIframeNode = serializeNodeWithId(iframeDoc, {
            doc: iframeDoc,
            mirror,
            blockClass,
            blockSelector,
            needsMask,
            maskTextClass,
            maskTextSelector,
            skipChild: false,
            inlineStylesheet,
            maskInputOptions,
            maskTextFn,
            maskInputFn,
            slimDOMOptions,
            dataURLOptions,
            inlineImages,
            deferInlineImages,
            recordCanvas,
            preserveWhiteSpace,
            onSerialize,
            onIframeLoad,
            iframeLoadTimeout,
            onStylesheetLoad,
            stylesheetLoadTimeout,
            keepIframeSrcFn,
            reuseIdsFrom,
          });

          if (serializedIframeNode) {
            onIframeLoad(iframe, serializedIframeNode as serializedElementNodeWithId);
          }
        },
        iframeLoadTimeout,
      );
    }
  }

  // <link rel=stylesheet href=...>
  if (
    serializedNode.type === NodeType.Element &&
    serializedNode.tagName === "link" &&
    typeof serializedNode.attributes.rel === "string" &&
    (serializedNode.attributes.rel === "stylesheet" ||
      (serializedNode.attributes.rel === "preload" &&
        typeof serializedNode.attributes.href === "string" &&
        extractFileExtension(serializedNode.attributes.href) === "css"))
  ) {
    onceStylesheetLoaded(
      n as HTMLLinkElement,
      () => {
        if (onStylesheetLoad) {
          const serializedLinkNode = serializeNodeWithId(n, {
            doc,
            mirror,
            blockClass,
            blockSelector,
            needsMask,
            maskTextClass,
            maskTextSelector,
            skipChild: false,
            inlineStylesheet,
            maskInputOptions,
            maskTextFn,
            maskInputFn,
            slimDOMOptions,
            dataURLOptions,
            inlineImages,
            deferInlineImages,
            recordCanvas,
            preserveWhiteSpace,
            onSerialize,
            onIframeLoad,
            iframeLoadTimeout,
            onStylesheetLoad,
            stylesheetLoadTimeout,
            keepIframeSrcFn,
            reuseIdsFrom,
          });

          if (serializedLinkNode) {
            onStylesheetLoad(
              n as HTMLLinkElement,
              serializedLinkNode as serializedElementNodeWithId,
            );
          }
        }
      },
      stylesheetLoadTimeout,
    );
  }

  return serializedNode;
}

export interface SnapshotOptions {
  mirror?: Mirror;
  reuseIdsFrom?: Mirror;
  blockClass?: string | RegExp;
  blockSelector?: string | null;
  maskTextClass?: string | RegExp;
  maskTextSelector?: string | null;
  inlineStylesheet?: boolean;
  maskAllInputs?: boolean | MaskInputOptions;
  maskTextFn?: MaskTextFn;
  maskInputFn?: MaskInputFn;
  slimDOM?: "all" | boolean | SlimDOMOptions;
  dataURLOptions?: DataURLOptions;
  inlineImages?: boolean;
  /** Used by record() to move pixel encoding off the snapshot task. */
  deferInlineImages?: boolean;
  recordCanvas?: boolean;
  preserveWhiteSpace?: boolean;
  onSerialize?: (n: Node) => unknown;
  onIframeLoad?: (
    iframeNode: HTMLIFrameElement,
    node: serializedElementNodeWithId,
    capturedDocument?: Document,
  ) => unknown;
  onIframeReady?: (doc: Document) => void;
  iframeLoadTimeout?: number;
  onStylesheetLoad?: (linkNode: HTMLLinkElement, node: serializedElementNodeWithId) => unknown;
  stylesheetLoadTimeout?: number;
  keepIframeSrcFn?: KeepIframeSrcFn;
}

export interface CapturedTopology {
  readonly length: number;
  getNode(index: number): Node;
  getParentIndex(index: number): number;
  getFlags(index: number): number;
  setFlags(index: number, flags: number): void;
  getLiveId(index: number): number;
  getNextLiveId(index: number): number | null;
}

export interface ChunkedSnapshotControl {
  timeSliceMs?: number;
  now?: () => number;
  yieldToMain?: () => Promise<void>;
  shouldStop?: () => boolean;
  beforeSnapshot?: () => void;
  afterTopology?: (
    capturedIds: readonly number[],
    parentIndexes: readonly number[],
    nextIds: readonly (number | null)[],
  ) => void | Promise<void>;
  /** Internal zero-copy reader used by the Orange Replay recorder bundle. */
  afterCapturedTopology?: (topology: CapturedTopology) => void | Promise<void>;
  onShadowRoot?: (shadowRoot: ShadowRoot) => void;
  onIframeDocument?: (iframe: HTMLIFrameElement, doc: Document) => void;
  deferIframeDocuments?: boolean;
  getTopologyRevision?: () => number;
  getPrivacyRevision?: () => number;
  onSnapshotUnstable?: () => void;
  privacyParent?: Element;
  skipPreparation?: boolean;
}

function snapshot(n: Document, options?: SnapshotOptions): serializedNodeWithId | null {
  const {
    mirror = new Mirror(),
    blockClass = "rr-block",
    blockSelector = null,
    maskTextClass = "rr-mask",
    maskTextSelector = null,
    inlineStylesheet = true,
    inlineImages = false,
    deferInlineImages = false,
    recordCanvas = false,
    maskAllInputs = false,
    maskTextFn,
    maskInputFn,
    slimDOM = false,
    dataURLOptions,
    preserveWhiteSpace,
    onSerialize,
    onIframeLoad,
    onIframeReady,
    iframeLoadTimeout,
    onStylesheetLoad,
    stylesheetLoadTimeout,
    keepIframeSrcFn = () => false,
    reuseIdsFrom,
  } = options || {};
  const maskInputOptions = resolveMaskInputOptions(maskAllInputs);
  const slimDOMOptions = slimDOMDefaults(slimDOM);

  return serializeNodeWithId(n, {
    doc: n,
    mirror,
    blockClass,
    blockSelector,
    maskTextClass,
    maskTextSelector,
    skipChild: false,
    inlineStylesheet,
    maskInputOptions,
    maskTextFn,
    maskInputFn,
    slimDOMOptions,
    dataURLOptions,
    inlineImages,
    deferInlineImages,
    recordCanvas,
    preserveWhiteSpace,
    onSerialize,
    onIframeLoad,
    onIframeReady,
    iframeLoadTimeout,
    onStylesheetLoad,
    stylesheetLoadTimeout,
    keepIframeSrcFn,
    newlyAddedElement: false,
    reuseIdsFrom,
  });
}

function estimateSerializedNodeBytes(node: serializedNodeWithId): number {
  let bytes = 48;
  if (node.type === NodeType.Element) {
    bytes += node.tagName.length * 2;
    for (const [name, value] of Object.entries(node.attributes)) {
      bytes += name.length * 2 + estimateSerializedValueBytes(value);
    }
  } else if (node.type === NodeType.Text || node.type === NodeType.Comment) {
    bytes += node.textContent.length * 2;
  } else if (node.type === NodeType.DocumentType) {
    bytes += (node.name.length + node.publicId.length + node.systemId.length) * 2;
  }
  return bytes;
}

function estimateSerializedValueBytes(value: unknown): number {
  if (typeof value === "string") return value.length * 2 + 2;
  if (typeof value === "number") return 16;
  if (typeof value === "boolean") return 5;
  if (value === null || value === undefined) return 4;
  return 64;
}

const CAPTURED_TOPOLOGY_CHUNK_SIZE = 1_024;

function fixedArray<T>(length: number): T[] {
  const values: T[] = [];
  values.length = length;
  return values;
}

interface CapturedTopologyChunk {
  capturedNodes: Node[];
  capturedParentIndexes: Uint32Array;
  capturedFlags: Uint8Array;
  capturedLiveIds?: Float64Array;
  capturedNextIndexes?: Uint32Array;
  capturedLastChildIndexes?: Uint32Array;
}

/**
 * Keeps topology capture writes bounded. Growing several large JavaScript
 * arrays at the same index can copy the whole capture in one browser task.
 */
class CapturedTopologyStore implements CapturedTopology {
  private readonly capturedChunks: CapturedTopologyChunk[] = [];
  public length = 0;

  addCapturedNode(node: Node, parentIndex: number, flags: number, liveId: number): void {
    const index = this.length;
    const chunkIndex = Math.floor(index / CAPTURED_TOPOLOGY_CHUNK_SIZE);
    const offset = index % CAPTURED_TOPOLOGY_CHUNK_SIZE;
    let chunk = this.capturedChunks[chunkIndex];
    if (chunk === undefined) {
      // Parent/flags stay for serialization. Live/next/last-child values are
      // only needed for reconciliation and can be released before we build
      // the serialized tree. Two shared buffers also avoid five independent
      // backing-store allocations at every page boundary.
      const serializedValues = new ArrayBuffer(CAPTURED_TOPOLOGY_CHUNK_SIZE * 5);
      const reconciliationValues = new ArrayBuffer(CAPTURED_TOPOLOGY_CHUNK_SIZE * 16);
      chunk = {
        capturedNodes: fixedArray<Node>(CAPTURED_TOPOLOGY_CHUNK_SIZE),
        capturedParentIndexes: new Uint32Array(serializedValues, 0, CAPTURED_TOPOLOGY_CHUNK_SIZE),
        capturedFlags: new Uint8Array(
          serializedValues,
          CAPTURED_TOPOLOGY_CHUNK_SIZE * 4,
          CAPTURED_TOPOLOGY_CHUNK_SIZE,
        ),
        capturedLiveIds: new Float64Array(reconciliationValues, 0, CAPTURED_TOPOLOGY_CHUNK_SIZE),
        capturedNextIndexes: new Uint32Array(
          reconciliationValues,
          CAPTURED_TOPOLOGY_CHUNK_SIZE * 8,
          CAPTURED_TOPOLOGY_CHUNK_SIZE,
        ),
        capturedLastChildIndexes: new Uint32Array(
          reconciliationValues,
          CAPTURED_TOPOLOGY_CHUNK_SIZE * 12,
          CAPTURED_TOPOLOGY_CHUNK_SIZE,
        ),
      };
      this.capturedChunks.push(chunk);
    }
    chunk.capturedNodes[offset] = node;
    chunk.capturedParentIndexes[offset] = parentIndex + 1;
    chunk.capturedFlags[offset] = flags;
    chunk.capturedLiveIds![offset] = liveId;
    this.length = index + 1;

    if (parentIndex < 0) return;
    const parentChunk = this.getChunk(parentIndex);
    const parentOffset = parentIndex % CAPTURED_TOPOLOGY_CHUNK_SIZE;
    const previousSiblingIndex = parentChunk.capturedLastChildIndexes![parentOffset]! - 1;
    if (previousSiblingIndex >= 0) {
      const previousChunk = this.getChunk(previousSiblingIndex);
      previousChunk.capturedNextIndexes![previousSiblingIndex % CAPTURED_TOPOLOGY_CHUNK_SIZE] =
        index + 1;
    }
    parentChunk.capturedLastChildIndexes![parentOffset] = index + 1;
  }

  getNode(index: number): Node {
    return this.getChunk(index).capturedNodes[index % CAPTURED_TOPOLOGY_CHUNK_SIZE]!;
  }

  getParentIndex(index: number): number {
    return this.getChunk(index).capturedParentIndexes[index % CAPTURED_TOPOLOGY_CHUNK_SIZE]! - 1;
  }

  getFlags(index: number): number {
    return this.getChunk(index).capturedFlags[index % CAPTURED_TOPOLOGY_CHUNK_SIZE]!;
  }

  setFlags(index: number, flags: number): void {
    this.getChunk(index).capturedFlags[index % CAPTURED_TOPOLOGY_CHUNK_SIZE] = flags;
  }

  getLiveId(index: number): number {
    return this.getChunk(index).capturedLiveIds![index % CAPTURED_TOPOLOGY_CHUNK_SIZE]!;
  }

  getNextLiveId(index: number): number | null {
    const nextIndex =
      this.getChunk(index).capturedNextIndexes![index % CAPTURED_TOPOLOGY_CHUNK_SIZE]! - 1;
    if (nextIndex < 0) return null;
    const nextLiveId = this.getLiveId(nextIndex);
    return nextLiveId > 0 ? nextLiveId : null;
  }

  releaseReconciliationValues(): void {
    for (const chunk of this.capturedChunks) {
      chunk.capturedLiveIds = undefined;
      chunk.capturedNextIndexes = undefined;
      chunk.capturedLastChildIndexes = undefined;
    }
  }

  private getChunk(index: number): CapturedTopologyChunk {
    return this.capturedChunks[Math.floor(index / CAPTURED_TOPOLOGY_CHUNK_SIZE)]!;
  }
}

/**
 * Serializes a live document in short tasks while the recorder's live mirror
 * continues to process events.
 */
export async function snapshotInChunks(
  n: Document,
  options: SnapshotOptions = {},
  control: ChunkedSnapshotControl = {},
): Promise<serializedNodeWithId | null> {
  const mirror = options.mirror ?? new Mirror();
  const blockClass = options.blockClass ?? "rr-block";
  const blockSelector = options.blockSelector ?? null;
  const maskTextClass = options.maskTextClass ?? "rr-mask";
  const maskTextSelector = options.maskTextSelector ?? null;
  const inlineStylesheet = options.inlineStylesheet ?? true;
  const maskInputOptions = resolveMaskInputOptions(options.maskAllInputs ?? false);
  const slimDOMOptions: SlimDOMOptions = isOrangeReplaySdk
    ? {}
    : slimDOMDefaults(options.slimDOM ?? false);
  const keepIframeSrcFn = options.keepIframeSrcFn ?? (() => false);
  const now = isOrangeReplaySdk
    ? () => n.defaultView?.performance.now() ?? Date.now()
    : (control.now ?? (() => n.defaultView?.performance.now() ?? Date.now()));
  const yieldToMain = isOrangeReplaySdk
    ? () => yieldForPaint(n.defaultView)
    : (control.yieldToMain ?? (() => yieldForPaint(n.defaultView)));
  const timeSliceMs = isOrangeReplaySdk ? 4 : cleanTimeSlice(control.timeSliceMs);
  const getTopologyChildNodes = getSnapshotChildNodes();
  const getTopologyNextSibling = getSnapshotNextSibling();
  const getTopologyShadowRoot = getSnapshotShadowRoot();
  if (control.skipPreparation !== true) {
    await yieldToMain();
    if (control.shouldStop?.() === true) return null;
  }
  control.beforeSnapshot?.();
  let sliceStartedAt = now();
  let root: serializedNodeWithId | null = null;

  type ParentNode = serializedNodeWithId & { childNodes: serializedNodeWithId[] };

  // Capture the tree shape in bounded tasks too. Mutations are observed while
  // this runs and reconciled against each node's captured parent before the
  // baseline is emitted.
  const MASKED = 1;
  const BLOCKED = 2;
  const SHADOW = 4;
  const RECORD_CHILDREN = 8;
  const IGNORE_DESCENDANTS = 16;
  const PRESERVE_WHITE_SPACE = 32;
  const CSS_CAPTURED = 64;
  const BLOCKED_BY_ANCESTOR = 128;
  if (
    control.privacyParent !== undefined &&
    matchesPrivacyTree(control.privacyParent, blockClass, blockSelector)
  ) {
    return null;
  }
  const rootNeedsMask =
    control.privacyParent !== undefined &&
    matchesPrivacyTree(control.privacyParent, maskTextClass, maskTextSelector);
  const topology = new CapturedTopologyStore();
  const visitedTopologyNodes = options.reuseIdsFrom === undefined ? new WeakSet<Node>() : undefined;
  options.reuseIdsFrom?.startTopologyCapture();
  const topologyIframeOwners = new Map<number, HTMLIFrameElement>();
  const iframeDocumentOwners = new WeakMap<Document, HTMLIFrameElement>();
  const iframeDocumentParentIndexes = new WeakMap<Document, number>();
  const capturedIframeDocuments = new WeakMap<HTMLIFrameElement, Document>();
  const topologyTaskNodes: Node[] = [n];
  const topologyTaskParentIndexes: number[] = [-1];
  const topologyTaskFlags: number[] = [rootNeedsMask ? MASKED : 0];
  const topologyTaskIsChildCursor: boolean[] = [false];
  const topologyTaskNextSiblings: Array<Node | null | undefined> = [undefined];
  let topologyRevision = control.getTopologyRevision?.() ?? 0;
  let topologyRepairs = 0;
  while (true) {
    while (topologyTaskNodes.length > 0) {
      if (control.shouldStop?.() === true) return null;
      const taskNode = topologyTaskNodes.pop()!;
      const parentIndex = topologyTaskParentIndexes.pop()!;
      const inheritedFlags = topologyTaskFlags.pop()!;
      const isChildCursor = topologyTaskIsChildCursor.pop()!;
      const capturedNextSibling = topologyTaskNextSiblings.pop();
      if (isChildCursor) {
        if (capturedNextSibling !== null && capturedNextSibling !== undefined) {
          topologyTaskNodes.push(capturedNextSibling);
          topologyTaskParentIndexes.push(parentIndex);
          topologyTaskFlags.push(inheritedFlags);
          topologyTaskIsChildCursor.push(true);
          topologyTaskNextSiblings.push(getTopologyNextSibling(capturedNextSibling));
        }
        topologyTaskNodes.push(taskNode);
        topologyTaskParentIndexes.push(parentIndex);
        topologyTaskFlags.push(inheritedFlags);
        topologyTaskIsChildCursor.push(false);
        topologyTaskNextSiblings.push(undefined);
        if (now() - sliceStartedAt >= timeSliceMs) {
          await yieldToMain();
          sliceStartedAt = now();
        }
        continue;
      }

      const currentNode = taskNode;
      let liveId = -1;
      if (options.reuseIdsFrom === undefined) {
        if (visitedTopologyNodes!.has(currentNode)) continue;
        visitedTopologyNodes!.add(currentNode);
      } else {
        liveId = options.reuseIdsFrom.getId(currentNode);
        if (!options.reuseIdsFrom.activateReservation(currentNode)) continue;
      }
      const currentIndex = topology.length;
      const nodeType = currentNode.nodeType;
      const isCurrentElement = nodeType === 1;
      const canHaveChildren = isCurrentElement || nodeType === 9 || nodeType === 11;
      const children = canHaveChildren ? getTopologyChildNodes(currentNode) : null;
      let needsMask =
        (inheritedFlags & MASKED) !== 0 ||
        (parentIndex !== -1 && (topology.getFlags(parentIndex) & MASKED) !== 0);
      let needsBlock = false;
      if (isCurrentElement) {
        const element = currentNode as HTMLElement;
        // Most application elements have no class at all. Avoid creating and
        // searching DOMTokenList twice for the common default privacy rules.
        const hasPrivacyClass = element.hasAttribute("class");
        if (!needsMask && children!.length > 0) {
          needsMask =
            !hasPrivacyClass && typeof maskTextClass === "string" && maskTextSelector === null
              ? false
              : _isBlockedElement(element, maskTextClass, maskTextSelector);
        }
        needsBlock =
          !hasPrivacyClass && typeof blockClass === "string" && blockSelector === null
            ? false
            : _isBlockedElement(element, blockClass, blockSelector);
      }
      topology.addCapturedNode(
        currentNode,
        parentIndex,
        (needsMask ? MASKED : 0) | (needsBlock ? BLOCKED : 0) | (inheritedFlags & SHADOW),
        liveId,
      );
      if (nodeType === 9) {
        const iframeOwner = iframeDocumentOwners.get(currentNode as Document);
        if (iframeOwner !== undefined) topologyIframeOwners.set(currentIndex, iframeOwner);
      }

      if (!needsBlock) {
        if (isCurrentElement && currentNode.nodeName === "IFRAME") {
          const iframe = currentNode as HTMLIFrameElement;
          const iframeDocument = getLoadedIframeDocument(iframe);
          if (iframeDocument !== null) {
            capturedIframeDocuments.set(iframe, iframeDocument);
            control.onIframeDocument?.(iframe, iframeDocument);
            if (control.deferIframeDocuments !== true) {
              topologyTaskNodes.push(iframeDocument);
              topologyTaskParentIndexes.push(-1);
              topologyTaskFlags.push(needsMask ? MASKED : 0);
              topologyTaskIsChildCursor.push(false);
              topologyTaskNextSiblings.push(undefined);
              iframeDocumentOwners.set(iframeDocument, iframe);
              iframeDocumentParentIndexes.set(iframeDocument, currentIndex);
            }
          }
        }

        const shadowRoot = isCurrentElement ? getTopologyShadowRoot(currentNode as Element) : null;
        if (shadowRoot !== null) {
          control.onShadowRoot?.(shadowRoot);
          const firstShadowChild = getTopologyChildNodes(shadowRoot)[0];
          if (firstShadowChild !== undefined) {
            topologyTaskNodes.push(firstShadowChild);
            topologyTaskParentIndexes.push(currentIndex);
            topologyTaskFlags.push(isNativeShadowDom(shadowRoot) ? SHADOW : 0);
            topologyTaskIsChildCursor.push(true);
            topologyTaskNextSiblings.push(getTopologyNextSibling(firstShadowChild));
          }
        }

        const firstChild = children?.[0];
        if (firstChild !== undefined) {
          topologyTaskNodes.push(firstChild);
          topologyTaskParentIndexes.push(currentIndex);
          topologyTaskFlags.push(0);
          topologyTaskIsChildCursor.push(true);
          topologyTaskNextSiblings.push(getTopologyNextSibling(firstChild));
        }
      }

      if (topologyTaskNodes.length > 0 && now() - sliceStartedAt >= timeSliceMs) {
        await yieldToMain();
        sliceStartedAt = now();
      }
    }

    const nextTopologyRevision = control.getTopologyRevision?.() ?? topologyRevision;
    if (nextTopologyRevision === topologyRevision) break;
    if (topologyRepairs >= 2) {
      // Ordered mutation catch-up is the authority after this point. Stop
      // rescanning so a continuously changing public page can still finish.
      break;
    }
    topologyRepairs += 1;
    topologyRevision = nextTopologyRevision;

    // A removed cursor can hide a later sibling from a live NodeList. When a
    // mutation happened during topology capture, rescan each captured parent
    // in slices and queue only nodes that were not visited yet.
    const repairLength = topology.length;
    for (let index = 0; index < repairLength; index += 1) {
      const currentNode = topology.getNode(index);
      const currentFlags = topology.getFlags(index);
      if ((currentFlags & BLOCKED) !== 0) continue;
      const isCurrentElement = currentNode.nodeType === currentNode.ELEMENT_NODE;
      if (isCurrentElement && currentNode.nodeName === "IFRAME") {
        const iframe = currentNode as HTMLIFrameElement;
        const iframeDocument = getLoadedIframeDocument(iframe);
        if (
          iframeDocument !== null &&
          !(options.reuseIdsFrom === undefined
            ? visitedTopologyNodes!.has(iframeDocument)
            : options.reuseIdsFrom.hasActiveReservationForCurrentGeneration(iframeDocument))
        ) {
          capturedIframeDocuments.set(iframe, iframeDocument);
          control.onIframeDocument?.(iframe, iframeDocument);
          if (control.deferIframeDocuments !== true) {
            iframeDocumentOwners.set(iframeDocument, iframe);
            iframeDocumentParentIndexes.set(iframeDocument, index);
            topologyTaskNodes.push(iframeDocument);
            topologyTaskParentIndexes.push(-1);
            topologyTaskFlags.push(currentFlags & MASKED);
            topologyTaskIsChildCursor.push(false);
            topologyTaskNextSiblings.push(undefined);
          }
        }
      }
      const shadowRoot = isCurrentElement ? getTopologyShadowRoot(currentNode as Element) : null;
      const firstShadowChild =
        shadowRoot === null ? undefined : getTopologyChildNodes(shadowRoot)[0];
      if (shadowRoot !== null) control.onShadowRoot?.(shadowRoot);
      if (firstShadowChild !== undefined) {
        topologyTaskNodes.push(firstShadowChild);
        topologyTaskParentIndexes.push(index);
        topologyTaskFlags.push(isNativeShadowDom(shadowRoot!) ? SHADOW : 0);
        topologyTaskIsChildCursor.push(true);
        topologyTaskNextSiblings.push(getTopologyNextSibling(firstShadowChild));
      }
      const firstChild =
        isCurrentElement ||
        currentNode.nodeType === currentNode.DOCUMENT_NODE ||
        currentNode.nodeType === currentNode.DOCUMENT_FRAGMENT_NODE
          ? getTopologyChildNodes(currentNode)[0]
          : undefined;
      if (firstChild !== undefined) {
        topologyTaskNodes.push(firstChild);
        topologyTaskParentIndexes.push(index);
        topologyTaskFlags.push(0);
        topologyTaskIsChildCursor.push(true);
        topologyTaskNextSiblings.push(getTopologyNextSibling(firstChild));
      }
      if (index + 1 < repairLength && now() - sliceStartedAt >= timeSliceMs) {
        await yieldToMain();
        sliceStartedAt = now();
      }
    }
  }
  if (control.afterCapturedTopology !== undefined) {
    await control.afterCapturedTopology(topology);
  } else if (!isOrangeReplaySdk && control.afterTopology !== undefined) {
    // Keep the public callback contract as normal arrays. Build them in
    // slices so an opt-in callback cannot create another long browser task.
    const capturedIds = fixedArray<number>(topology.length);
    if (topology.length > 0) await yieldToMain();
    const parentIndexes = fixedArray<number>(topology.length);
    if (topology.length > 0) await yieldToMain();
    const nextIds = fixedArray<number | null>(topology.length);
    sliceStartedAt = now();
    for (let index = 0; index < topology.length; index += 1) {
      capturedIds[index] = topology.getLiveId(index);
      parentIndexes[index] = topology.getParentIndex(index);
      nextIds[index] = topology.getNextLiveId(index);
      if (index + 1 < topology.length && now() - sliceStartedAt >= timeSliceMs) {
        await yieldToMain();
        sliceStartedAt = now();
      }
    }
    await control.afterTopology(capturedIds, parentIndexes, nextIds);
  }
  topology.releaseReconciliationValues();
  if (control.shouldStop?.() === true) return null;
  if (topology.length > 0) await yieldToMain();
  if (control.shouldStop?.() === true) return null;
  sliceStartedAt = now();

  const serializedNodes = fixedArray<serializedNodeWithId | undefined>(topology.length);
  if (topology.length > 0) await yieldToMain();
  const serializedEstimates = fixedArray<{ bytes: number } | undefined>(topology.length);
  if (control.shouldStop?.() === true) return null;
  sliceStartedAt = now();
  const iframeSnapshots: Array<{
    iframe: HTMLIFrameElement;
    document: Document;
    node: serializedElementNodeWithId;
    estimate: { bytes: number };
  }> = [];
  let rootEstimate: { bytes: number } | undefined;

  // The default class rules change only through DOM mutations, so their live
  // ancestor state can be shared by descendants. Selector rules may depend on
  // focus/hover state, so keep the uncached path for those custom options.
  const canCacheLivePrivacy =
    control.getPrivacyRevision !== undefined &&
    !blockSelector?.includes(":") &&
    !maskTextSelector?.includes(":");
  let cachedPrivacyRevision = control.getPrivacyRevision?.() ?? 0;
  let livePrivacyByElement = new WeakMap<Element, number>();
  const resetLivePrivacyCache = () => {
    cachedPrivacyRevision = control.getPrivacyRevision?.() ?? cachedPrivacyRevision;
    livePrivacyByElement = new WeakMap();
  };
  const resolveLivePrivacy = (start: Element | null, useCache: boolean): number => {
    if (useCache && control.getPrivacyRevision?.() !== cachedPrivacyRevision) {
      resetLivePrivacyCache();
    }
    let element = start;
    let privacy = 0;
    if (!useCache) {
      while (element !== null) {
        if (_isBlockedElement(element as HTMLElement, blockClass, blockSelector)) {
          privacy |= BLOCKED;
        }
        if (_isBlockedElement(element as HTMLElement, maskTextClass, maskTextSelector)) {
          privacy |= MASKED;
        }
        element = privacyParentElement(element);
      }
      return privacy;
    }

    const uncached: Element[] = [];
    while (element !== null) {
      const cached = livePrivacyByElement.get(element);
      if (cached !== undefined) {
        privacy = cached;
        break;
      }
      uncached.push(element);
      element = privacyParentElement(element);
    }
    while (uncached.length > 0) {
      const current = uncached.pop()!;
      if (_isBlockedElement(current as HTMLElement, blockClass, blockSelector)) privacy |= BLOCKED;
      if (_isBlockedElement(current as HTMLElement, maskTextClass, maskTextSelector)) {
        privacy |= MASKED;
      }
      livePrivacyByElement.set(current, privacy);
    }
    return privacy;
  };
  const capturedPrivacy = new Uint8Array(topology.length);
  const readLivePrivacy = (
    topologyIndex: number,
    capturedState: Uint8Array,
    useCache = canCacheLivePrivacy,
  ) => {
    const currentNode = topology.getNode(topologyIndex);
    const currentFlags = topology.getFlags(topologyIndex);
    let capturedParentIndex = topology.getParentIndex(topologyIndex);
    if (capturedParentIndex === -1 && currentNode.nodeType === currentNode.DOCUMENT_NODE) {
      capturedParentIndex = iframeDocumentParentIndexes.get(currentNode as Document) ?? -1;
    }
    const capturedParentPrivacy =
      capturedParentIndex === -1 ? 0 : capturedState[capturedParentIndex]!;
    let selfBlocked = (currentFlags & BLOCKED) !== 0;
    let needsMask = (currentFlags & MASKED) !== 0;
    let liveParent: Element | null;
    if (currentNode.nodeType === currentNode.ELEMENT_NODE) {
      const currentElement = currentNode as HTMLElement;
      selfBlocked ||= _isBlockedElement(currentElement, blockClass, blockSelector);
      needsMask ||= _isBlockedElement(currentElement, maskTextClass, maskTextSelector);
      liveParent = privacyParentElement(currentElement);
    } else if (currentNode.nodeType === currentNode.DOCUMENT_NODE) {
      liveParent =
        iframeDocumentOwners.get(currentNode as Document) ?? control.privacyParent ?? null;
    } else {
      liveParent = closestPrivacyElement(currentNode);
    }
    capturedState[topologyIndex] =
      capturedParentPrivacy | (selfBlocked ? BLOCKED : 0) | (needsMask ? MASKED : 0);
    const livePrivacy = resolveLivePrivacy(liveParent, useCache);
    return (
      (selfBlocked ? BLOCKED : 0) |
      ((capturedParentPrivacy & BLOCKED) !== 0 || (livePrivacy & BLOCKED) !== 0
        ? BLOCKED_BY_ANCESTOR
        : 0) |
      ((capturedState[topologyIndex]! & MASKED) !== 0 || (livePrivacy & MASKED) !== 0 ? MASKED : 0)
    );
  };

  for (let topologyIndex = 0; topologyIndex < topology.length; topologyIndex += 1) {
    if (control.shouldStop?.() === true) {
      return null;
    }

    const currentNode = topology.getNode(topologyIndex);
    let currentFlags = topology.getFlags(topologyIndex);
    const parentIndex = topology.getParentIndex(topologyIndex);
    const parentFlags =
      parentIndex === -1
        ? (options.preserveWhiteSpace ?? true)
          ? PRESERVE_WHITE_SPACE
          : 0
        : topology.getFlags(parentIndex);
    const iframeOwner = topologyIframeOwners.get(topologyIndex);
    const parentNode =
      parentIndex !== -1 && (parentFlags & RECORD_CHILDREN) !== 0
        ? (serializedNodes[parentIndex] as ParentNode | undefined)
        : undefined;
    const parentEstimate = parentIndex === -1 ? undefined : serializedEstimates[parentIndex];
    const parentIgnoreDescendants = (parentFlags & IGNORE_DESCENDANTS) !== 0;
    const parentPreserveWhiteSpace = (parentFlags & PRESERVE_WHITE_SPACE) !== 0;
    const parentCssCaptured = (parentFlags & CSS_CAPTURED) !== 0;
    if (parentIndex !== -1 && (parentFlags & RECORD_CHILDREN) === 0) {
      if (parentIgnoreDescendants) {
        options.reuseIdsFrom?.updateMeta(currentNode, {
          id: IGNORED_NODE,
        } as serializedNodeWithId);
      }
      serializedNodes[topologyIndex] = undefined;
      serializedEstimates[topologyIndex] = parentEstimate;
      if (parentIgnoreDescendants) currentFlags |= IGNORE_DESCENDANTS;
      topology.setFlags(topologyIndex, currentFlags);
      continue;
    }

    const privacy = readLivePrivacy(topologyIndex, capturedPrivacy);
    if ((privacy & BLOCKED_BY_ANCESTOR) !== 0) {
      serializedNodes[topologyIndex] = undefined;
      serializedEstimates[topologyIndex] = parentEstimate;
      continue;
    }

    const estimate = parentEstimate ?? { bytes: 0 };

    const currentDocument =
      currentNode.nodeType === currentNode.DOCUMENT_NODE
        ? (currentNode as Document)
        : (currentNode.ownerDocument ?? n);
    const currentIframe = currentNode.nodeName === "IFRAME" ? currentNode : undefined;
    const capturedIframeDocument =
      currentIframe === undefined
        ? undefined
        : capturedIframeDocuments.get(currentIframe as HTMLIFrameElement);
    const serialized = serializeNodeWithId(
      currentNode,
      {
        doc: currentDocument,
        mirror,
        reservedId: options.reuseIdsFrom?.getId(currentNode),
        blockClass,
        blockSelector,
        needsBlock: (privacy & BLOCKED) !== 0,
        maskTextClass,
        maskTextSelector,
        skipChild: true,
        needsMask: (privacy & MASKED) !== 0,
        ...(isOrangeReplaySdk
          ? {}
          : {
              inlineStylesheet,
              maskInputOptions,
              maskTextFn: options.maskTextFn,
              maskInputFn: options.maskInputFn,
              slimDOMOptions,
              dataURLOptions: options.dataURLOptions,
              inlineImages: options.inlineImages,
              deferInlineImages: options.deferInlineImages,
              recordCanvas: options.recordCanvas,
              preserveWhiteSpace: parentPreserveWhiteSpace,
              iframeLoadTimeout: options.iframeLoadTimeout,
              stylesheetLoadTimeout: options.stylesheetLoadTimeout,
              keepIframeSrcFn,
            }),
        onSerialize: options.onSerialize,
        onIframeLoad: options.onIframeLoad,
        onIframeReady: options.onIframeReady,
        onStylesheetLoad: options.onStylesheetLoad,
        cssCaptured: (currentFlags & SHADOW) !== 0 ? false : parentCssCaptured,
        newlyAddedElement: false,
        skipIframeInitialLoad:
          capturedIframeDocument !== undefined &&
          capturedIframeDocument === getLoadedIframeDocument(currentIframe as HTMLIFrameElement),
      },
      currentNode.nodeType === currentNode.TEXT_NODE
        ? parentIndex === -1
          ? null
          : topology.getNode(parentIndex)
        : undefined,
    );
    if (serialized !== null) {
      estimate.bytes += estimateSerializedNodeBytes(serialized);
      if ((currentFlags & SHADOW) !== 0) serialized.isShadow = true;
      if (parentNode === undefined) {
        if (iframeOwner !== undefined) {
          iframeSnapshots.push({
            iframe: iframeOwner,
            document: currentNode as Document,
            node: serialized as serializedElementNodeWithId,
            estimate,
          });
        } else {
          root = serialized;
          rootEstimate = estimate;
        }
      } else parentNode.childNodes.push(serialized);
    }
    const liveMirror = options.reuseIdsFrom;
    const candidateMeta = mirror.getMeta(currentNode);
    if (liveMirror !== undefined && candidateMeta !== null) {
      const liveId = liveMirror.getId(currentNode);
      if (candidateMeta.id === IGNORED_NODE) {
        liveMirror.updateMeta(currentNode, candidateMeta);
      } else if (
        !liveMirror.isRemovedNode(currentNode) &&
        (liveId === candidateMeta.id || liveId === IGNORED_NODE)
      ) {
        liveMirror.add(currentNode, candidateMeta);
      }
    }
    if (currentNode.nodeType !== currentNode.DOCUMENT_NODE) mirror.forgetNode(currentNode);

    const recordChildren =
      serialized !== null &&
      hasSnapshotChildren(serialized) &&
      (privacy & BLOCKED) === 0 &&
      shouldReadChildren(serialized);
    if (recordChildren) currentFlags |= RECORD_CHILDREN;
    if (serialized === null) currentFlags |= IGNORE_DESCENDANTS;
    const preserveWhiteSpace =
      !isOrangeReplaySdk &&
      slimDOMOptions.headWhitespace &&
      serialized?.type === NodeType.Element &&
      serialized.tagName === "head"
        ? false
        : parentPreserveWhiteSpace;
    if (preserveWhiteSpace) currentFlags |= PRESERVE_WHITE_SPACE;
    if (
      serialized?.type === NodeType.Element &&
      typeof serialized.attributes._cssText === "string"
    ) {
      currentFlags |= CSS_CAPTURED;
    }
    topology.setFlags(topologyIndex, currentFlags);
    serializedNodes[topologyIndex] = serialized ?? undefined;
    serializedEstimates[topologyIndex] = estimate;

    const activeSliceMs = now() - sliceStartedAt;
    if (topologyIndex + 1 < topology.length && activeSliceMs >= timeSliceMs) {
      await yieldToMain();
      sliceStartedAt = now();
    }
  }

  // Privacy can change after an early branch was serialized. Recheck the full
  // captured tree in slices and fail closed before any baseline is emitted.
  if (topology.length > 0) await yieldToMain();
  if (control.shouldStop?.() === true) return null;
  sliceStartedAt = now();
  resetLivePrivacyCache();
  let finalPrivacyRevision = control.getPrivacyRevision?.() ?? 0;
  let privacyRestarts = 0;
  let useFinalPrivacyCache = canCacheLivePrivacy;
  let finalCapturedPrivacy = new Uint8Array(topology.length);
  for (let topologyIndex = 0; topologyIndex < topology.length; topologyIndex += 1) {
    if (control.shouldStop?.() === true) return null;
    const serialized = serializedNodes[topologyIndex];
    if (serialized !== undefined) {
      const privacy = readLivePrivacy(topologyIndex, finalCapturedPrivacy, useFinalPrivacyCache);
      if ((privacy & (BLOCKED | BLOCKED_BY_ANCESTOR)) !== 0) {
        if (serialized.type === NodeType.Element) {
          const { width, height } = (
            topology.getNode(topologyIndex) as Element
          ).getBoundingClientRect();
          serialized.attributes = {
            class: serialized.attributes.class,
            rr_width: `${width}px`,
            rr_height: `${height}px`,
          };
          serialized.childNodes = [];
          serialized.needBlock = true;
        } else if (serialized.type === NodeType.Document) {
          serialized.childNodes = [];
        } else if (serialized.type === NodeType.Text) {
          serialized.textContent = "";
        }
      } else if (
        (privacy & MASKED) !== 0 &&
        serialized.type === NodeType.Text &&
        topology.getNode(topologyIndex).parentNode?.nodeName !== "STYLE" &&
        topology.getNode(topologyIndex).parentNode?.nodeName !== "SCRIPT"
      ) {
        serialized.textContent =
          !isOrangeReplaySdk && options.maskTextFn
            ? options.maskTextFn(
                serialized.textContent,
                closestPrivacyElement(topology.getNode(topologyIndex)) as HTMLElement | null,
              )
            : serialized.textContent.replace(/[\S]/g, "*");
      }
    }
    if (topologyIndex + 1 < topology.length && now() - sliceStartedAt >= timeSliceMs) {
      await yieldToMain();
      sliceStartedAt = now();
      const nextPrivacyRevision = control.getPrivacyRevision?.() ?? finalPrivacyRevision;
      if (nextPrivacyRevision !== finalPrivacyRevision) {
        if (privacyRestarts >= 2) {
          control.onSnapshotUnstable?.();
          return null;
        }
        privacyRestarts += 1;
        finalPrivacyRevision = nextPrivacyRevision;
        if (privacyRestarts === 2) useFinalPrivacyCache = false;
        finalCapturedPrivacy = new Uint8Array(topology.length);
        resetLivePrivacyCache();
        topologyIndex = -1;
      }
    }
  }

  const privacyChangedAfterFinalPass = () =>
    (control.getPrivacyRevision?.() ?? finalPrivacyRevision) !== finalPrivacyRevision;
  for (let index = 0; index < iframeSnapshots.length; index += 1) {
    const iframeSnapshot = iframeSnapshots[index]!;
    if (
      iframeSnapshot.document === getLoadedIframeDocument(iframeSnapshot.iframe) &&
      !matchesPrivacyTree(iframeSnapshot.iframe, blockClass, blockSelector)
    ) {
      snapshotEstimatedBytes.set(iframeSnapshot.node, iframeSnapshot.estimate.bytes);
      options.onIframeLoad?.(iframeSnapshot.iframe, iframeSnapshot.node, iframeSnapshot.document);
    }
    if ((index + 1) % 64 === 0 || now() - sliceStartedAt >= timeSliceMs) {
      await yieldToMain();
      sliceStartedAt = now();
      if (control.shouldStop?.() === true) return null;
      if (privacyChangedAfterFinalPass()) {
        control.onSnapshotUnstable?.();
        return null;
      }
    }
  }
  if (privacyChangedAfterFinalPass()) {
    control.onSnapshotUnstable?.();
    return null;
  }

  if (root !== null && rootEstimate !== undefined) {
    snapshotEstimatedBytes.set(root, rootEstimate.bytes);
  }

  return root;
}

function resolveMaskInputOptions(maskAllInputs: boolean | MaskInputOptions): MaskInputOptions {
  if (isOrangeReplaySdk) return {};
  if (maskAllInputs !== true) {
    return maskAllInputs === false ? { password: true } : maskAllInputs;
  }

  return {
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
  };
}

function hasSnapshotChildren(
  node: serializedNodeWithId,
): node is serializedNodeWithId & { childNodes: serializedNodeWithId[] } {
  return node.type === NodeType.Document || node.type === NodeType.Element;
}

function shouldReadChildren(
  serialized: serializedNodeWithId & { childNodes: serializedNodeWithId[] },
): boolean {
  if (serialized.type !== NodeType.Element) return true;
  return !(serialized.tagName === "textarea" && serialized.attributes.value !== undefined);
}

function cleanTimeSlice(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 4;
}

export function yieldForPaint(win: Window | null | undefined): Promise<void> {
  if (win === null || win === undefined || typeof win.requestAnimationFrame !== "function") {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  return new Promise((resolve) => {
    let settled = false;
    let frameId = 0;
    let timeoutId = 0;
    const finish = () => {
      if (settled) return;
      settled = true;
      win.cancelAnimationFrame(frameId);
      win.clearTimeout(timeoutId);
      resolve();
    };
    frameId = win.requestAnimationFrame(finish);
    // requestAnimationFrame pauses in hidden tabs. Keep recording there, but
    // favor a real paint whenever the page is visible.
    timeoutId = win.setTimeout(finish, 50);
  });
}

export function visitSnapshot(
  node: serializedNodeWithId,
  onVisit: (node: serializedNodeWithId) => unknown,
) {
  function walk(current: serializedNodeWithId) {
    onVisit(current);
    if (current.type === NodeType.Document || current.type === NodeType.Element) {
      current.childNodes.forEach(walk);
    }
  }

  walk(node);
}

export function cleanupSnapshot() {
  // allow a new recording to start numbering nodes from scratch
  _id = 1;
}

export default snapshot;
