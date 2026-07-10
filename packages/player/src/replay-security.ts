import { isSafeInlineReplayUrl, sanitizeReplayCss } from "./css.ts";

export const REPLAY_FRAME_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "font-src data: blob:",
  "form-action 'none'",
  "frame-src 'none'",
  "img-src data: blob:",
  "media-src data: blob:",
  "object-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline' blob:",
  "worker-src 'none'",
].join("; ");

const POLICY_MARKER = "data-orange-replay-policy";
const FIREWALL_MARKER = "__orangeReplayResourceFirewall";
const CSS_VALUE_PROPERTIES = [
  "background",
  "backgroundImage",
  "borderImage",
  "content",
  "cursor",
  "filter",
  "listStyle",
  "listStyleImage",
  "mask",
  "maskImage",
  "offsetPath",
  "shapeOutside",
] as const;
const CSS_PRESENTATION_ATTRIBUTES = new Set([
  "clip-path",
  "color-profile",
  "cursor",
  "fill",
  "filter",
  "marker",
  "marker-end",
  "marker-mid",
  "marker-start",
  "mask",
  "mask-border-source",
  "mask-image",
  "stroke",
]);
const NETWORK_ATTRIBUTES = new Set([
  "action",
  "background",
  "cite",
  "data",
  "formaction",
  "href",
  "imagesrcset",
  "longdesc",
  "manifest",
  "ping",
  "poster",
  "profile",
  "src",
  "srcdoc",
  "srcset",
  "xlink:href",
]);

export function installReplayFramePolicy(iframe: HTMLIFrameElement): boolean {
  iframe.setAttribute("sandbox", "allow-same-origin");
  iframe.referrerPolicy = "no-referrer";

  const document = iframe.contentDocument;
  const head = document?.head;
  if (document === null || document === undefined || head === null || head === undefined) {
    return false;
  }

  if (!installReplayResourceFirewall(iframe)) {
    return false;
  }

  const existing = head.querySelector(`meta[${POLICY_MARKER}]`);
  if (existing !== null) {
    return existing.getAttribute("content") === REPLAY_FRAME_CSP;
  }

  const policy = document.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  policy.content = REPLAY_FRAME_CSP;
  policy.setAttribute(POLICY_MARKER, "true");
  head.prepend(policy);

  return head.firstElementChild === policy;
}

function installReplayResourceFirewall(iframe: HTMLIFrameElement): boolean {
  const frameWindow = iframe.contentWindow as ReplayFrameWindow | null;
  if (frameWindow === null) {
    return false;
  }
  if (frameWindow[FIREWALL_MARKER] === true) {
    return true;
  }

  try {
    patchSetAttribute(frameWindow);
    patchStyleDeclarations(frameWindow);
    patchStyleSheets(frameWindow);
    patchResourceProperties(frameWindow);
    frameWindow[FIREWALL_MARKER] = true;
    return true;
  } catch {
    return false;
  }
}

interface ReplayFrameWindow extends Window {
  [FIREWALL_MARKER]?: boolean;
  Element: typeof Element;
  CSSStyleDeclaration: typeof CSSStyleDeclaration;
  CSSStyleSheet: typeof CSSStyleSheet;
  HTMLImageElement: typeof HTMLImageElement;
  HTMLIFrameElement: typeof HTMLIFrameElement;
  HTMLLinkElement: typeof HTMLLinkElement;
  HTMLMediaElement: typeof HTMLMediaElement;
  HTMLObjectElement: typeof HTMLObjectElement;
  HTMLScriptElement: typeof HTMLScriptElement;
  HTMLSourceElement: typeof HTMLSourceElement;
  HTMLVideoElement: typeof HTMLVideoElement;
}

function patchSetAttribute(frameWindow: ReplayFrameWindow): void {
  const prototype = frameWindow.Element.prototype;
  const setAttribute = readOwnMethod<Element["setAttribute"]>(prototype, "setAttribute");
  const setAttributeNS = readOwnMethod<Element["setAttributeNS"]>(prototype, "setAttributeNS");

  Object.defineProperty(prototype, "setAttribute", {
    configurable: true,
    writable: true,
    value(this: Element, name: string, value: string) {
      const sanitized = sanitizeReplayDomAttribute(this, name, String(value));
      if (sanitized !== undefined) {
        setAttribute.call(this, name, sanitized);
      }
    },
  });

  Object.defineProperty(prototype, "setAttributeNS", {
    configurable: true,
    writable: true,
    value(this: Element, namespace: string | null, name: string, value: string) {
      const sanitized = sanitizeReplayDomAttribute(this, name, String(value));
      if (sanitized !== undefined) {
        setAttributeNS.call(this, namespace, name, sanitized);
      }
    },
  });
}

function patchStyleDeclarations(frameWindow: ReplayFrameWindow): void {
  const prototype = frameWindow.CSSStyleDeclaration.prototype;
  const setProperty = readOwnMethod<CSSStyleDeclaration["setProperty"]>(prototype, "setProperty");
  Object.defineProperty(prototype, "setProperty", {
    configurable: true,
    writable: true,
    value(this: CSSStyleDeclaration, property: string, value: string | null, priority?: string) {
      return setProperty.call(
        this,
        property,
        sanitizeReplayCss(value ?? "", "value"),
        priority ?? "",
      );
    },
  });

  for (const property of CSS_VALUE_PROPERTIES) {
    const entry = findPropertyDescriptor(prototype, property);
    if (entry?.descriptor.set === undefined) {
      continue;
    }
    const { descriptor, owner } = entry;
    Object.defineProperty(owner, property, {
      ...entry.descriptor,
      set(this: CSSStyleDeclaration, value: string) {
        descriptor.set?.call(this, sanitizeReplayCss(String(value), "value"));
      },
    });
  }
}

