import type { ReplayEvent } from "../types.ts";
import { sanitizeCanvasFrameMutation } from "./canvas.ts";
import {
  SCRIPT_TAG_NAME,
  STYLE_TAG_NAME,
  SVG_ANIMATION_TAG_NAMES,
  createReplaySanitizerState,
  isStyleTextValue,
  readNumber,
  readTagName,
  rememberNodeState,
  shouldBlankTextNode,
  type ReplaySanitizerState,
} from "./state.ts";
import {
  BLOCKED_STRING_FIELD_NAMES,
  CSS_ATTRIBUTE_NAMES,
  CSS_PRESENTATION_ATTRIBUTE_NAMES,
  CSS_TEXT_FIELD_NAMES,
  SVG_ANIMATION_ATTRIBUTE_NAMES,
  URL_ATTRIBUTE_NAMES,
  URL_FIELD_NAMES,
  isPlainRecord,
  isStyleDeclarationRecord,
  makeSafeRecord,
  normalizeAttributeString,
  readAttributeValue,
  resourceKindForAttribute,
  sanitizeCapturedFontSource,
  sanitizeCssText,
  sanitizeCssValue,
  sanitizeUrlString,
  type ReplaySanitizerOptions,
} from "./values.ts";

export function sanitizeReplayEvents(
  events: readonly ReplayEvent[],
  state: ReplaySanitizerState = createReplaySanitizerState(),
  options: ReplaySanitizerOptions = {},
): ReplayEvent[] {
  const sanitizedEvents: ReplayEvent[] = [];
  for (const event of events) {
    const canvasEvent = sanitizeCanvasFrameMutation(event);
    if (canvasEvent === null) {
      continue;
    }
    if (canvasEvent !== undefined) {
      sanitizedEvents.push(canvasEvent);
      continue;
    }

    sanitizedEvents.push(sanitizeUnknown(event, state, options) as ReplayEvent);
  }
  return sanitizedEvents;
}

function sanitizeUnknown(
  value: unknown,
  state: ReplaySanitizerState,
  options: ReplaySanitizerOptions,
  parentTagName?: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUnknown(item, state, options, parentTagName));
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
      sanitized[key] = sanitizeAttributes(item, state, options, currentTagName, numericId);
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
      sanitized[key] = item.map((child) => sanitizeUnknown(child, state, options, currentTagName));
      continue;
    }

    if (key === "texts" && Array.isArray(item)) {
      sanitized[key] = item.map((text) => sanitizeTextMutation(text, state, options));
      continue;
    }

    if (
      key === "textContent" &&
      (currentTagName === STYLE_TAG_NAME || isStyleTextValue(value, state)) &&
      typeof item === "string"
    ) {
      sanitized[key] = sanitizeCssText(item, "stylesheet", options);
      continue;
    }

    if (key === "textContent" && shouldBlankTextNode(value, state)) {
      sanitized[key] = "";
      continue;
    }

    if (key === "value" && currentTagName === STYLE_TAG_NAME) {
      sanitized[key] = typeof item === "string" ? sanitizeCssText(item, "stylesheet", options) : "";
      continue;
    }

    if (key === "value" && currentTagName === SCRIPT_TAG_NAME) {
      sanitized[key] = "";
      continue;
    }

    if (URL_FIELD_NAMES.has(normalizedKey)) {
      sanitized[key] = sanitizeUrlString(item, "image", options);
      continue;
    }

    if (CSS_TEXT_FIELD_NAMES.has(normalizedKey)) {
      sanitized[key] = sanitizeCssValue(item, "stylesheet", options);
      continue;
    }

    if (BLOCKED_STRING_FIELD_NAMES.has(normalizedKey)) {
      sanitized[key] =
        normalizedKey === "fontsource" ? sanitizeCapturedFontSource(item, value) : "";
      continue;
    }

    if (isStyleDeclarationRecord(value)) {
      if (key === "property" && typeof item !== "string") {
        sanitized[key] = "";
        continue;
      }
      if (key === "value") {
        sanitized[key] = sanitizeCssValue(item, "value", options);
        continue;
      }
      if (key === "priority") {
        sanitized[key] = typeof item === "string" ? item : "";
        continue;
      }
    }

    if (key === "node") {
      sanitized[key] = sanitizeUnknown(
        item,
        state,
        options,
        parentIsStyle ? STYLE_TAG_NAME : parentIsScript ? SCRIPT_TAG_NAME : currentTagName,
      );
      continue;
    }

    sanitized[key] = sanitizeUnknown(item, state, options);
  }

  return sanitized;
}

function sanitizeTextMutation(
  value: unknown,
  state: ReplaySanitizerState,
  options: ReplaySanitizerOptions,
): unknown {
  if (!isPlainRecord(value)) {
    return sanitizeUnknown(value, state, options);
  }

  const textNodeId = readNumber(value["id"]);
  const isStyleText = textNodeId !== undefined && state.styleTextNodeIds.has(textNodeId);
  const shouldBlank =
    textNodeId === undefined ||
    state.scriptTextNodeIds.has(textNodeId) ||
    !state.safeTextNodeIds.has(textNodeId);
  const sanitized = makeSafeRecord();

  for (const [key, item] of Object.entries(value)) {
    if (key === "value" && isStyleText && typeof item === "string") {
      sanitized[key] = sanitizeCssText(item, "stylesheet", options);
      continue;
    }

    if (key === "value" && (shouldBlank || isStyleText)) {
      sanitized[key] = "";
      continue;
    }

    sanitized[key] = sanitizeUnknown(item, state, options);
  }

  return sanitized;
}

function sanitizeAttributes(
  attributes: Record<string, unknown>,
  state: ReplaySanitizerState,
  options: ReplaySanitizerOptions,
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

    if (normalizedKey.startsWith("on")) {
      sanitized[key] = "";
      continue;
    }

    if (URL_ATTRIBUTE_NAMES.has(normalizedKey)) {
      const kind = resourceKindForAttribute(tagName, normalizedKey, attributes);
      sanitized[key] = kind === undefined ? "" : sanitizeUrlString(value, kind, options);
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
      const context = CSS_PRESENTATION_ATTRIBUTE_NAMES.has(normalizedKey)
        ? "value"
        : normalizedKey === "style"
          ? "declarationList"
          : "stylesheet";
      sanitized[key] = sanitizeCssValue(value, context, options);
      continue;
    }

    sanitized[key] = sanitizeUnknown(value, state, options);
  }

  return sanitized;
}
