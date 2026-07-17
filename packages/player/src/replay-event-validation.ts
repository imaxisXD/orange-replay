import type { BatchIndex } from "@orange-replay/shared/types";
import type { ReplayEvent } from "./types.ts";

export const MAX_DECODED_BATCH_EVENTS = 25_000;
export const MAX_REPLAY_FUTURE_TIMESTAMP_MS = 60_000;
export const MAX_STORED_REPLAY_DELAY_MS = 24 * 60 * 60_000;
export const MAX_MOVEMENT_PAST_OFFSET_MS = 5 * 60_000;
export const MAX_MOVEMENT_FUTURE_OFFSET_MS = 1_000;
export const MOVEMENT_ORDER_TOLERANCE_MS = 1_000;
export const REPLAY_INDEX_TIMESTAMP_TOLERANCE_MS = 1_000;

const VALIDATION_LIMITS = {
  maxEvents: MAX_DECODED_BATCH_EVENTS,
  maxDepth: 128,
  maxKeys: 200,
  maxArrayItems: 10_000,
  maxShapeNodes: 250_000,
  maxTagNameChars: 128,
  maxAttributeNameChars: 256,
  maxFutureTimestampMs: MAX_REPLAY_FUTURE_TIMESTAMP_MS,
  maxStoredDelayMs: MAX_STORED_REPLAY_DELAY_MS,
  maxMovementPastOffsetMs: MAX_MOVEMENT_PAST_OFFSET_MS,
  maxMovementFutureOffsetMs: MAX_MOVEMENT_FUTURE_OFFSET_MS,
  movementOrderToleranceMs: MOVEMENT_ORDER_TOLERANCE_MS,
} as const;

type ReplayEventValidator = (events: unknown[]) => ReplayEvent[];

/**
 * Keep every helper inside this factory. Its transpiled function body is also
 * embedded in the browser decode worker, so the main-thread fallback and the
 * generated worker cannot acquire different validation rules.
 */
