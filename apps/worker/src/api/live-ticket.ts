import { HDR_REQUEST_ID, LIVE_TICKET_TTL_MS } from "@orange-replay/shared";
import type { LiveTicketResponse } from "@orange-replay/shared";
import { isDevTestMode, shardDb, type Env } from "../env.ts";
import { readStoredProjectConfig } from "../project-config/storage.ts";
import { jsonError, jsonResponse, withSecurityHeaders } from "./http.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const LIVE_AUTH_HEADER = "x-or-live-auth";
const LIVE_NONCE_HEADER = "x-or-live-nonce";
const LIVE_VIEWER_HEADER = "x-or-live-viewer";
const LIVE_EXPIRES_HEADER = "x-or-live-expires";
const MIN_LIVE_TICKET_SECRET_LENGTH = 32;
const LIVE_TICKET_VERSION = 2;

interface LiveTicketClaims {
  v: typeof LIVE_TICKET_VERSION;
  e: number;
  n: string;
  a: string;
}

export async function mintLiveTicket(
  env: Env,
  projectId: string,
  sessionId: string,
  viewerIdentity: string,
): Promise<Response> {
  const liveTicketSecret = readLiveTicketSecret(env);
  if (liveTicketSecret === null) {
    return jsonError("auth_not_configured", 503);
  }

  const viewerHash = await viewerIdentityHash(viewerIdentity);
  if (!(await liveTicketMintRateLimitAllows(env, viewerHash))) {
    return jsonError("rate_limited", 429, { "retry-after": "60" });
  }

  if (await sessionDeletionIsPending(env, projectId, sessionId)) {
    return jsonError("not_found", 404);
  }

  const expiresAt = Date.now() + LIVE_TICKET_TTL_MS;
  const claims: LiveTicketClaims = {
    v: LIVE_TICKET_VERSION,
    e: expiresAt,
    n: crypto.randomUUID(),
    a: viewerHash,
  };
  const claimsText = JSON.stringify(claims);
  const signature = await signLiveTicket(liveTicketSecret, projectId, sessionId, claimsText);
  const ticketBody = `${base64UrlEncode(encoder.encode(claimsText))}.${base64UrlEncode(signature)}`;
  return jsonResponse({
    ticket: ticketBody,
    expiresAt,
  } satisfies LiveTicketResponse);
}

async function liveTicketMintRateLimitAllows(env: Env, viewerHash: string): Promise<boolean> {
  if (isDevTestMode(env)) return true;
  const limiter = env.LIVE_TICKET_RATE_LIMITER;
  if (limiter === undefined) return false;
  try {
    return (await limiter.limit({ key: `live-ticket:${viewerHash}` })).success;
  } catch {
    return false;
  }
}

export async function proxyLiveSession(
  request: Request,
  url: URL,
  env: Env,
  projectId: string,
  sessionId: string,
  requestId: string,
): Promise<Response> {
  const ticket = await verifyLiveTicketRequest(url, env, projectId, sessionId);
  if (!ticket.ok) return jsonError("unauthorized", 401);

  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return jsonError("websocket_required", 426, { upgrade: "websocket" });
  }

  const config = await readStoredProjectConfig(env, projectId);
  if (config === null) return jsonError("not_found", 404);

  const namespace = config.jurisdiction
    ? env.SESSION.jurisdiction(config.jurisdiction)
    : env.SESSION;
  const stub = namespace.get(namespace.idFromName(`${projectId}:${sessionId}`));
  const headers = new Headers(request.headers);
  headers.set(HDR_REQUEST_ID, requestId);
  headers.set(LIVE_AUTH_HEADER, "ticket");
  headers.set(LIVE_NONCE_HEADER, ticket.claims.n);
  headers.set(LIVE_VIEWER_HEADER, ticket.claims.a);
  headers.set(LIVE_EXPIRES_HEADER, String(ticket.claims.e));
  const response = await stub.fetch(new Request(request, { headers }));
  return response.status === 101 ? response : withSecurityHeaders(response);
}

async function verifyLiveTicketRequest(
  url: URL,
  env: Env,
  projectId: string,
  sessionId: string,
): Promise<{ ok: true; claims: LiveTicketClaims } | { ok: false }> {
  if (url.searchParams.has("token")) {
    return { ok: false };
  }

  const ticket = url.searchParams.get("ticket");
  const liveTicketSecret = readLiveTicketSecret(env);
  if (ticket === null || ticket.length === 0 || liveTicketSecret === null) {
    return { ok: false };
  }

  const [encodedClaims, encodedSignature, extra] = ticket.split(".");
  if (encodedClaims === undefined || encodedSignature === undefined || extra !== undefined) {
    return { ok: false };
  }
  const claimsBytes = base64UrlDecode(encodedClaims);
  const signature = base64UrlDecode(encodedSignature);
  if (claimsBytes === null || signature === null) {
    return { ok: false };
  }
  const claimsText = decoder.decode(claimsBytes);
  const claims = parseLiveTicketClaims(claimsText);
  if (claims === null || Date.now() >= claims.e) return { ok: false };

  const key = await liveTicketKey(liveTicketSecret, ["verify"]);
  const message = liveTicketMessage(projectId, sessionId, claimsText);
  const ok = await crypto.subtle.verify("HMAC", key, signature, message);
  return ok ? { ok: true, claims } : { ok: false };
}

async function signLiveTicket(
  liveTicketSecret: string,
  projectId: string,
  sessionId: string,
  claimsText: string,
): Promise<Uint8Array> {
  const key = await liveTicketKey(liveTicketSecret, ["sign"]);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    liveTicketMessage(projectId, sessionId, claimsText),
  );
  return new Uint8Array(signature);
}

function liveTicketMessage(projectId: string, sessionId: string, claimsText: string): Uint8Array {
  return encoder.encode(`${projectId}:${sessionId}:${claimsText}`);
}

function parseLiveTicketClaims(value: string): LiveTicketClaims | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const claims = parsed as Partial<LiveTicketClaims>;
  if (
    claims.v !== LIVE_TICKET_VERSION ||
    !Number.isSafeInteger(claims.e) ||
    typeof claims.n !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(claims.n) ||
    typeof claims.a !== "string" ||
    !/^[0-9a-f]{64}$/.test(claims.a)
  ) {
    return null;
  }
  return claims as LiveTicketClaims;
}

async function viewerIdentityHash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(`live-viewer:${value}`));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function liveTicketKey(
  liveTicketSecret: string,
  usages: Array<"sign" | "verify">,
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(liveTicketSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

function readLiveTicketSecret(env: Pick<Env, "LIVE_TICKET_SECRET">): string | null {
  const secret = env.LIVE_TICKET_SECRET;
  if (typeof secret !== "string") {
    return null;
  }

  if (secret.length < MIN_LIVE_TICKET_SECRET_LENGTH || secret.trim() !== secret) {
    return null;
  }

  return secret;
}

async function sessionDeletionIsPending(
  env: Env,
  projectId: string,
  sessionId: string,
): Promise<boolean> {
  const row = await shardDb(env, 0)
    .prepare("SELECT 1 FROM session_deletions WHERE project_id = ? AND session_id = ? LIMIT 1")
    .bind(projectId, sessionId)
    .first();
  return row !== null;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }

  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");

  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}
