import type { ReplayEvent } from "./types.ts";

export interface DecodedReplayEvents {
  events: ReplayEvent[];
  decodedBytes: number;
}

export const MAX_DECODED_BATCH_BYTES = 16 * 1024 * 1024;
export const MAX_DECODED_BATCH_EVENTS = 25_000;
export const MAX_REPLAY_JSON_TRAILING_WHITESPACE_CHARS = 4096;
const MIN_DECODED_BATCH_BYTES = 1024 * 1024;
const MAX_DECODED_EXPANSION_RATIO = 32;
// rrweb serializes ~2 JSON levels per DOM level, so this must comfortably exceed
// twice the DOM depth of real pages (30-60 deep); 40 rejected our own landing page.
const MAX_REPLAY_EVENT_DEPTH = 128;
const MAX_REPLAY_EVENT_KEYS = 200;
const MAX_REPLAY_EVENT_ARRAY_ITEMS = 10_000;
const MAX_DECODED_BATCH_SHAPE_NODES = 250_000;
const MAX_EVENT_TYPE = 7;
const MAX_INCREMENTAL_SOURCE = 16;
const EVENT_TYPE_FULL_SNAPSHOT = 2;
const EVENT_TYPE_INCREMENTAL_SNAPSHOT = 3;
const EVENT_TYPE_META = 4;
const INCREMENTAL_SOURCE_MUTATION = 0;
const INCREMENTAL_SOURCE_MOUSE_MOVE = 1;
const INCREMENTAL_SOURCE_MOUSE_INTERACTION = 2;
const INCREMENTAL_SOURCE_SCROLL = 3;
const INCREMENTAL_SOURCE_VIEWPORT_RESIZE = 4;
const INCREMENTAL_SOURCE_INPUT = 5;
const INCREMENTAL_SOURCE_MEDIA_INTERACTION = 7;
const SNAPSHOT_NODE_DOCUMENT = 0;
const SNAPSHOT_NODE_DOCUMENT_TYPE = 1;
const SNAPSHOT_NODE_ELEMENT = 2;
const SNAPSHOT_NODE_TEXT = 3;
const SNAPSHOT_NODE_CDATA = 4;
const SNAPSHOT_NODE_COMMENT = 5;
const MAX_SNAPSHOT_TAG_NAME_CHARS = 128;
const MAX_SNAPSHOT_ATTRIBUTE_NAME_CHARS = 256;

const textDecoder = new TextDecoder("utf-8", { fatal: true });

export async function decodeBatchBytes(payload: Uint8Array): Promise<ReplayEvent[]> {
  return (await decodeBatchWithStats(payload)).events;
}

export async function decodeBatchWithStats(payload: Uint8Array): Promise<DecodedReplayEvents> {
  const plainBytes = await gunzipOrPlain(payload);
  assertDecodedSize(payload, plainBytes.byteLength);
  const text = textDecoder.decode(plainBytes);
  assertJsonTrailingWhitespace(text);
  const parsed = JSON.parse(text) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error("Replay batch JSON must be an array.");
  }

  return {
    decodedBytes: plainBytes.byteLength,
    events: validateReplayEvents(parsed),
  };
}

async function gunzipOrPlain(payload: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "function") {
    return payload;
  }

  try {
    const body = new Response(payload as unknown as BodyInit).body;
    if (body === null) {
      return payload;
    }

    return await readDecodedStream(body.pipeThrough(new DecompressionStream("gzip")), payload);
  } catch (error) {
    if (isDecodeLimitError(error)) {
      throw error;
    }
    return payload;
  }
}

async function readDecodedStream(
  stream: ReadableStream<Uint8Array>,
  compressedPayload: Uint8Array,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  for (;;) {
    const read = await reader.read();
    if (read.done) {
      break;
    }

    totalBytes += read.value.byteLength;
    assertDecodedSize(compressedPayload, totalBytes);
    chunks.push(read.value);
  }

  const decoded = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    decoded.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return decoded;
}

function assertDecodedSize(compressedPayload: Uint8Array, decodedBytes: number): void {
  if (decodedBytes <= decodedByteLimit(compressedPayload)) {
    return;
  }

  const error = new Error("Replay batch is too large after decoding.");
  error.name = "ReplayDecodeLimitError";
  throw error;
}

function decodedByteLimit(payload: Uint8Array): number {
  return Math.min(
    MAX_DECODED_BATCH_BYTES,
    Math.max(MIN_DECODED_BATCH_BYTES, payload.byteLength * MAX_DECODED_EXPANSION_RATIO),
  );
}

function isDecodeLimitError(error: unknown): boolean {
  return error instanceof Error && error.name === "ReplayDecodeLimitError";
}

function assertJsonTrailingWhitespace(text: string): void {
  let index = text.length - 1;
  while (index >= 0 && isJsonWhitespace(text.charCodeAt(index))) {
    index -= 1;
  }

  if (text.length - index - 1 > MAX_REPLAY_JSON_TRAILING_WHITESPACE_CHARS) {
    throw new Error("Replay batch JSON has too much trailing whitespace.");
  }
}

