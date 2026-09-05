import { makeReplayEventValidatorSource } from "./replay-event-validation.ts";
import { REPLAY_DATA_LIMITS } from "@orange-replay/shared/constants";
import { MAX_REPLAY_JSON_TRAILING_WHITESPACE_CHARS } from "./worker-core.ts";

export function makeWorkerCoreSource(): string {
  return `
const MAX_DECODED_BATCH_BYTES = ${REPLAY_DATA_LIMITS.bytes};
const MAX_REPLAY_JSON_TRAILING_WHITESPACE_CHARS = ${MAX_REPLAY_JSON_TRAILING_WHITESPACE_CHARS};
const textDecoder = new TextDecoder("utf-8", { fatal: true });

${makeReplayEventValidatorSource()}

async function decodeBatchBytes(payload) {
  return (await decodeBatchWithStats(payload)).events;
}

async function decodeBatchWithStats(payload) {
  const plainBytes = await gunzipOrPlain(payload);
  assertDecodedSize(plainBytes.byteLength);
  const text = textDecoder.decode(plainBytes);
  assertJsonTrailingWhitespace(text);
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("Replay batch JSON must be an array.");
  return { decodedBytes: plainBytes.byteLength, events: validateReplayEvents(parsed) };
}

async function gunzipOrPlain(payload) {
  if (typeof DecompressionStream !== "function") return payload;
  try {
    const body = new Response(payload).body;
    if (body === null) return payload;
    return await readDecodedStream(body.pipeThrough(new DecompressionStream("gzip")));
  } catch (error) {
    if (isDecodeLimitError(error)) throw error;
    return payload;
  }
}

async function readDecodedStream(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      totalBytes += read.value.byteLength;
      assertDecodedSize(totalBytes);
      chunks.push(read.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const decoded = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    decoded.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decoded;
}

function assertDecodedSize(decodedBytes) {
  if (decodedBytes <= MAX_DECODED_BATCH_BYTES) return;
  const error = new Error("Replay batch is too large after decoding.");
  error.name = "ReplayDecodeLimitError";
  throw error;
}

function isDecodeLimitError(error) {
  return error instanceof Error && error.name === "ReplayDecodeLimitError";
}

function assertJsonTrailingWhitespace(text) {
  let index = text.length - 1;
  while (index >= 0 && isJsonWhitespace(text.charCodeAt(index))) index -= 1;
  if (text.length - index - 1 > MAX_REPLAY_JSON_TRAILING_WHITESPACE_CHARS) {
    throw new Error("Replay batch JSON has too much trailing whitespace.");
  }
}

function isJsonWhitespace(charCode) {
  return charCode === 0x20 || charCode === 0x0a || charCode === 0x0d || charCode === 0x09;
}
`;
}
