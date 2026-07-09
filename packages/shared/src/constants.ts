export const HDR_KEY = "x-or-key";
export const HDR_SESSION = "x-or-session";
export const HDR_SEQ = "x-or-seq";
export const HDR_TAB = "x-or-tab";
export const HDR_FLAGS = "x-or-flags";
export const HDR_REQUEST_ID = "x-or-request-id";

export const FLAG_UNCOMPRESSED = 1 << 0;
export const PERSISTED_REPLAY_FLAG_MASK = 0;
export const INGEST_HEADER_FLAG_MASK = FLAG_UNCOMPRESSED | PERSISTED_REPLAY_FLAG_MASK;

export const MAX_COMPRESSED_BATCH_BYTES = 1024 * 1024;
export const MAX_INDEX_JSON_BYTES = 64 * 1024;
export const MAX_CONFIG_UPDATE_BODY_BYTES = 64 * 1024;
export const MAX_PRESENCE_BODY_BYTES = 8 * 1024;
export const MAX_PRESENCE_ID_CHARS = 64;
export const MAX_PRESENCE_TEXT_CHARS = 2048;
export const MAX_BATCHES_PER_SEGMENT = 4096;
export const MAX_MANIFEST_SEGMENTS = 10_000;
export const MAX_SEQ = 10_000_000;

export const SDK_FLUSH_DEFAULT_MS = 15_000;
export const SDK_FLUSH_LIVE_MS = 4_000;
export const SEGMENT_FLUSH_BYTES = 1024 * 1024;
export const SEGMENT_FLUSH_INTERVAL_MS = 30_000;
export const FLUSH_TAIL_AFTER_IDLE_MS = 120_000;
export const CLOSE_SESSION_AFTER_IDLE_MS = 1_800_000;
export const PRESENCE_TTL_MS = 60_000;
export const PRESENCE_HEARTBEAT_MS = 20_000;
export const PRESENCE_SHARD_COUNT = 16;
export const SESSION_APPEND_RATE_LIMIT_COUNT = 30;
export const SESSION_APPEND_RATE_LIMIT_WINDOW_MS = 10_000;
export const LIVE_TICKET_TTL_MS = 60_000;
// Bounds per-viewer broadcast fan-out on a session DO; live tickets are reusable
// within their TTL, so this cap is what prevents unbounded socket replay.
export const MAX_LIVE_VIEWERS_PER_SESSION = 32;
export const PROJECT_CONFIG_CACHE_TTL_SECONDS = 60;

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
