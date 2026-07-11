import type { EdgeAttrs } from "@orange-replay/shared";

export function browserOriginIsAllowed(
  request: Request,
  allowedOrigins: readonly string[],
): boolean {
  if (allowedOrigins.includes("*")) {
    return true;
  }

  const origin = request.headers.get("origin");
  return origin !== null && allowedOrigins.includes(origin);
}

export function attrsFromRequest(request: Request): EdgeAttrs {
  const cf = request.cf as Record<string, unknown> | undefined;
  const userAgent = request.headers.get("user-agent") ?? "";
  const deviceInfo = attrsFromUserAgent(userAgent);

  return {
    ...(cf === undefined
      ? {}
      : {
          country: readString(cf["country"]),
          region: readString(cf["regionCode"]),
          city: readString(cf["city"]),
          asn: readNumber(cf["asn"]),
        }),
    ...deviceInfo,
  };
}

function attrsFromUserAgent(userAgent: string): Pick<EdgeAttrs, "browser" | "os" | "device"> {
  if (userAgent.length === 0) {
    return {};
  }

  return {
    browser: browserFromUserAgent(userAgent),
    os: osFromUserAgent(userAgent),
    device: deviceFromUserAgent(userAgent),
  };
}

function browserFromUserAgent(userAgent: string): string | undefined {
  if (userAgent.includes("Edg/")) return "Edge";
  if (userAgent.includes("Chrome/") || userAgent.includes("CriOS/")) return "Chrome";
  if (userAgent.includes("Firefox/") || userAgent.includes("FxiOS/")) return "Firefox";
  if (userAgent.includes("Safari/")) return "Safari";
  return undefined;
}

function osFromUserAgent(userAgent: string): string | undefined {
  if (userAgent.includes("Windows NT")) return "Windows";
  if (userAgent.includes("Mac OS X")) return "macOS";
  if (userAgent.includes("Android")) return "Android";
  if (userAgent.includes("iPhone") || userAgent.includes("iPad")) return "iOS";
  if (userAgent.includes("Linux")) return "Linux";
  return undefined;
}

function deviceFromUserAgent(userAgent: string): string | undefined {
  if (userAgent.includes("iPad") || userAgent.includes("Tablet")) return "tablet";
  if (
    userAgent.includes("Mobile") ||
    userAgent.includes("Android") ||
    userAgent.includes("iPhone")
  ) {
    return "mobile";
  }
  return "desktop";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
