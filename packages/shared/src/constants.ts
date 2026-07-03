export const HDR_KEY = "x-or-key";
export const HDR_SESSION = "x-or-session";
export const HDR_SEQ = "x-or-seq";
export const HDR_TAB = "x-or-tab";
export const HDR_FLAGS = "x-or-flags";
export const HDR_REQUEST_ID = "x-or-request-id";

export const FLAG_UNCOMPRESSED = 1 << 0;
export const FLAG_ENCRYPTED = 1 << 1;

export const MAX_COMPRESSED_BATCH_BYTES = 1024 * 1024;
export const MAX_INDEX_JSON_BYTES = 64 * 1024;
export const MAX_BATCHES_PER_SEGMENT = 4096;
export const MAX_SEQ = 10_000_000;

export const SDK_FLUSH_DEFAULT_MS = 15_000;
export const SDK_FLUSH_LIVE_MS = 4_000;
export const SEGMENT_FLUSH_BYTES = 1024 * 1024;
export const SEGMENT_FLUSH_INTERVAL_MS = 30_000;
export const FLUSH_TAIL_AFTER_IDLE_MS = 120_000;
export const CLOSE_SESSION_AFTER_IDLE_MS = 1_800_000;

export function sessionPrefix(projectId: string, sessionId: string): string {
  return `p/${projectId}/${sessionId}`;
}

export function segmentKey(projectId: string, sessionId: string, n: number): string {
  const segmentNumber = String(n).padStart(6, "0");
  return `${sessionPrefix(projectId, sessionId)}/seg-${segmentNumber}.ors`;
}

export function manifestKey(projectId: string, sessionId: string): string {
  return `${sessionPrefix(projectId, sessionId)}/manifest.json`;
}

export function configKvKey(keyHash: string): string {
  return `k:${keyHash}`;
}