function patchStyleSheets(frameWindow: ReplayFrameWindow): void {
  const prototype = frameWindow.CSSStyleSheet.prototype;
  const insertRule = readOwnMethod<CSSStyleSheet["insertRule"]>(prototype, "insertRule");
  Object.defineProperty(prototype, "insertRule", {
    configurable: true,
    writable: true,
    value(this: CSSStyleSheet, rule: string, index?: number) {
      return insertRule.call(this, sanitizeReplayCss(rule, "stylesheet"), index);
    },
  });

  const replaceValue = Object.getOwnPropertyDescriptor(prototype, "replace")?.value;
  if (typeof replaceValue === "function") {
    const replace = replaceValue as CSSStyleSheet["replace"];
    Object.defineProperty(prototype, "replace", {
      configurable: true,
      writable: true,
      value(this: CSSStyleSheet, css: string) {
        return replace.call(this, sanitizeReplayCss(css, "stylesheet"));
      },
    });
  }

  const replaceSyncValue = Object.getOwnPropertyDescriptor(prototype, "replaceSync")?.value;
  if (typeof replaceSyncValue === "function") {
    const replaceSync = replaceSyncValue as CSSStyleSheet["replaceSync"];
    Object.defineProperty(prototype, "replaceSync", {
      configurable: true,
      writable: true,
      value(this: CSSStyleSheet, css: string) {
        return replaceSync.call(this, sanitizeReplayCss(css, "stylesheet"));
      },
    });
  }
}

function patchResourceProperties(frameWindow: ReplayFrameWindow): void {
  const properties: Array<[object, string, "image" | "blocked"]> = [
    [frameWindow.HTMLImageElement.prototype, "src", "image"],
    [frameWindow.HTMLImageElement.prototype, "srcset", "blocked"],
    [frameWindow.HTMLIFrameElement.prototype, "src", "blocked"],
    [frameWindow.HTMLIFrameElement.prototype, "srcdoc", "blocked"],
    [frameWindow.HTMLLinkElement.prototype, "href", "blocked"],
    [frameWindow.HTMLMediaElement.prototype, "src", "blocked"],
    [frameWindow.HTMLObjectElement.prototype, "data", "blocked"],
    [frameWindow.HTMLScriptElement.prototype, "src", "blocked"],
    [frameWindow.HTMLSourceElement.prototype, "src", "image"],
    [frameWindow.HTMLSourceElement.prototype, "srcset", "blocked"],
    [frameWindow.HTMLVideoElement.prototype, "poster", "image"],
  ];

  for (const [prototype, property, kind] of properties) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
    if (descriptor?.set === undefined) {
      continue;
    }
    Object.defineProperty(prototype, property, {
      ...descriptor,
      set(this: object, value: string) {
        const normalized = String(value).trim();
        if (
          normalized.startsWith("#") ||
          (kind === "image" &&
            (normalized.startsWith("blob:") || isSafeInlineReplayUrl(normalized, "image")))
        ) {
          descriptor.set?.call(this, normalized);
        }
      },
    });
  }
}

function sanitizeReplayDomAttribute(
  element: Element,
  name: string,
  value: string,
): string | undefined {
  const attribute = name.toLowerCase();
  const tagName = element.tagName.toLowerCase();
  if (attribute.startsWith("on")) {
    return undefined;
  }
  if (attribute === "style") {
    return sanitizeReplayCss(value, "declarationList");
  }
  if (CSS_PRESENTATION_ATTRIBUTES.has(attribute)) {
    return sanitizeReplayCss(value, "value");
  }
  if (!NETWORK_ATTRIBUTES.has(attribute)) {
    return value;
  }

  const normalized = value.trim();
  if (normalized.startsWith("#")) {
    return normalized;
  }
  const isImage =
    attribute === "background" ||
    attribute === "poster" ||
    ((tagName === "img" || tagName === "image" || tagName === "source") && attribute === "src");
  if (isImage && (normalized.startsWith("blob:") || isSafeInlineReplayUrl(normalized, "image"))) {
    return normalized;
  }
  if (
    tagName === "link" &&
    attribute === "href" &&
    element.getAttribute("rel")?.toLowerCase() === "stylesheet" &&
    normalized.startsWith("blob:")
  ) {
    return normalized;
  }

  return undefined;
}

function readOwnMethod<T>(target: object, name: string): T {
  const value = Reflect.get(target, name) as unknown;
  if (typeof value !== "function") {
    throw new Error(`Replay frame is missing ${name}.`);
  }
  return value as T;
}

function findPropertyDescriptor(
  target: object,
  name: string,
): { owner: object; descriptor: PropertyDescriptor } | undefined {
  let owner: object | null = target;
  while (owner !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (descriptor !== undefined) {
      return { owner, descriptor };
    }
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  return undefined;
}
