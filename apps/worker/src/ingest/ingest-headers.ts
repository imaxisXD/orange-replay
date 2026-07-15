import {
  HDR_FLAGS,
  HDR_KEY,
  HDR_REQUEST_ID,
  HDR_SEQ,
  HDR_SESSION,
  HDR_TAB,
  INGEST_HEADER_FLAG_MASK,
  isValidSessionId,
  MAX_SEQ,
} from "@orange-replay/shared";

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

  if (allowedOrigins === undefined || allowedOrigins.includes("*")) {
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

const TAB_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const WRITE_KEY_PATTERN = /^or_live_[A-Za-z0-9_-]{32}$/;
const INTEGER_PATTERN = /^[0-9]+$/;

export function validateIngestHeaders(headers: Headers): HeaderValidationResult {
  const writeKey = validateWriteKeyHeader(headers);
  if (!writeKey.ok) return writeKey;
  const key = writeKey.value;

  const sessionId = headers.get(HDR_SESSION);
  if (sessionId === null || !isValidSessionId(sessionId)) {
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
  const flags =
    rawFlags === null ? 0 : readIntegerHeader(headers, HDR_FLAGS, 0, INGEST_HEADER_FLAG_MASK);
  if (flags === null) {
    return { ok: false, error: `${HDR_FLAGS} can only include supported ingest flags` };
  }

  return { ok: true, value: { key, sessionId, tab, seq, flags } };
}

export function validateWriteKeyHeader(
  headers: Headers,
): { ok: true; value: string } | { ok: false; error: string } {
  const key = headers.get(HDR_KEY);
  if (key === null || key.length === 0) {
    return { ok: false, error: `${HDR_KEY} is required` };
  }
  if (!WRITE_KEY_PATTERN.test(key)) {
    return {
      ok: false,
      error: `${HDR_KEY} must be a generated key like or_live_ plus 32 base64url characters`,
    };
  }
  return { ok: true, value: key };
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
