import {
  HDR_FLAGS,
  HDR_KEY,
  HDR_REQUEST_ID,
  HDR_SEQ,
  HDR_SESSION,
  HDR_TAB,
  MAX_COMPRESSED_BATCH_BYTES,
  MAX_INDEX_JSON_BYTES,
  MAX_SEQ,
  projectConfigSchema,
} from "@orange-replay/shared";
import type { BatchIndex, IndexEvent, IndexEventKind, ProjectConfig } from "@orange-replay/shared";

export const MAX_INGEST_BODY_BYTES = MAX_COMPRESSED_BATCH_BYTES + MAX_INDEX_JSON_BYTES;

export const INGEST_PREFLIGHT_HEADERS = {
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-allow-headers": [
    "content-type",
    HDR_KEY,
    HDR_SESSION,
    HDR_TAB,
    HDR_SEQ,
    HDR_FLAGS,
    HDR_REQUEST_ID,
  ].join(", "),
  "access-control-max-age": "86400",
} as const;

export const JSON_SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const;

export function ingestPreflightHeaders(request: Request): Headers {
  const headers = new Headers(INGEST_PREFLIGHT_HEADERS);
  const origin = request.headers.get("origin");
  headers.set("access-control-allow-origin", origin ?? "*");
  if (origin !== null) {
    headers.set("vary", "Origin");
  }
  return headers;
}

export function ingestPostHeaders(request: Request, allowedOrigins?: readonly string[]): Headers {
  const headers = new Headers(JSON_SECURITY_HEADERS);

  if (allowedOrigins === undefined || allowedOrigins.length === 0 || allowedOrigins.includes("*")) {
    headers.set("access-control-allow-origin", "*");
    return headers;
  }

  const origin = request.headers.get("origin");
  if (origin !== null && allowedOrigins.includes(origin)) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
  }

  return headers;
}

export interface ValidIngestHeaders {
  key: string;
  sessionId: string;
  tab: string;
  seq: number;
  flags: number;
}

export type HeaderValidationResult =
  | { ok: true; value: ValidIngestHeaders }
  | { ok: false; error: string };

