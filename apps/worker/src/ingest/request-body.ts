import { MAX_COMPRESSED_BATCH_BYTES, MAX_INDEX_JSON_BYTES } from "@orange-replay/shared";

export const MAX_INGEST_BODY_BYTES = MAX_COMPRESSED_BATCH_BYTES + MAX_INDEX_JSON_BYTES;

/**
 * Reads a request body while enforcing a byte cap — a chunked upload without
 * Content-Length can never buffer more than `cap` bytes. Returns null when
 * the cap is exceeded.
 */
export async function readBodyCapped(
  body: ReadableStream<Uint8Array> | null,
  cap: number,
): Promise<Uint8Array | null> {
  if (body === null) {
    return new Uint8Array(0);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