function isJsonWhitespace(charCode: number): boolean {
  return charCode === 0x20 || charCode === 0x0a || charCode === 0x0d || charCode === 0x09;
}

function validateReplayEvents(events: unknown[]): ReplayEvent[] {
  if (events.length > MAX_DECODED_BATCH_EVENTS) {
    throw new Error("Replay batch has too many events.");
  }

  let shapeNodes = 0;
  for (const event of events) {
    validateReplayEvent(event);
    shapeNodes += countBoundedJsonShape(event, MAX_DECODED_BATCH_SHAPE_NODES - shapeNodes);
    if (shapeNodes > MAX_DECODED_BATCH_SHAPE_NODES) {
      throw new Error("Replay batch is too complex.");
    }
  }

  return events as ReplayEvent[];
}

function validateReplayEvent(event: unknown): void {
  if (!isPlainRecord(event)) {
    throw new Error("Replay batch contains an invalid replay event.");
  }

  if (!isIntegerInRange(event["type"], 0, MAX_EVENT_TYPE)) {
    throw new Error("Replay batch contains an invalid replay event type.");
  }

  if (!Number.isFinite(event["timestamp"])) {
    throw new Error("Replay batch contains an invalid replay timestamp.");
  }

  if (event["data"] === undefined) {
    throw new Error("Replay batch contains replay event data that is missing.");
  }

  if (!isPlainRecord(event["data"])) {
    throw new Error("Replay batch contains invalid replay event data.");
  }

  if (event["type"] === EVENT_TYPE_FULL_SNAPSHOT) {
    validateFullSnapshotData(event["data"]);
    return;
  }

  if (event["type"] === EVENT_TYPE_META) {
    validateMetaData(event["data"]);
    return;
  }

  if (event["type"] === EVENT_TYPE_INCREMENTAL_SNAPSHOT) {
    validateIncrementalData(event["data"]);
  }
}

function validateFullSnapshotData(data: Record<string, unknown>): void {
  if (!isPlainRecord(data["node"])) {
    throw new Error("Replay batch contains an invalid full snapshot.");
  }
  validateSnapshotNode(data["node"], "Replay batch contains an invalid full snapshot node.");
}

function validateSnapshotNode(root: unknown, errorMessage: string): void {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: root, depth: 0 }];
  let nodeCount = 0;

  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) {
      continue;
    }

    nodeCount += 1;
    if (nodeCount > MAX_DECODED_BATCH_SHAPE_NODES) {
      throw new Error("Replay batch is too complex.");
    }
    if (next.depth > MAX_REPLAY_EVENT_DEPTH) {
      throw new Error("Replay event is too deeply nested.");
    }
    if (!isPlainRecord(next.node)) {
      throw new Error(errorMessage);
    }

    const node = next.node;
    if (!isSafeReplayId(node["id"]) || !isIntegerInRange(node["type"], 0, 5)) {
      throw new Error(errorMessage);
    }

    switch (node["type"]) {
      case SNAPSHOT_NODE_DOCUMENT:
        queueSnapshotChildren(node, stack, next.depth, errorMessage);
        break;
      case SNAPSHOT_NODE_DOCUMENT_TYPE:
        validateDocumentTypeNode(node, errorMessage);
        break;
      case SNAPSHOT_NODE_ELEMENT:
        validateElementNode(node, errorMessage);
        queueSnapshotChildren(node, stack, next.depth, errorMessage);
        break;
      case SNAPSHOT_NODE_TEXT:
      case SNAPSHOT_NODE_CDATA:
      case SNAPSHOT_NODE_COMMENT:
        validateTextLikeNode(node, errorMessage);
        break;
      default:
        throw new Error(errorMessage);
    }
  }
}

function validateTextLikeNode(node: Record<string, unknown>, errorMessage: string): void {
  if (
    typeof node["textContent"] !== "string" ||
    node["tagName"] !== undefined ||
    node["attributes"] !== undefined ||
    node["childNodes"] !== undefined
  ) {
    throw new Error(errorMessage);
  }
}

function queueSnapshotChildren(
  node: Record<string, unknown>,
  stack: Array<{ node: unknown; depth: number }>,
  depth: number,
  errorMessage: string,
): void {
  const children = node["childNodes"];
  if (!Array.isArray(children) || children.length > MAX_REPLAY_EVENT_ARRAY_ITEMS) {
    throw new Error(errorMessage);
  }

  for (const child of children) {
    stack.push({ node: child, depth: depth + 1 });
  }
}

function validateDocumentTypeNode(node: Record<string, unknown>, errorMessage: string): void {
  if (
    typeof node["name"] !== "string" ||
    typeof node["publicId"] !== "string" ||
    typeof node["systemId"] !== "string"
  ) {
    throw new Error(errorMessage);
  }
}

function validateElementNode(node: Record<string, unknown>, errorMessage: string): void {
  if (!isValidSnapshotTagName(node["tagName"])) {
    throw new Error(errorMessage);
  }

  validateSnapshotAttributes(node["attributes"], errorMessage);
}

