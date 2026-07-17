import { MAX_DECODED_BATCH_EVENTS, validateReplayEvents } from "./replay-event-validation.ts";
import type { ReplayEvent } from "./types.ts";

export interface DecodedReplayEvents {
  events: ReplayEvent[];
  decodedBytes: number;
}

export const MAX_DECODED_BATCH_BYTES = 16 * 1024 * 1024;
export { MAX_DECODED_BATCH_EVENTS };
export const MAX_REPLAY_JSON_TRAILING_WHITESPACE_CHARS = 4096;
const MIN_DECODED_BATCH_BYTES = 1024 * 1024;
const MAX_DECODED_EXPANSION_RATIO = 32;
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
  return { decodedBytes: plainBytes.byteLength, events: validateReplayEvents(parsed) };
}

export function isReplayDataError(error: unknown): boolean {
  return error instanceof Error && error.name === "ReplayDataError";
}

async function gunzipOrPlain(payload: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== "function") return payload;
  try {
    const body = new Response(payload as unknown as BodyInit).body;
    if (body === null) return payload;
    return await readDecodedStream(body.pipeThrough(new DecompressionStream("gzip")), payload);
  } catch (error) {
    if (isDecodeLimitError(error)) throw error;
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
    if (read.done) break;
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
  if (decodedBytes <= decodedByteLimit(compressedPayload)) return;
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
  while (index >= 0 && isJsonWhitespace(text.charCodeAt(index))) index -= 1;
  if (text.length - index - 1 > MAX_REPLAY_JSON_TRAILING_WHITESPACE_CHARS) {
    throw new Error("Replay batch JSON has too much trailing whitespace.");
  }
}

function isJsonWhitespace(charCode: number): boolean {
  return charCode === 0x20 || charCode === 0x0a || charCode === 0x0d || charCode === 0x09;
}
