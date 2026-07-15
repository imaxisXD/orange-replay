import type { Env } from "../env.ts";

const AUTH_CONFIGURATION_KEYS = [
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_TRUSTED_ORIGINS",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
] as const;

const REQUIRED_AUTH_CONFIGURATION_KEYS = [
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "BETTER_AUTH_TRUSTED_ORIGINS",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
] as const;

export type AuthMode = "github" | "unavailable";

export interface HostedAuthConfig {
  baseUrl: string;
  secret: string;
  trustedOrigins: readonly string[];
  githubClientId: string;
  githubClientSecret: string;
  secureCookies: boolean;
}

export type HostedAuthStatus =
  | { state: "disabled" }
  | { state: "invalid"; problems: readonly string[] }
  | { state: "ready" };

type ParsedHostedAuthStatus =
  | Exclude<HostedAuthStatus, { state: "ready" }>
  | { state: "ready"; config: HostedAuthConfig };

export function getHostedAuthStatus(env: Env): HostedAuthStatus {
  const status = readHostedAuthStatus(env);
  return status.state === "ready" ? { state: "ready" } : status;
}

/** Contains secrets for server setup. Never return this value in an HTTP response. */
export function getHostedAuthConfig(env: Env): HostedAuthConfig | null {
  const status = readHostedAuthStatus(env);
  return status.state === "ready" ? status.config : null;
}

function readHostedAuthStatus(env: Env): ParsedHostedAuthStatus {
  const hasAnyAuthValue = AUTH_CONFIGURATION_KEYS.some((key) => readValue(env[key]) !== undefined);
  if (!hasAnyAuthValue) return { state: "disabled" };

  const problems: string[] = [];
  for (const key of REQUIRED_AUTH_CONFIGURATION_KEYS) {
    if (readValue(env[key]) === undefined) problems.push(`${key} is missing.`);
  }

  const secret = readValue(env.BETTER_AUTH_SECRET);
  if (secret !== undefined && secret.length < 32) {
    problems.push("BETTER_AUTH_SECRET must be at least 32 characters.");
  }

  const workerEnvironment = readValue(env.WORKER_ENV)?.toLowerCase();
  const needsSecureOrigin = workerEnvironment === "production";
  const baseUrl = readExactOrigin(
    env.BETTER_AUTH_URL,
    "BETTER_AUTH_URL",
    needsSecureOrigin,
    problems,
  );
  const trustedOrigins = readTrustedOrigins(
    env.BETTER_AUTH_TRUSTED_ORIGINS,
    needsSecureOrigin,
    problems,
  );
  if (baseUrl !== undefined && !trustedOrigins.includes(baseUrl)) {
    problems.push("BETTER_AUTH_TRUSTED_ORIGINS must include the BETTER_AUTH_URL origin.");
  }

  if (problems.length > 0) return { state: "invalid", problems };

  return {
    state: "ready",
    config: {
      baseUrl: requireValue(baseUrl),
      secret: requireValue(secret),
      trustedOrigins,
      githubClientId: requireValue(readValue(env.GITHUB_CLIENT_ID)),
      githubClientSecret: requireValue(readValue(env.GITHUB_CLIENT_SECRET)),
      secureCookies: requireValue(baseUrl).startsWith("https://"),
    },
  };
}

export function getAuthMode(env: Env): AuthMode {
  const status = getHostedAuthStatus(env);
  if (status.state === "ready") return "github";
  return "unavailable";
}

export function isHostedAuthConfigured(env: Env): boolean {
  return getHostedAuthStatus(env).state === "ready";
}

export function getTrustedOrigins(env: Env): readonly string[] {
  return getHostedAuthConfig(env)?.trustedOrigins ?? [];
}

export function isTrustedMutationOrigin(request: Request, env: Env): boolean {
  const origin = request.headers.get("origin");
  if (origin === null || !isExactOrigin(origin)) return false;
  return getTrustedOrigins(env).includes(origin);
}

function readTrustedOrigins(
  value: string | undefined,
  needsSecureOrigin: boolean,
  problems: string[],
): readonly string[] {
  const values = readList(value);
  const origins: string[] = [];
  for (const item of values) {
    const origin = readExactOrigin(
      item,
      "BETTER_AUTH_TRUSTED_ORIGINS",
      needsSecureOrigin,
      problems,
    );
    if (origin !== undefined && !origins.includes(origin)) origins.push(origin);
  }
  if (readValue(value) !== undefined && origins.length === 0) {
    problems.push("BETTER_AUTH_TRUSTED_ORIGINS must contain at least one exact origin.");
  }
  return origins;
}

function readExactOrigin(
  value: string | undefined,
  name: string,
  needsSecureOrigin: boolean,
  problems: string[],
): string | undefined {
  const candidate = readValue(value);
  if (candidate === undefined) return undefined;
  try {
    const url = new URL(candidate);
    const hasOnlyOrigin =
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.hostname.includes("*") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "";
    if (!hasOnlyOrigin) throw new Error("not an origin");
    if (needsSecureOrigin && url.protocol !== "https:") {
      problems.push(`${name} must use https in production.`);
      return undefined;
    }
    return url.origin;
  } catch {
    problems.push(`${name} must contain only exact http or https origins.`);
    return undefined;
  }
}

function isExactOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === value &&
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.hostname.includes("*") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function readList(value: string | undefined): readonly string[] {
  const items = value
    ?.split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return [...new Set(items ?? [])];
}

function readValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function requireValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Hosted auth configuration was not validated.");
  return value;
}
