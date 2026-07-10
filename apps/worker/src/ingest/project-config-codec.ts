import { projectConfigSchema, type ProjectConfig } from "@orange-replay/shared";

export interface ProjectConfigRow {
  projectId: unknown;
  active: unknown;
  orgId: unknown;
  retentionDays: unknown;
  jurisdiction: unknown;
  sampleRate: unknown;
  allowedOrigins: unknown;
  maskPolicyVersion: unknown;
  maskRules?: unknown;
  capture?: unknown;
  quotaState: unknown;
  shard: unknown;
  version?: unknown;
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
    maskRules: parseJsonValue(row.maskRules),
    capture: parseJsonValue(row.capture),
    quotaState: row.quotaState,
    retentionDays: row.retentionDays,
    version: row.version,
    ...(jurisdiction === undefined ? {} : { jurisdiction }),
  };

  return parseProjectConfig(candidate);
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
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
