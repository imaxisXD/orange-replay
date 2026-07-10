import { readBodyCapped, readContentLength } from "../ingest/helpers.ts";

const decoder = new TextDecoder();
const API_SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const;

export async function readJsonBodyCapped(
  request: Request,
  cap: number,
): Promise<
  | { ok: true; value: unknown }
  | {
      ok: false;
      status: 400 | 413;
      error: "invalid_content_length" | "body_too_large" | "invalid_json";
    }
> {
  const contentLength = readContentLength(request.headers);
  if (contentLength.ok && contentLength.value > cap) {
    return { ok: false, status: 413, error: "body_too_large" };
  }
  if (!contentLength.ok && contentLength.malformed) {
    return { ok: false, status: 400, error: "invalid_content_length" };
  }

  const bodyBytes = await readBodyCapped(request.body, cap);
  if (bodyBytes === null) {
    return { ok: false, status: 413, error: "body_too_large" };
  }

  try {
    return { ok: true, value: JSON.parse(decoder.decode(bodyBytes)) as unknown };
  } catch {
    return { ok: false, status: 400, error: "invalid_json" };
  }
}

export function jsonError(error: string, status: number, headers?: HeadersInit): Response {
  return jsonResponse({ error }, { status, headers });
}

export function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, {
    ...init,
    headers: secureHeaders(init?.headers),
  });
}

export function secureHeaders(headers?: HeadersInit): Headers {
  const next = new Headers(headers);
  for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) {
    next.set(name, value);
  }
  return next;
}

export function withSecurityHeaders(response: Response): Response {
  const headers = secureHeaders(response.headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
