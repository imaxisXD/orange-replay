import type { ReplayEvent } from "./types.ts";

const textDecoder = new TextDecoder("utf-8", { fatal: true });

export async function decodeBatchBytes(payload: Uint8Array): Promise<ReplayEvent[]> {
  const plainBytes = await gunzipOrPlain(payload);
  const text = textDecoder.decode(plainBytes);
  const parsed = JSON.parse(text) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error("Replay batch JSON must be an array.");
  }

  return parsed as ReplayEvent[];
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

    const buffer = await new Response(
      body.pipeThrough(new DecompressionStream("gzip")),
    ).arrayBuffer();
    return new Uint8Array(buffer);
  } catch {
    return payload;
  }
}