function validateSnapshotAttributes(value: unknown, errorMessage: string): void {
  if (!isPlainRecord(value)) {
    throw new Error(errorMessage);
  }

  const entries = Object.entries(value);
  if (entries.length > MAX_REPLAY_EVENT_KEYS) {
    throw new Error(errorMessage);
  }

  for (const [name, attributeValue] of entries) {
    if (
      name.length === 0 ||
      name.length > MAX_SNAPSHOT_ATTRIBUTE_NAME_CHARS ||
      (attributeValue !== null &&
        typeof attributeValue !== "string" &&
        typeof attributeValue !== "number" &&
        typeof attributeValue !== "boolean")
    ) {
      throw new Error(errorMessage);
    }
  }
}

function isValidSnapshotTagName(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_SNAPSHOT_TAG_NAME_CHARS &&
    /^[A-Za-z][A-Za-z0-9:_-]*$/.test(value)
  );
}

function validateMetaData(data: Record<string, unknown>): void {
  if (
    typeof data["href"] !== "string" ||
    !isPositiveFiniteNumber(data["width"]) ||
    !isPositiveFiniteNumber(data["height"])
  ) {
    throw new Error("Replay batch contains invalid meta data.");
  }
}

function validateIncrementalData(data: Record<string, unknown>): void {
  if (!isIntegerInRange(data["source"], 0, MAX_INCREMENTAL_SOURCE)) {
    throw new Error("Replay batch contains an invalid replay event source.");
  }

  switch (data["source"]) {
    case INCREMENTAL_SOURCE_MUTATION:
      validateMutationData(data);
      return;
    case INCREMENTAL_SOURCE_MOUSE_MOVE:
      validateArrayField(data, "positions");
      return;
    case INCREMENTAL_SOURCE_MOUSE_INTERACTION:
    case INCREMENTAL_SOURCE_SCROLL:
    case INCREMENTAL_SOURCE_INPUT:
    case INCREMENTAL_SOURCE_MEDIA_INTERACTION:
      validateOptionalSafeId(data["id"]);
      return;
    case INCREMENTAL_SOURCE_VIEWPORT_RESIZE:
      if (!isPositiveFiniteNumber(data["width"]) || !isPositiveFiniteNumber(data["height"])) {
        throw new Error("Replay batch contains invalid viewport data.");
      }
      return;
    default:
      return;
  }
}

function validateMutationData(data: Record<string, unknown>): void {
  const texts = validateArrayField(data, "texts");
  const attributes = validateArrayField(data, "attributes");
  const removes = validateArrayField(data, "removes");
  const adds = validateArrayField(data, "adds");

  for (const item of texts) validateRecordSafeId(item, "id");
  for (const item of attributes) validateRecordSafeId(item, "id");
  for (const item of removes) {
    validateRecordSafeId(item, "id");
    validateRecordSafeId(item, "parentId");
  }
  for (const item of adds) {
    validateRecordSafeId(item, "parentId");
    if (!isPlainRecord(item) || item["node"] === undefined) {
      throw new Error("Replay batch contains invalid mutation data.");
    }
    validateSnapshotNode(item["node"], "Replay batch contains invalid mutation data.");
  }
}

function validateArrayField(data: Record<string, unknown>, field: string): unknown[] {
  const value = data[field];
  if (!Array.isArray(value) || value.length > MAX_REPLAY_EVENT_ARRAY_ITEMS) {
    throw new Error("Replay batch contains invalid mutation data.");
  }
  return value;
}

function validateRecordSafeId(value: unknown, field: string): void {
  if (!isPlainRecord(value)) {
    throw new Error("Replay batch contains invalid mutation data.");
  }
  validateOptionalSafeId(value[field]);
}

function validateOptionalSafeId(value: unknown): void {
  if (value !== undefined && !isSafeReplayId(value)) {
    throw new Error("Replay batch contains invalid mutation data.");
  }
}

function isSafeReplayId(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function countBoundedJsonShape(root: unknown, remainingNodes: number): number {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;

  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) {
      continue;
    }

    nodes += 1;
    if (nodes > remainingNodes) {
      throw new Error("Replay batch is too complex.");
    }
    if (next.depth > MAX_REPLAY_EVENT_DEPTH) {
      throw new Error("Replay event is too deeply nested.");
    }

    if (Array.isArray(next.value)) {
      if (
        next.value.length > MAX_REPLAY_EVENT_ARRAY_ITEMS ||
        nodes + stack.length + next.value.length > remainingNodes
      ) {
        throw new Error("Replay batch is too complex.");
      }
      for (const item of next.value) {
        stack.push({ value: item, depth: next.depth + 1 });
      }
      continue;
    }

    if (isPlainRecord(next.value)) {
      const values = Object.values(next.value);
      if (values.length > MAX_REPLAY_EVENT_KEYS) {
        throw new Error("Replay event has too many fields.");
      }
      if (nodes + stack.length + values.length > remainingNodes) {
        throw new Error("Replay batch is too complex.");
      }

      for (const value of values) {
        stack.push({ value, depth: next.depth + 1 });
      }
    }
  }

  return nodes;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isIntegerInRange(value: unknown, min: number, max: number): boolean {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
}

function isPositiveFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
