import { MAX_COMPRESSED_BATCH_BYTES } from "@orange-replay/shared";

export function validatePayloadSize(payload: Uint8Array): {
  body: { error: string };
  status: number;
} | null {
  if (payload.byteLength === 0) {
    return { body: { error: "ingest payload is empty" }, status: 400 };
  }

  if (payload.byteLength > MAX_COMPRESSED_BATCH_BYTES) {
    return { body: { error: "ingest payload is too large" }, status: 413 };
  }

  return null;
}

export function indexMismatchError(
  index: { s: string; tab: string; seq: number },
  sessionId: string,
  tab: string,
  seq: number,
): string | null {
  if (index.s !== sessionId) {
    return "ingest index session does not match the session header";
  }

  if (index.tab !== tab) {
    return "ingest index tab does not match the tab header";
  }

  if (index.seq !== seq) {
    return "ingest index seq does not match the seq header";
  }

  return null;
}

export async function gzipPayload(payload: Uint8Array): Promise<Uint8Array> {
  const body = new Response(payload).body;
  if (body === null) {
    throw new Error("payload gzip failed");
  }

  const compressed = await new Response(
    body.pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();
  return new Uint8Array(compressed);
}