function createReplayEventValidator(limits: typeof VALIDATION_LIMITS): ReplayEventValidator {
  const EVENT_TYPE_FULL_SNAPSHOT = 2;
  const EVENT_TYPE_INCREMENTAL_SNAPSHOT = 3;
  const EVENT_TYPE_META = 4;
  const SOURCE_MUTATION = 0;
  const SOURCE_MOUSE_MOVE = 1;
  const SOURCE_MOUSE_INTERACTION = 2;
  const SOURCE_SCROLL = 3;
  const SOURCE_VIEWPORT_RESIZE = 4;
  const SOURCE_INPUT = 5;
  const SOURCE_TOUCH_MOVE = 6;
  const SOURCE_MEDIA_INTERACTION = 7;
  const SOURCE_STYLE_SHEET_RULE = 8;
  const SOURCE_CANVAS_MUTATION = 9;
  const SOURCE_FONT = 10;
  const SOURCE_LOG = 11;
  const SOURCE_DRAG = 12;
  const SOURCE_STYLE_DECLARATION = 13;
  const SOURCE_SELECTION = 14;
  const SOURCE_ADOPTED_STYLE_SHEET = 15;
  const SOURCE_CUSTOM_ELEMENT = 16;
  const SNAPSHOT_NODE_DOCUMENT = 0;
  const SNAPSHOT_NODE_DOCUMENT_TYPE = 1;
  const SNAPSHOT_NODE_ELEMENT = 2;
  const SNAPSHOT_NODE_TEXT = 3;
  const SNAPSHOT_NODE_CDATA = 4;
  const SNAPSHOT_NODE_COMMENT = 5;
  const INVALID_INCREMENTAL = "Replay batch contains invalid incremental replay data.";

  function fail(message: string): never {
    const error = new Error(message);
    error.name = "ReplayDataError";
    throw error;
  }

  function validateReplayEvents(events: unknown[]): ReplayEvent[] {
    if (events.length > limits.maxEvents) {
      fail("Replay batch has too many events.");
    }

    let shapeNodes = 0;
    for (const event of events) {
      validateReplayEvent(event);
      shapeNodes += countBoundedJsonShape(event, limits.maxShapeNodes - shapeNodes);
      if (shapeNodes > limits.maxShapeNodes) {
        fail("Replay batch is too complex.");
      }
    }
    return events as ReplayEvent[];
  }

  function validateReplayEvent(event: unknown): void {
    if (!isPlainRecord(event)) fail("Replay batch contains an invalid replay event.");
    if (!isIntegerInRange(event["type"], 0, 7)) {
      fail("Replay batch contains an invalid replay event type.");
    }
    if (
      !isFiniteNumber(event["timestamp"]) ||
      event["timestamp"] < 0 ||
      event["timestamp"] > Date.now() + limits.maxFutureTimestampMs
    ) {
      fail("Replay batch contains an invalid replay timestamp.");
    }
    if (event["delay"] !== undefined) {
      const delay = event["delay"];
      if (!isFiniteNumber(delay) || Math.abs(delay) > limits.maxStoredDelayMs) {
        fail("Replay batch contains an invalid replay delay.");
      }
    }
    if (!isPlainRecord(event["data"])) {
      fail("Replay batch contains invalid replay event data.");
    }

    if (event["type"] === EVENT_TYPE_FULL_SNAPSHOT) validateFullSnapshotData(event["data"]);
    if (event["type"] === EVENT_TYPE_META) validateMetaData(event["data"]);
    if (event["type"] === EVENT_TYPE_INCREMENTAL_SNAPSHOT) {
      validateIncrementalData(event["data"]);
    }
  }

  function validateFullSnapshotData(data: Record<string, unknown>): void {
    if (!isPlainRecord(data["node"])) {
      fail("Replay batch contains an invalid full snapshot.");
    }
    validateSnapshotNode(data["node"], "Replay batch contains an invalid full snapshot node.");
  }

  function validateSnapshotNode(root: unknown, errorMessage: string): void {
    const stack: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }];
    let nodeCount = 0;
    while (stack.length > 0) {
      const next = stack.pop();
      if (next === undefined) continue;
      nodeCount += 1;
      if (nodeCount > limits.maxShapeNodes) fail("Replay batch is too complex.");
      if (next.depth > limits.maxDepth) fail("Replay event is too deeply nested.");
      if (!isPlainRecord(next.node)) fail(errorMessage);
      const node = next.node;
      if (!isSnapshotId(node["id"]) || !isIntegerInRange(node["type"], 0, 5)) {
        fail(errorMessage);
      }
      switch (node["type"]) {
        case SNAPSHOT_NODE_DOCUMENT:
          queueSnapshotChildren(node, stack, next.depth, errorMessage);
          break;
        case SNAPSHOT_NODE_DOCUMENT_TYPE:
          if (
            typeof node["name"] !== "string" ||
            typeof node["publicId"] !== "string" ||
            typeof node["systemId"] !== "string"
          ) {
            fail(errorMessage);
          }
          break;
        case SNAPSHOT_NODE_ELEMENT:
          validateElementNode(node, errorMessage);
          queueSnapshotChildren(node, stack, next.depth, errorMessage);
          break;
        case SNAPSHOT_NODE_TEXT:
        case SNAPSHOT_NODE_CDATA:
        case SNAPSHOT_NODE_COMMENT:
          if (
            typeof node["textContent"] !== "string" ||
            node["tagName"] !== undefined ||
            node["attributes"] !== undefined ||
            node["childNodes"] !== undefined
          ) {
            fail(errorMessage);
          }
          break;
        default:
          fail(errorMessage);
      }
    }
  }

  function queueSnapshotChildren(
    node: Record<string, unknown>,
    stack: Array<{ node: unknown; depth: number }>,
    depth: number,
    errorMessage: string,
  ): void {
    const children = node["childNodes"];
    if (!isBoundedArray(children)) fail(errorMessage);
    for (const child of children) stack.push({ node: child, depth: depth + 1 });
  }

  function validateElementNode(node: Record<string, unknown>, errorMessage: string): void {
    const tagName = node["tagName"];
    if (
      typeof tagName !== "string" ||
      tagName.length === 0 ||
      tagName.length > limits.maxTagNameChars ||
      !/^[A-Za-z][A-Za-z0-9:_-]*$/.test(tagName)
    ) {
      fail(errorMessage);
    }
    const attributes = node["attributes"];
    if (!isPlainRecord(attributes)) fail(errorMessage);
    const entries = Object.entries(attributes);
    if (entries.length > limits.maxKeys) fail(errorMessage);
    for (const [name, value] of entries) {
      if (
        name.length === 0 ||
        name.length > limits.maxAttributeNameChars ||
        (value !== null &&
          typeof value !== "string" &&
          typeof value !== "number" &&
          typeof value !== "boolean")
      ) {
        fail(errorMessage);
      }
    }
  }

  function validateMetaData(data: Record<string, unknown>): void {
    if (
      typeof data["href"] !== "string" ||
      !isPositiveFiniteNumber(data["width"]) ||
      !isPositiveFiniteNumber(data["height"])
    ) {
      fail("Replay batch contains invalid meta data.");
    }
  }

  function validateIncrementalData(data: Record<string, unknown>): void {
    if (!isIntegerInRange(data["source"], 0, SOURCE_CUSTOM_ELEMENT)) fail(INVALID_INCREMENTAL);
    switch (data["source"]) {
      case SOURCE_MUTATION:
        validateMutationData(data);
        return;
      case SOURCE_MOUSE_MOVE:
      case SOURCE_TOUCH_MOVE:
      case SOURCE_DRAG:
        validateMovementData(data);
        return;
      case SOURCE_MOUSE_INTERACTION:
        validateMouseInteractionData(data);
        return;
      case SOURCE_SCROLL:
        requireTargetId(data["id"]);
        requireFinite(data["x"]);
        requireFinite(data["y"]);
        return;
      case SOURCE_VIEWPORT_RESIZE:
        if (!isPositiveFiniteNumber(data["width"]) || !isPositiveFiniteNumber(data["height"])) {
          fail(INVALID_INCREMENTAL);
        }
        return;
      case SOURCE_INPUT:
        requireTargetId(data["id"]);
        if (typeof data["text"] !== "string" || typeof data["isChecked"] !== "boolean") {
          fail(INVALID_INCREMENTAL);
        }
        if (data["userTriggered"] !== undefined && typeof data["userTriggered"] !== "boolean") {
          fail(INVALID_INCREMENTAL);
        }
        return;
      case SOURCE_MEDIA_INTERACTION:
        validateMediaInteractionData(data);
        return;
      case SOURCE_STYLE_SHEET_RULE:
        validateStyleSheetRuleData(data);
        return;
      case SOURCE_CANVAS_MUTATION:
        validateCanvasMutationData(data);
        return;
      case SOURCE_FONT:
        validateFontData(data);
        return;
      case SOURCE_LOG:
        // Source 11 belongs to the optional console plugin and is not part of
        // the rrweb core incremental-data union used by this player.
        fail(INVALID_INCREMENTAL);
      case SOURCE_STYLE_DECLARATION:
        validateStyleDeclarationData(data);
        return;
      case SOURCE_SELECTION:
        validateSelectionData(data);
        return;
      case SOURCE_ADOPTED_STYLE_SHEET:
        validateAdoptedStyleSheetData(data);
        return;
      case SOURCE_CUSTOM_ELEMENT:
        validateCustomElementData(data);
        return;
      default:
        fail(INVALID_INCREMENTAL);
    }
  }

  function validateMutationData(data: Record<string, unknown>): void {
    const texts = boundedArrayField(data, "texts");
    const attributes = boundedArrayField(data, "attributes");
    const removes = boundedArrayField(data, "removes");
    const adds = boundedArrayField(data, "adds");
    for (const value of texts) {
      const item = plainItem(value);
      requireTargetId(item["id"]);
      if (item["value"] !== null && typeof item["value"] !== "string") {
        fail(INVALID_INCREMENTAL);
      }
    }
    for (const value of attributes) {
      const item = plainItem(value);
      requireTargetId(item["id"]);
      if (!isPlainRecord(item["attributes"])) fail(INVALID_INCREMENTAL);
    }
    for (const value of removes) {
      const item = plainItem(value);
      requireTargetId(item["id"]);
      requireTargetId(item["parentId"]);
    }
    for (const value of adds) {
      const item = plainItem(value);
      requireTargetId(item["parentId"]);
      requireNullableTargetId(item["nextId"]);
      if (item["previousId"] !== undefined) requireNullableTargetId(item["previousId"]);
      validateSnapshotNode(item["node"], INVALID_INCREMENTAL);
    }
    if (data["isAttachIframe"] !== undefined && data["isAttachIframe"] !== true) {
      fail(INVALID_INCREMENTAL);
    }
  }

  function validateMovementData(data: Record<string, unknown>): void {
    const positions = boundedArrayField(data, "positions", true);
    let previousTimeOffset: number | undefined;
    for (const value of positions) {
      const position = plainItem(value);
      requireFinite(position["x"]);
      requireFinite(position["y"]);
      requireTargetId(position["id"]);
      const timeOffset = position["timeOffset"];
      requireFinite(timeOffset);
      if (
        timeOffset < -limits.maxMovementPastOffsetMs ||
        timeOffset > limits.maxMovementFutureOffsetMs ||
        (previousTimeOffset !== undefined &&
          timeOffset + limits.movementOrderToleranceMs < previousTimeOffset)
      ) {
        fail(INVALID_INCREMENTAL);
      }
      previousTimeOffset = timeOffset;
    }
  }

  function validateMouseInteractionData(data: Record<string, unknown>): void {
    if (!isIntegerInRange(data["type"], 0, 10)) fail(INVALID_INCREMENTAL);
    requireTargetId(data["id"]);
    if (data["x"] !== undefined) requireFinite(data["x"]);
    if (data["y"] !== undefined) requireFinite(data["y"]);
    if (data["pointerType"] !== undefined && !isIntegerInRange(data["pointerType"], 0, 2)) {
      fail(INVALID_INCREMENTAL);
    }
  }

  function validateMediaInteractionData(data: Record<string, unknown>): void {
    if (!isIntegerInRange(data["type"], 0, 4)) fail(INVALID_INCREMENTAL);
    requireTargetId(data["id"]);
    for (const key of ["currentTime", "volume", "playbackRate"] as const) {
      if (data[key] !== undefined) requireFinite(data[key]);
    }
    for (const key of ["muted", "loop"] as const) {
      if (data[key] !== undefined && typeof data[key] !== "boolean") fail(INVALID_INCREMENTAL);
    }
  }

  function validateStyleSheetRuleData(data: Record<string, unknown>): void {
    validateStyleTarget(data);
    if (data["adds"] !== undefined) {
      for (const value of boundedArrayField(data, "adds")) {
        const add = plainItem(value);
        if (typeof add["rule"] !== "string") fail(INVALID_INCREMENTAL);
        if (add["index"] !== undefined) validateRuleIndex(add["index"]);
      }
    }
    if (data["removes"] !== undefined) {
      for (const value of boundedArrayField(data, "removes")) {
        validateRuleIndex(plainItem(value)["index"]);
      }
    }
    for (const key of ["replace", "replaceSync"] as const) {
      if (data[key] !== undefined) {
        if (typeof data[key] !== "string") fail(INVALID_INCREMENTAL);
      }
    }
  }

  function validateStyleDeclarationData(data: Record<string, unknown>): void {
    validateStyleTarget(data);
    validateIndexPath(data["index"]);
    const set = data["set"];
    const remove = data["remove"];
    if (set !== undefined) {
      const item = plainItem(set);
      if (
        !isNonEmptyString(item["property"]) ||
        (item["value"] !== null && typeof item["value"] !== "string") ||
        (item["priority"] !== undefined && typeof item["priority"] !== "string")
      ) {
        fail(INVALID_INCREMENTAL);
      }
    }
    if (remove !== undefined && !isNonEmptyString(plainItem(remove)["property"])) {
      fail(INVALID_INCREMENTAL);
    }
  }

  function validateCanvasMutationData(data: Record<string, unknown>): void {
    requireTargetId(data["id"]);
    if (!isIntegerInRange(data["type"], 0, 2)) fail(INVALID_INCREMENTAL);
    if (data["commands"] !== undefined) {
      const commands = boundedArrayField(data, "commands");
      for (const command of commands) validateCanvasCommand(command);
      return;
    }
    validateCanvasCommand(data);
  }

  function validateCanvasCommand(value: unknown): void {
    const command = plainItem(value);
    if (!isNonEmptyString(command["property"]) || !isBoundedArray(command["args"])) {
      fail(INVALID_INCREMENTAL);
    }
    if (command["setter"] !== undefined && command["setter"] !== true) fail(INVALID_INCREMENTAL);
  }

  function validateFontData(data: Record<string, unknown>): void {
    if (
      !isNonEmptyString(data["family"]) ||
      typeof data["fontSource"] !== "string" ||
      typeof data["buffer"] !== "boolean" ||
      (data["descriptors"] !== undefined && !isPlainRecord(data["descriptors"]))
    ) {
      fail(INVALID_INCREMENTAL);
    }
  }

  function validateSelectionData(data: Record<string, unknown>): void {
    for (const value of boundedArrayField(data, "ranges")) {
      const range = plainItem(value);
      requireTargetId(range["start"]);
      requireTargetId(range["end"]);
      requireNonNegativeInteger(range["startOffset"]);
      requireNonNegativeInteger(range["endOffset"]);
    }
  }

  function validateAdoptedStyleSheetData(data: Record<string, unknown>): void {
    requireTargetId(data["id"]);
    for (const styleId of boundedArrayField(data, "styleIds")) requireStyleId(styleId);
    if (data["styles"] === undefined) return;
    for (const value of boundedArrayField(data, "styles")) {
      const style = plainItem(value);
      requireStyleId(style["styleId"]);
      for (const rule of boundedArrayField(style, "rules")) {
        const ruleItem = plainItem(rule);
        if (typeof ruleItem["rule"] !== "string") fail(INVALID_INCREMENTAL);
        if (ruleItem["index"] !== undefined) validateRuleIndex(ruleItem["index"]);
      }
    }
  }

  function validateCustomElementData(data: Record<string, unknown>): void {
    if (data["define"] === undefined) return;
    const define = plainItem(data["define"]);
    const name = define["name"];
    if (
      typeof name !== "string" ||
      name.length > limits.maxTagNameChars ||
      !/^[a-z][a-z0-9._-]*-[a-z0-9._-]+$/.test(name)
    ) {
      fail(INVALID_INCREMENTAL);
    }
  }

  function validateStyleTarget(data: Record<string, unknown>): void {
    const id = data["id"];
    const styleId = data["styleId"];
    if (id === undefined && styleId === undefined) fail(INVALID_INCREMENTAL);
    if (id !== undefined) requireTargetId(id);
    if (styleId !== undefined) requireStyleId(styleId);
  }

  function validateRuleIndex(value: unknown): void {
    if (Array.isArray(value)) {
      validateIndexPath(value);
      return;
    }
    requireNonNegativeInteger(value);
  }

  function validateIndexPath(value: unknown): void {
    if (!isBoundedArray(value) || value.length === 0) fail(INVALID_INCREMENTAL);
    for (const index of value) requireNonNegativeInteger(index);
  }

  function boundedArrayField(
    data: Record<string, unknown>,
    field: string,
    requireItems = false,
  ): unknown[] {
    const value = data[field];
    if (!isBoundedArray(value) || (requireItems && value.length === 0)) fail(INVALID_INCREMENTAL);
    return value;
  }

  function isBoundedArray(value: unknown): value is unknown[] {
    return Array.isArray(value) && value.length <= limits.maxArrayItems;
  }

  function plainItem(value: unknown): Record<string, unknown> {
    if (!isPlainRecord(value)) fail(INVALID_INCREMENTAL);
    return value;
  }

  function requireTargetId(value: unknown): void {
    if (!Number.isSafeInteger(value) || Number(value) < -1) fail(INVALID_INCREMENTAL);
  }

  function requireNullableTargetId(value: unknown): void {
    if (value !== null) requireTargetId(value);
  }

  function requireStyleId(value: unknown): void {
    if (!Number.isSafeInteger(value) || Number(value) <= 0) fail(INVALID_INCREMENTAL);
  }

  function requireNonNegativeInteger(value: unknown): void {
    if (!Number.isSafeInteger(value) || Number(value) < 0) fail(INVALID_INCREMENTAL);
  }

  function requireFinite(value: unknown): asserts value is number {
    if (!isFiniteNumber(value)) fail(INVALID_INCREMENTAL);
  }

  function isSnapshotId(value: unknown): boolean {
    return Number.isSafeInteger(value) && Number(value) >= 0;
  }

  function isIntegerInRange(value: unknown, min: number, max: number): boolean {
    return Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
  }

  function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
  }

  function isPositiveFiniteNumber(value: unknown): boolean {
    return isFiniteNumber(value) && value > 0;
  }

  function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.length > 0;
  }

  function countBoundedJsonShape(root: unknown, remainingNodes: number): number {
    const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
    let nodes = 0;
    while (stack.length > 0) {
      const next = stack.pop();
      if (next === undefined) continue;
      nodes += 1;
      if (nodes > remainingNodes) fail("Replay batch is too complex.");
      if (next.depth > limits.maxDepth) fail("Replay event is too deeply nested.");
      if (Array.isArray(next.value)) {
        if (
          next.value.length > limits.maxArrayItems ||
          nodes + stack.length + next.value.length > remainingNodes
        ) {
          fail("Replay batch is too complex.");
        }
        for (const item of next.value) stack.push({ value: item, depth: next.depth + 1 });
      } else if (isPlainRecord(next.value)) {
        const values = Object.values(next.value);
        if (values.length > limits.maxKeys) fail("Replay event has too many fields.");
        if (nodes + stack.length + values.length > remainingNodes) {
          fail("Replay batch is too complex.");
        }
        for (const value of values) stack.push({ value, depth: next.depth + 1 });
      }
    }
    return nodes;
  }

  function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== "object") return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  return validateReplayEvents;
}

