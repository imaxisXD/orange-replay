import { HDR_REQUEST_ID, LIVE_TICKET_TTL_MS } from "@orange-replay/shared";
import type { LiveTicketResponse } from "@orange-replay/shared";
import { shardDb, type Env } from "../env.ts";
import { readStoredProjectConfig } from "./project-config.ts";
import { jsonError, jsonResponse, withSecurityHeaders } from "./http.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const LIVE_AUTH_HEADER = "x-or-live-auth";
const MIN_LIVE_TICKET_SECRET_LENGTH = 32;

export async function mintLiveTicket(
  env: Env,
  projectId: string,
  sessionId: string,
): Promise<Response> {
  const liveTicketSecret = readLiveTicketSecret(env);
  if (liveTicketSecret === null) {
    return jsonError("auth_not_configured", 503);
  }

  if (await sessionDeletionIsPending(env, projectId, sessionId)) {
    return jsonError("not_found", 404);
  }

  const expiresAt = Date.now() + LIVE_TICKET_TTL_MS;
  const signature = await signLiveTicket(liveTicketSecret, projectId, sessionId, expiresAt);
  const ticketBody = `${expiresAt}.${base64UrlEncode(signature)}`;
  return jsonResponse({
    ticket: base64UrlEncode(encoder.encode(ticketBody)),
    expiresAt,
  } satisfies LiveTicketResponse);
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
  const response = await stub.fetch(new Request(request, { headers }));
  return response.status === 101 ? response : withSecurityHeaders(response);
}

async function verifyLiveTicketRequest(
  url: URL,
  env: Env,
  projectId: string,
  sessionId: string,
): Promise<{ ok: true } | { ok: false }> {
  if (url.searchParams.has("token")) {
    return { ok: false };
  }

  const ticket = url.searchParams.get("ticket");
  const liveTicketSecret = readLiveTicketSecret(env);
  if (ticket === null || ticket.length === 0 || liveTicketSecret === null) {
    return { ok: false };
  }

  const decoded = base64UrlDecode(ticket);
  if (decoded === null) return { ok: false };

  const body = decoder.decode(decoded);
  const separator = body.indexOf(".");
  if (separator < 1 || separator === body.length - 1) {
    return { ok: false };
  }

  const expiresAt = Number(body.slice(0, separator));
  const signature = base64UrlDecode(body.slice(separator + 1));
  if (!Number.isSafeInteger(expiresAt) || signature === null || Date.now() > expiresAt) {
    return { ok: false };
  }

  const key = await liveTicketKey(liveTicketSecret, ["verify"]);
  const message = liveTicketMessage(projectId, sessionId, expiresAt);
  const ok = await crypto.subtle.verify("HMAC", key, signature, message);
  return ok ? { ok: true } : { ok: false };
}

async function signLiveTicket(
  liveTicketSecret: string,
  projectId: string,
  sessionId: string,
  expiresAt: number,
): Promise<Uint8Array> {
  const key = await liveTicketKey(liveTicketSecret, ["sign"]);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    liveTicketMessage(projectId, sessionId, expiresAt),
  );
  return new Uint8Array(signature);
}

function liveTicketMessage(projectId: string, sessionId: string, expiresAt: number): Uint8Array {
  return encoder.encode(`${projectId}:${sessionId}:${expiresAt}`);
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
