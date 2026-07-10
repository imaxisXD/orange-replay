import {
  MAX_BATCHES_PER_SEGMENT,
  MAX_CHECKPOINTS_PER_BATCH,
  MAX_INDEX_JSON_BYTES,
  MAX_SEQ,
} from "./constants.ts";
import type { BatchIndex } from "./types.ts";

const INGEST_SEPARATOR = 0x00;
const SEGMENT_MAGIC = new Uint8Array([0x4f, 0x52, 0x53, 0x31]);
const SEGMENT_HEADER_BYTES = 8;
const U32_BYTES = 4;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export class WireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WireError";
  }
}

export function encodeIngestBody(index: BatchIndex, payload: Uint8Array): Uint8Array {
  const indexJson = JSON.stringify(index);
  const indexBytes = utf8Encoder.encode(indexJson);
  const output = new Uint8Array(indexBytes.byteLength + 1 + payload.byteLength);

  output.set(indexBytes, 0);
  output[indexBytes.byteLength] = INGEST_SEPARATOR;
  output.set(payload, indexBytes.byteLength + 1);

  return output;
}

export function encodedIngestBodyByteLength(index: BatchIndex, payloadBytes: number): number {
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes < 0) {
    throw new WireError("ingest payload byte length must be a non-negative integer");
  }
  return utf8Encoder.encode(JSON.stringify(index)).byteLength + 1 + payloadBytes;
}

export function decodeIngestBody(bytes: Uint8Array): {
  index: BatchIndex;
  payload: Uint8Array;
} {
  const separatorIndex = findIngestSeparator(bytes);
  const indexBytes = bytes.subarray(0, separatorIndex);
  const index = parseBatchIndex(indexBytes);

  return {
    index,
    payload: bytes.subarray(separatorIndex + 1),
  };
}

export function buildSegment(batches: readonly Uint8Array[]): Uint8Array {
  if (batches.length === 0) {
    throw new WireError("segment must contain at least one batch");
  }

  if (batches.length > MAX_BATCHES_PER_SEGMENT) {
    throw new WireError(`segment batch count must be at most ${MAX_BATCHES_PER_SEGMENT}`);
  }

  const dataBytes = sumBatchBytes(batches);
  const headerBytes = SEGMENT_HEADER_BYTES + batches.length * U32_BYTES;
  const output = new Uint8Array(headerBytes + dataBytes);
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength);

  output.set(SEGMENT_MAGIC, 0);
  view.setUint32(4, batches.length, true);

  let dataOffset = 0;
  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    if (batch === undefined || batch.byteLength === 0) {
      throw new WireError("segment batch cannot be empty");
    }

    view.setUint32(SEGMENT_HEADER_BYTES + i * U32_BYTES, dataOffset, true);
    output.set(batch, headerBytes + dataOffset);
    dataOffset += batch.byteLength;
  }

  return output;
}

