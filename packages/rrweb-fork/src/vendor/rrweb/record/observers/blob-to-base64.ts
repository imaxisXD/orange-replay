import { yieldForPaint } from "../../../rrweb-snapshot/index.ts";

const BASE64_CHUNK_BYTES = 32_766;

export async function blobToBase64(blob: Blob, win: Window): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let base64 = "";
  let sliceStartedAt = win.performance.now();
  for (let index = 0; index < bytes.length; index += BASE64_CHUNK_BYTES) {
    base64 += btoa(String.fromCharCode(...bytes.subarray(index, index + BASE64_CHUNK_BYTES)));
    if (win.performance.now() - sliceStartedAt >= 4 && index + BASE64_CHUNK_BYTES < bytes.length) {
      await yieldForPaint(win);
      sliceStartedAt = win.performance.now();
    }
  }
  return base64;
}
