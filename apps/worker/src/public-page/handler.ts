import { renderPublicPage } from "@orange-replay/public-page/server";
import { startWideEvent, uuidv7 } from "@orange-replay/shared";
import type { Env } from "../env.ts";
import { isValidPathId, outcomeForStatus } from "../query/session-query.ts";
import { publicPageRateLimitAllows, readPublicPageData } from "./data.ts";

const PUBLIC_PAGE_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

export function publicPageIdFromPath(pathname: string): string | null {
  const match = /^\/p\/([^/]+)$/.exec(pathname);
  return match?.[1] ?? null;
}

export async function handlePublicPage(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const requestId = uuidv7();
  const wideEvent = startWideEvent("worker", "public_page.request", requestId);
  let statusCode = 500;

  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      const response = publicHtmlError("Method not allowed.", 405);
      statusCode = response.status;
      return response;
    }

    const publicId = publicPageIdFromPath(url.pathname);
    if (publicId === null || !isValidPathId(publicId)) {
      const response = publicHtmlError("Public page not found.", 404);
      statusCode = response.status;
      return response;
    }
    wideEvent.set({ route: "public_page_html", public_id: publicId, auth_mode: "public" });

    if (!(await publicPageRateLimitAllows(env, request))) {
      wideEvent.set({ rate_limit: "public_page" });
      const response = publicHtmlError("Please wait before trying again.", 429);
      statusCode = response.status;
      return response;
    }

    const result = await readPublicPageData(url, env, ctx, publicId, requestId, wideEvent);
    if (!result.ok) {
      await result.response.body?.cancel();
      const response = publicHtmlError(
        result.response.status === 404
          ? "Public page not found."
          : "This public page is temporarily unavailable.",
        result.response.status,
      );
      statusCode = response.status;
      return response;
    }

    const headers = publicHtmlHeaders();
    const response =
      request.method === "HEAD"
        ? new Response(null, { headers })
        : new Response(await renderPublicPage(result.data), { headers });
    statusCode = response.status;
    return response;
  } catch (error) {
    wideEvent.fail(error);
    const response = publicHtmlError("This public page is temporarily unavailable.", 500);
    statusCode = response.status;
    return response;
  } finally {
    wideEvent.set({ method: request.method, status_code: statusCode });
    wideEvent.emit(outcomeForStatus(statusCode));
  }
}

function publicHtmlError(message: string, status: number): Response {
  const headers = publicHtmlHeaders();
  headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  if (status === 405) headers.set("allow", "GET, HEAD");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Orange Replay</title></head><body><main><h1>${message}</h1></main></body></html>`,
    { status, headers },
  );
}

function publicHtmlHeaders(): Headers {
  return new Headers({
    "cache-control": "no-store",
    "content-security-policy": PUBLIC_PAGE_CONTENT_SECURITY_POLICY,
    "content-type": "text/html; charset=utf-8",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
}
