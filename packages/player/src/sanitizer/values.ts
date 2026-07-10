import {
  isSafeInlineReplayUrl,
  sanitizeReplayCss,
  type ReplayCssContext,
  type ReplayCssResourceKind,
  type ReplayCssUrlRewriter,
} from "../css.ts";

export const URL_ATTRIBUTE_NAMES = new Set([
  "action",
  "background",
  "cite",
  "data",
  "formaction",
  "href",
  "imagesrcset",
  "dataurl",
  "longdesc",
  "manifest",
  "ping",
  "poster",
  "profile",
  "rr_dataurl",
  "rr_src",
  "rrweb-original-src",
  "rrweb-original-srcset",
  "src",
  "srcdoc",
  "srcset",
  "xlink:href",
]);
export const URL_FIELD_NAMES = new Set([...URL_ATTRIBUTE_NAMES].filter((name) => name !== "data"));
export const CSS_ATTRIBUTE_NAMES = new Set(["style", "csstext", "_csstext"]);
export const CSS_PRESENTATION_ATTRIBUTE_NAMES = new Set([
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
export const CSS_TEXT_FIELD_NAMES = new Set(["_csstext", "rule", "replace", "replacesync"]);
export const BLOCKED_STRING_FIELD_NAMES = new Set(["fontsource"]);
export const SVG_ANIMATION_ATTRIBUTE_NAMES = new Set([
  "attributename",
  "begin",
  "by",
  "dur",
  "from",
  "keypoints",
  "keytimes",
  "path",
  "repeatcount",
  "to",
  "values",
]);

const MAX_CAPTURED_FONT_BYTES = 512 * 1024;
const MAX_CAPTURED_FONT_JSON_CHARS = MAX_CAPTURED_FONT_BYTES * 4 + 2;

export interface ReplaySanitizerOptions {
  rewriteCss?: (css: string, context: ReplayCssContext) => string;
  rewriteUrl?: ReplayCssUrlRewriter;
}

export function sanitizeCapturedFontSource(
  value: unknown,
  parent: Record<string, unknown>,
): string {
  if (parent["buffer"] !== true || typeof value !== "string") {
    return "";
  }

  if (
    value.length < 3 ||
    value.length > MAX_CAPTURED_FONT_JSON_CHARS ||
    !value.startsWith("[") ||
    !value.endsWith("]")
  ) {
    return "";
  }

  try {
    const bytes = JSON.parse(value) as unknown;
    if (!Array.isArray(bytes) || bytes.length === 0 || bytes.length > MAX_CAPTURED_FONT_BYTES) {
      return "";
    }

    for (const byte of bytes) {
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
        return "";
      }
    }

    return value;
  } catch {
    return "";
  }
}

export function isStyleDeclarationRecord(value: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(value, "property");
}

export function sanitizeCssValue(
  value: unknown,
  context: ReplayCssContext,
  options: ReplaySanitizerOptions,
): unknown {
  if (typeof value === "string") {
    return sanitizeCssText(value, context, options);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeCssValue(item, context, options));
  }

  if (!isPlainRecord(value)) {
    return value;
  }

  const sanitized = makeSafeRecord();
  for (const [key, item] of Object.entries(value)) {
    sanitized[key] = sanitizeCssValue(
      item,
      context === "declarationList" ? "value" : context,
      options,
    );
  }
  return sanitized;
}

export function sanitizeCssText(
  value: string,
  context: ReplayCssContext,
  options: ReplaySanitizerOptions,
): string {
  return (
    options.rewriteCss?.(value, context) ?? sanitizeReplayCss(value, context, options.rewriteUrl)
  );
}

export function sanitizeUrlString(
  value: unknown,
  kind: ReplayCssResourceKind,
  options: ReplaySanitizerOptions,
): string {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = value.trim();
  if (normalized.startsWith("#") || isSafeInlineReplayUrl(normalized, kind)) {
    return normalized;
  }

  const rewritten = options.rewriteUrl?.(normalized, kind)?.trim();
  if (rewritten === undefined || rewritten.length === 0) {
    return "";
  }

  return rewritten.startsWith("blob:") || isSafeInlineReplayUrl(rewritten, kind) ? rewritten : "";
}

export function resourceKindForAttribute(
  tagName: string | undefined,
  attributeName: string,
  attributes: Record<string, unknown>,
): ReplayCssResourceKind | undefined {
  if (
    tagName === "link" &&
    attributeName === "href" &&
    normalizeAttributeString(readAttributeValue(attributes, "rel")) === "stylesheet"
  ) {
    return "stylesheet";
  }

  if (
    attributeName === "background" ||
    attributeName === "poster" ||
    attributeName === "rr_dataurl" ||
    attributeName === "dataurl"
  ) {
    return "image";
  }

  if (
    (tagName === "img" || tagName === "image" || tagName === "input") &&
    (attributeName === "src" || attributeName === "rr_src")
  ) {
    return "image";
  }

  return undefined;
}

export function readAttributeValue(attributes: Record<string, unknown>, name: string): unknown {
  for (const [key, value] of Object.entries(attributes)) {
    if (key.toLowerCase() === name) {
      return value;
    }
  }

  return undefined;
}

export function normalizeAttributeString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function makeSafeRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}