export function parseSegment(bytes: Uint8Array): {
  count: number;
  offsets: number[];
  data: Uint8Array;
} {
  if (bytes.byteLength < SEGMENT_HEADER_BYTES) {
    throw new WireError("segment header is truncated");
  }

  if (!hasSegmentMagic(bytes)) {
    throw new WireError("segment magic must be ORS1");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(4, true);

  if (count < 1 || count > MAX_BATCHES_PER_SEGMENT) {
    throw new WireError(`segment batch count must be between 1 and ${MAX_BATCHES_PER_SEGMENT}`);
  }

  const headerBytes = SEGMENT_HEADER_BYTES + count * U32_BYTES;
  if (bytes.byteLength < headerBytes) {
    throw new WireError("segment header is truncated");
  }

  const data = bytes.subarray(headerBytes);
  const offsets = readSegmentOffsets(view, count, data.byteLength);

  return { count, offsets, data };
}

export function segmentBatch(
  parsed: { count: number; offsets: readonly number[]; data: Uint8Array },
  i: number,
): Uint8Array {
  if (!Number.isInteger(i) || i < 0 || i >= parsed.count) {
    throw new WireError("segment batch index is out of range");
  }

  const start = parsed.offsets[i];
  if (start === undefined) {
    throw new WireError("segment batch index is out of range");
  }

  const nextOffset = parsed.offsets[i + 1];
  const end = nextOffset === undefined ? parsed.data.byteLength : nextOffset;

  return parsed.data.subarray(start, end);
}

function findIngestSeparator(bytes: Uint8Array): number {
  const scanLimit = Math.min(bytes.byteLength, MAX_INDEX_JSON_BYTES + 1);

  for (let i = 0; i < scanLimit; i += 1) {
    if (bytes[i] === INGEST_SEPARATOR) {
      return i;
    }
  }

  if (bytes.byteLength > MAX_INDEX_JSON_BYTES) {
    throw new WireError(`ingest index JSON exceeds ${MAX_INDEX_JSON_BYTES} bytes`);
  }

  throw new WireError("ingest body separator is missing");
}

function parseBatchIndex(indexBytes: Uint8Array): BatchIndex {
  let text: string;
  try {
    text = utf8Decoder.decode(indexBytes);
  } catch {
    throw new WireError("ingest index JSON is not valid UTF-8");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new WireError("ingest index JSON is not valid JSON");
  }

  assertBatchIndex(parsed);
  return parsed;
}

function assertBatchIndex(value: unknown): asserts value is BatchIndex {
  if (!isRecord(value)) {
    throw new WireError("ingest index must be an object");
  }

  if (value.v !== 1) {
    throw new WireError("ingest index version must be 1");
  }

  if (typeof value.s !== "string") {
    throw new WireError("ingest index session id must be a string");
  }

  if (typeof value.tab !== "string") {
    throw new WireError("ingest index tab id must be a string");
  }

  const seq = value.seq;
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0 || seq > MAX_SEQ) {
    throw new WireError(`ingest index seq must be an integer from 0 to ${MAX_SEQ}`);
  }

  const t0 = value.t0;
  const t1 = value.t1;
  if (
    typeof t0 !== "number" ||
    typeof t1 !== "number" ||
    !Number.isFinite(t0) ||
    !Number.isFinite(t1)
  ) {
    throw new WireError("ingest index t0 and t1 must be numbers");
  }

  if (t0 > t1) {
    throw new WireError("ingest index t0 must be less than or equal to t1");
  }

  if (!Array.isArray(value.e)) {
    throw new WireError("ingest index events must be an array");
  }

  const checkpointTimestamps = value.checkpointTimestamps;
  if (checkpointTimestamps !== undefined) {
    if (
      !Array.isArray(checkpointTimestamps) ||
      checkpointTimestamps.length > MAX_CHECKPOINTS_PER_BATCH ||
      checkpointTimestamps.some(
        (timestamp) =>
          typeof timestamp !== "number" ||
          !Number.isFinite(timestamp) ||
          timestamp < t0 ||
          timestamp > t1,
      )
    ) {
      throw new WireError("ingest index checkpoints must be inside the batch time range");
    }
  }
}

function sumBatchBytes(batches: readonly Uint8Array[]): number {
  let total = 0;
  for (const batch of batches) {
    total += batch.byteLength;
  }
  return total;
}

function hasSegmentMagic(bytes: Uint8Array): boolean {
  return (
    bytes[0] === SEGMENT_MAGIC[0] &&
    bytes[1] === SEGMENT_MAGIC[1] &&
    bytes[2] === SEGMENT_MAGIC[2] &&
    bytes[3] === SEGMENT_MAGIC[3]
  );
}

function readSegmentOffsets(view: DataView, count: number, dataBytes: number): number[] {
  const offsets: number[] = [];
  let previous = -1;

  for (let i = 0; i < count; i += 1) {
    const offset = view.getUint32(SEGMENT_HEADER_BYTES + i * U32_BYTES, true);

    if (i === 0 && offset !== 0) {
      throw new WireError("segment first offset must be 0");
    }

    if (offset <= previous) {
      throw new WireError("segment offsets must be strictly increasing");
    }

    if (offset >= dataBytes) {
      throw new WireError("segment offset is outside data bounds");
    }

    offsets.push(offset);
    previous = offset;
  }

  return offsets;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