export interface ProjectConfigRow {
  projectId: unknown;
  active: unknown;
  orgId: unknown;
  retentionDays: unknown;
  jurisdiction: unknown;
  sampleRate: unknown;
  allowedOrigins: unknown;
  maskPolicyVersion: unknown;
  quotaState: unknown;
  shard: unknown;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const TAB_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const INTEGER_PATTERN = /^[0-9]+$/;
const MAX_EVENTS_PER_BATCH = 200;
const MAX_EVENT_DETAIL_CHARS = 200;
const MAX_EVENT_META_KEYS = 16;
const INDEX_EVENT_KINDS = new Set<IndexEventKind>([
  "click",
  "rage",
  "error",
  "nav",
  "custom",
  "input",
  "scroll",
  "vital",
]);

const encoder = new TextEncoder();

export function validateIngestHeaders(headers: Headers): HeaderValidationResult {
  const key = headers.get(HDR_KEY);
  if (key === null || key.length === 0) {
    return { ok: false, error: `${HDR_KEY} is required` };
  }

  const sessionId = headers.get(HDR_SESSION);
  if (sessionId === null || !SESSION_ID_PATTERN.test(sessionId)) {
    return {
      ok: false,
      error: `${HDR_SESSION} must be 16 to 64 letters, numbers, underscores, or dashes`,
    };
  }

  const tab = headers.get(HDR_TAB);
  if (tab === null || !TAB_ID_PATTERN.test(tab)) {
    return {
      ok: false,
      error: `${HDR_TAB} must be 1 to 32 letters, numbers, underscores, or dashes`,
    };
  }

  const seq = readIntegerHeader(headers, HDR_SEQ, 0, MAX_SEQ);
  if (seq === null) {
    return { ok: false, error: `${HDR_SEQ} must be an integer from 0 to ${MAX_SEQ}` };
  }

  const rawFlags = headers.get(HDR_FLAGS);
  const flags = rawFlags === null ? 0 : readIntegerHeader(headers, HDR_FLAGS, 0);
  if (flags === null) {
    return { ok: false, error: `${HDR_FLAGS} must be a non-negative integer` };
  }

  return { ok: true, value: { key, sessionId, tab, seq, flags } };
}

export function readContentLength(
  headers: Headers,
): { ok: true; value: number } | { ok: false; malformed: boolean; error: string } {
  const raw = headers.get("content-length");
  if (raw === null) {
    return { ok: false, malformed: false, error: "content-length is absent" };
  }
  if (!INTEGER_PATTERN.test(raw)) {
    return { ok: false, malformed: true, error: "content-length must be a valid integer" };
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    return { ok: false, malformed: true, error: "content-length must be a valid integer" };
  }

  return { ok: true, value };
}

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

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export function parseProjectConfig(value: unknown): ProjectConfig | null {
  const parsed = projectConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function mapConfigRowToProjectConfig(row: ProjectConfigRow | null): ProjectConfig | null {
  if (row === null) {
    return null;
  }

  const active = activeFlagToBoolean(row.active);
  const allowedOrigins = parseAllowedOrigins(row.allowedOrigins);
  const jurisdiction = nullableString(row.jurisdiction);

  if (active === null || allowedOrigins === null || jurisdiction === null) {
    return null;
  }

  const candidate = {
    projectId: row.projectId,
    orgId: row.orgId,
    shard: row.shard,
    active,
    sampleRate: row.sampleRate,
    allowedOrigins,
    maskPolicyVersion: row.maskPolicyVersion,
    quotaState: row.quotaState,
    retentionDays: row.retentionDays,
    ...(jurisdiction === undefined ? {} : { jurisdiction }),
  };

  return parseProjectConfig(candidate);
}

export function sanitizeBatchIndexEvents(index: BatchIndex): {
  index: BatchIndex;
  eventsDropped: number;
} {
  const events: IndexEvent[] = [];
  let eventsDropped = 0;

  for (const event of index.e as unknown[]) {
    if (events.length >= MAX_EVENTS_PER_BATCH) {
      eventsDropped += 1;
      continue;
    }

    const cleanEvent = sanitizeIndexEvent(event);
    if (cleanEvent === null) {
      eventsDropped += 1;
      continue;
    }

    events.push(cleanEvent);
  }

  return { index: { ...index, e: events }, eventsDropped };
}

function readIntegerHeader(
  headers: Headers,
  name: string,
  min: number,
  max?: number,
): number | null {
  const raw = headers.get(name);
  if (raw === null || !INTEGER_PATTERN.test(raw)) {
    return null;
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) {
    return null;
  }

  if (max !== undefined && value > max) {
    return null;
  }

  return value;
}

function activeFlagToBoolean(value: unknown): boolean | null {
  if (value === 1 || value === true) {
    return true;
  }

  if (value === 0 || value === false) {
    return false;
  }

  return null;
}

function parseAllowedOrigins(value: unknown): string[] | null {
  if (typeof value !== "string") {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    return null;
  }

  return parsed;
}

function nullableString(value: unknown): string | undefined | null {
  if (value === null || value === undefined) {
    return undefined;
  }

  return typeof value === "string" ? value : null;
}

function sanitizeIndexEvent(value: unknown): IndexEvent | null {
  if (!isRecord(value)) {
    return null;
  }

  const t = value["t"];
  const k = value["k"];
  if (typeof t !== "number" || !Number.isFinite(t)) {
    return null;
  }
  if (typeof k !== "string" || !INDEX_EVENT_KINDS.has(k as IndexEventKind)) {
    return null;
  }

  const event: IndexEvent = { t, k: k as IndexEventKind };
  const detail = value["d"];
  if (typeof detail === "string") {
    event.d = detail.slice(0, MAX_EVENT_DETAIL_CHARS);
  }

  const meta = sanitizeEventMeta(value["m"]);
  if (meta !== undefined) {
    event.m = meta;
  }

  return event;
}

function sanitizeEventMeta(value: unknown): Record<string, string | number> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value);
  if (entries.length > MAX_EVENT_META_KEYS) {
    return undefined;
  }

  const output: Record<string, string | number> = {};
  for (const [key, item] of entries) {
    if (typeof item !== "string" && typeof item !== "number") {
      return undefined;
    }

    if (typeof item === "number" && !Number.isFinite(item)) {
      return undefined;
    }

    output[key] = item;
  }

  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bytesToHex(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) {
    output += byte.toString(16).padStart(2, "0");
  }
  return output;
}