export const validateReplayEvents = createReplayEventValidator(VALIDATION_LIMITS);

/**
 * The Worker clamps every accepted index against server time before storage.
 * Keep decoded payload times inside that trusted envelope so one crafted JSON
 * payload cannot leave rrweb's animation timer waiting on a distant event.
 */
export function validateReplayEventTimesAgainstIndex(
  events: readonly ReplayEvent[],
  index: Pick<BatchIndex, "t0" | "t1">,
): void {
  if (!Number.isFinite(index.t0) || !Number.isFinite(index.t1) || index.t1 < index.t0) {
    throw replayDataError("Replay batch contains an invalid accepted time range.");
  }
  const minimumTime = index.t0 - REPLAY_INDEX_TIMESTAMP_TOLERANCE_MS;
  const maximumTime = index.t1 + REPLAY_INDEX_TIMESTAMP_TOLERANCE_MS;
  for (const event of events) {
    if (event.timestamp < minimumTime || event.timestamp > maximumTime) {
      throw replayDataError("Replay event time falls outside its accepted batch.");
    }
  }
}

function replayDataError(message: string): Error {
  const error = new Error(message);
  error.name = "ReplayDataError";
  return error;
}

export const REPLAY_EVENT_VALIDATOR_SOURCE = `
const validateReplayEvents = (${createReplayEventValidator.toString()})(${JSON.stringify(
  VALIDATION_LIMITS,
)});
`;
