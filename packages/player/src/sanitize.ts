import type { ReplayEvent } from "./types.ts";

const URL_ATTRIBUTE_NAMES = new Set([
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
const URL_FIELD_NAMES = new Set([...URL_ATTRIBUTE_NAMES].filter((name) => name !== "data"));
const CSS_ATTRIBUTE_NAMES = new Set(["style", "csstext", "_csstext"]);
const CSS_PRESENTATION_ATTRIBUTE_NAMES = new Set([
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
const CSS_TEXT_FIELD_NAMES = new Set(["_csstext", "rule", "replace", "replacesync"]);
const BLOCKED_STRING_FIELD_NAMES = new Set(["fontsource"]);
const CANVAS_MUTATION_SOURCE = 9;
const SCRIPT_TAG_NAME = "script";
const STYLE_TAG_NAME = "style";
const SVG_ANIMATION_TAG_NAMES = new Set(["animate", "animatemotion", "animatetransform", "set"]);
const SVG_ANIMATION_ATTRIBUTE_NAMES = new Set([
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

export type ReplaySanitizerState = {
  metaNodeIds: Set<number>;
  nodeTagNames: Map<number, string>;
  safeTextNodeIds: Set<number>;
  scriptNodeIds: Set<number>;
  scriptTextNodeIds: Set<number>;
  svgAnimationNodeIds: Set<number>;
  styleNodeIds: Set<number>;
  styleTextNodeIds: Set<number>;
};

export function createReplaySanitizerState(): ReplaySanitizerState {
  return {
    metaNodeIds: new Set(),
    nodeTagNames: new Map(),
    safeTextNodeIds: new Set(),
    scriptNodeIds: new Set(),
    scriptTextNodeIds: new Set(),
    svgAnimationNodeIds: new Set(),
    styleNodeIds: new Set(),
    styleTextNodeIds: new Set(),
  };
}

export function clearReplaySanitizerState(state: ReplaySanitizerState): void {
  state.metaNodeIds.clear();
  state.nodeTagNames.clear();
  state.safeTextNodeIds.clear();
  state.scriptNodeIds.clear();
  state.scriptTextNodeIds.clear();
  state.svgAnimationNodeIds.clear();
  state.styleNodeIds.clear();
  state.styleTextNodeIds.clear();
}

export function sanitizeReplayEvents(
  events: readonly ReplayEvent[],
  state: ReplaySanitizerState = createReplaySanitizerState(),
): ReplayEvent[] {
  const sanitizedEvents: ReplayEvent[] = [];
  for (const event of events) {
    if (isUnsupportedCanvasMutation(event)) {
      continue;
    }

    sanitizedEvents.push(sanitizeUnknown(event, state) as ReplayEvent);
  }
  return sanitizedEvents;
}

function sanitizeUnknown(
  value: unknown,
  state: ReplaySanitizerState,
  parentTagName?: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUnknown(item, state, parentTagName));
  }

  if (!isPlainRecord(value)) {
    return value;
  }

  const parentId = readNumber(value["parentId"]);
  const parentTagFromId = parentId === undefined ? undefined : state.nodeTagNames.get(parentId);
  const numericId = readNumber(value["id"]);
  const tagFromId = numericId === undefined ? undefined : state.nodeTagNames.get(numericId);
  const nodeType = readNumber(value["type"]);
  const parentIsStyle =
    parentTagName === STYLE_TAG_NAME ||
    parentTagFromId === STYLE_TAG_NAME ||
    (parentId !== undefined && state.styleNodeIds.has(parentId));
  const parentIsScript =
    parentTagName === SCRIPT_TAG_NAME ||
    parentTagFromId === SCRIPT_TAG_NAME ||
    (parentId !== undefined && state.scriptNodeIds.has(parentId));
  const selfTagName = readTagName(value);
  const inheritedTextTagName = parentIsStyle
    ? STYLE_TAG_NAME
    : parentIsScript
      ? SCRIPT_TAG_NAME
      : (parentTagName ?? parentTagFromId);
  const currentTagName =
    nodeType === 3
      ? (inheritedTextTagName ?? tagFromId)
      : (selfTagName ?? tagFromId ?? parentTagName ?? parentTagFromId);
  rememberNodeState(state, numericId, nodeType, selfTagName, currentTagName);
  const sanitized = makeSafeRecord();

  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();

    if (key === "attributes" && isPlainRecord(item)) {
      sanitized[key] = sanitizeAttributes(item, state, currentTagName, numericId);
      continue;
    }

    if (key === "tagName" && nodeType === 3) {
      continue;
    }

    if (key === "tagName" && currentTagName === SCRIPT_TAG_NAME) {
      sanitized[key] = "noscript";
      continue;
    }

    if (key === "childNodes" && Array.isArray(item)) {
      sanitized[key] = item.map((child) => sanitizeUnknown(child, state, currentTagName));
      continue;
    }

    if (key === "texts" && Array.isArray(item)) {
      sanitized[key] = item.map((text) => sanitizeTextMutation(text, state));
      continue;
    }

    if (key === "textContent" && shouldBlankTextNode(value, state)) {
      sanitized[key] = "";
      continue;
    }

    if (key === "value" && currentTagName === STYLE_TAG_NAME) {
      sanitized[key] = "";
      continue;
    }

    if (key === "value" && currentTagName === SCRIPT_TAG_NAME) {
      sanitized[key] = "";
      continue;
    }

    if (URL_FIELD_NAMES.has(normalizedKey)) {
      sanitized[key] = "";
      continue;
    }

    if (CSS_TEXT_FIELD_NAMES.has(normalizedKey)) {
      sanitized[key] = "";
      continue;
    }

    if (BLOCKED_STRING_FIELD_NAMES.has(normalizedKey)) {
      sanitized[key] = "";
      continue;
    }

    if (isStyleDeclarationRecord(value)) {
      if (key === "property" && typeof item !== "string") {
        sanitized[key] = "";
        continue;
      }
      if (key === "value" || key === "priority") {
        sanitized[key] = "";
        continue;
      }
    }

    if (key === "node") {
      sanitized[key] = sanitizeUnknown(
        item,
        state,
        parentIsStyle ? STYLE_TAG_NAME : parentIsScript ? SCRIPT_TAG_NAME : currentTagName,
      );
      continue;
    }

    sanitized[key] = sanitizeUnknown(item, state);
  }

  return sanitized;
}

function isUnsupportedCanvasMutation(event: ReplayEvent): boolean {
  if (!isPlainRecord(event.data)) {
    return false;
  }

  return readNumber(event.data["source"]) === CANVAS_MUTATION_SOURCE;
}

function isStyleDeclarationRecord(value: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(value, "property");
}

function sanitizeTextMutation(value: unknown, state: ReplaySanitizerState): unknown {
  if (!isPlainRecord(value)) {
    return sanitizeUnknown(value, state);
  }

  const textNodeId = readNumber(value["id"]);
  const shouldBlank =
    textNodeId === undefined ||
    state.scriptTextNodeIds.has(textNodeId) ||
    state.styleTextNodeIds.has(textNodeId) ||
    !state.safeTextNodeIds.has(textNodeId);
  const sanitized = makeSafeRecord();

  for (const [key, item] of Object.entries(value)) {
    if (key === "value" && shouldBlank) {
      sanitized[key] = "";
      continue;
    }

    sanitized[key] = sanitizeUnknown(item, state);
  }

  return sanitized;
}

function rememberNodeState(
  state: ReplaySanitizerState,
  nodeId: number | undefined,
  nodeType: number | undefined,
  tagName: string | undefined,
  currentTagName: string | undefined,
): void {
  if (nodeId === undefined) {
    return;
  }

  if (tagName !== undefined && nodeType !== 3) {
    state.nodeTagNames.set(nodeId, tagName);
    if (tagName === STYLE_TAG_NAME) {
      state.styleNodeIds.add(nodeId);
    }
    if (tagName === SCRIPT_TAG_NAME) {
      state.scriptNodeIds.add(nodeId);
    }
    if (tagName === "meta") {
      state.metaNodeIds.add(nodeId);
    }
    if (SVG_ANIMATION_TAG_NAMES.has(tagName)) {
      state.svgAnimationNodeIds.add(nodeId);
    }
  }

  if (nodeType !== 3) {
    return;
  }

  if (currentTagName === STYLE_TAG_NAME) {
    state.safeTextNodeIds.delete(nodeId);
    state.styleTextNodeIds.add(nodeId);
    return;
  }

  if (currentTagName === SCRIPT_TAG_NAME) {
    state.safeTextNodeIds.delete(nodeId);
    state.scriptTextNodeIds.add(nodeId);
    return;
  }

  if (
    currentTagName !== undefined &&
    !state.scriptTextNodeIds.has(nodeId) &&
    !state.styleTextNodeIds.has(nodeId)
  ) {
    state.safeTextNodeIds.add(nodeId);
  }
}

function shouldBlankTextNode(value: Record<string, unknown>, state: ReplaySanitizerState): boolean {
  const tagName = readTagName(value);
  if (tagName === STYLE_TAG_NAME) {
    return true;
  }

  if (tagName === SCRIPT_TAG_NAME) {
    return true;
  }

  const nodeType = readNumber(value["type"]);
  if (nodeType !== 3) {
    return false;
  }

  const textNodeId = readNumber(value["id"]);
  return (
    textNodeId === undefined ||
    state.scriptTextNodeIds.has(textNodeId) ||
    state.styleTextNodeIds.has(textNodeId) ||
    !state.safeTextNodeIds.has(textNodeId)
  );
}

function sanitizeAttributes(
  attributes: Record<string, unknown>,
  state: ReplaySanitizerState,
  tagName: string | undefined,
  nodeId: number | undefined,
): Record<string, unknown> {
  const sanitized = makeSafeRecord();
  const httpEquivValue = readAttributeValue(attributes, "http-equiv");
  const httpEquiv = normalizeAttributeString(httpEquivValue);
  const isMeta = tagName === "meta" || (nodeId !== undefined && state.metaNodeIds.has(nodeId));
  const isScript =
    tagName === SCRIPT_TAG_NAME || (nodeId !== undefined && state.scriptNodeIds.has(nodeId));
  const shouldBlankMetaContent =
    isMeta ||
    httpEquiv === "refresh" ||
    (httpEquivValue !== undefined && typeof httpEquivValue !== "string");
  const isSvgAnimation =
    (tagName !== undefined && SVG_ANIMATION_TAG_NAMES.has(tagName)) ||
    (nodeId !== undefined && state.svgAnimationNodeIds.has(nodeId));

  if (isScript) {
    return sanitized;
  }

  if (nodeId !== undefined) {
    if (isMeta) {
      state.metaNodeIds.add(nodeId);
    }
    if (isSvgAnimation) {
      state.svgAnimationNodeIds.add(nodeId);
    }
  }

  for (const [key, value] of Object.entries(attributes)) {
    const normalizedKey = key.toLowerCase();

    if (isSvgAnimation && SVG_ANIMATION_ATTRIBUTE_NAMES.has(normalizedKey)) {
      sanitized[key] = "";
      continue;
    }

    if (URL_ATTRIBUTE_NAMES.has(normalizedKey) || normalizedKey.startsWith("on")) {
      sanitized[key] = "";
      continue;
    }

    if (normalizedKey === "content" && shouldBlankMetaContent) {
      sanitized[key] = "";
      continue;
    }

    if (
      CSS_ATTRIBUTE_NAMES.has(normalizedKey) ||
      CSS_PRESENTATION_ATTRIBUTE_NAMES.has(normalizedKey)
    ) {
      sanitized[key] = sanitizeCssValue(value);
      continue;
    }

    sanitized[key] = sanitizeUnknown(value, state);
  }

  return sanitized;
}

function readAttributeValue(attributes: Record<string, unknown>, name: string): unknown {
  for (const [key, value] of Object.entries(attributes)) {
    if (key.toLowerCase() === name) {
      return value;
    }
  }

  return undefined;
}

function normalizeAttributeString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

function readTagName(value: Record<string, unknown>): string | undefined {
  const tagName = value["tagName"];
  return typeof tagName === "string" ? tagName.toLowerCase() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sanitizeCssValue(value: unknown): unknown {
  if (typeof value === "string") {
    return "";
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeCssValue(item));
  }

  if (!isPlainRecord(value)) {
    return value;
  }

  const sanitized = makeSafeRecord();
  for (const [key, item] of Object.entries(value)) {
    sanitized[key] = sanitizeCssValue(item);
  }
  return sanitized;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function makeSafeRecord(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}
