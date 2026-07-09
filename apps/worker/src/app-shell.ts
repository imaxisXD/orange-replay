import { startWideEvent, uuidv7 } from "@orange-replay/shared";
import type { Env } from "./env.ts";

const DASHBOARD_APP_SHELL_PATH = "/dashboard/index.html";
const JSON_SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
} as const;

export async function serveDashboardAppShell(
  request: Request,
  env: Pick<Env, "ASSETS">,
  pathname: string,
): Promise<Response> {
  const event = startWideEvent("worker", "http.dashboard_shell", uuidv7());
  let statusCode = 500;
  let outcome: "success" | "client_error" | "server_error" = "server_error";
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      statusCode = 404;
      outcome = "client_error";
      return Response.json(
        { error: "not_found" },
        { status: statusCode, headers: JSON_SECURITY_HEADERS },
      );
    }

    if (env.ASSETS === undefined) {
      statusCode = 404;
      outcome = "client_error";
      return Response.json(
        { error: "not_found" },
        { status: statusCode, headers: JSON_SECURITY_HEADERS },
      );
    }

    const assetRequest = dashboardAppShellRequest(request);
    const assetResponse = await env.ASSETS.fetch(assetRequest);
    statusCode = assetResponse.status;
    outcome = statusCode < 400 ? "success" : statusCode < 500 ? "client_error" : "server_error";

    const headers = new Headers(assetResponse.headers);
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "no-referrer");
    return new Response(assetResponse.body, {
      headers,
      status: assetResponse.status,
      statusText: assetResponse.statusText,
    });
  } catch (error) {
    event.fail(error);
    throw error;
  } finally {
    event.set({
      route: safeRoutePath(pathname),
      method: request.method,
      status_code: statusCode,
    });
    event.emit(outcome);
  }
}

export function isDashboardAppRoute(pathname: string): boolean {
  return pathname === "/login" || pathname === "/projects" || pathname.startsWith("/projects/");
}

function dashboardAppShellRequest(request: Request): Request {
  const assetUrl = new URL(request.url);
  assetUrl.pathname = DASHBOARD_APP_SHELL_PATH;
  assetUrl.search = "";
  return new Request(assetUrl, {
    headers: request.headers,
    method: request.method,
  });
}

function safeRoutePath(pathname: string): string {
  return pathname.length <= 200 ? pathname : pathname.slice(0, 200);
}
