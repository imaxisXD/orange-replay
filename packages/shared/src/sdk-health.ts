export const SDK_HEALTH_PROTOCOL_VERSION = 1 as const;

export const SDK_HEALTH_CODES = [
  "bundle_load_failed",
  "config_failed",
  "worker_blocked",
  "ingest_rejected",
  "pipeline_stopped",
] as const;

export type SdkHealthCode = (typeof SDK_HEALTH_CODES)[number];

export interface SdkHealthReport {
  version: typeof SDK_HEALTH_PROTOCOL_VERSION;
  code: SdkHealthCode;
}

const SDK_HEALTH_CODE_SET = new Set<string>(SDK_HEALTH_CODES);

export function parseSdkHealthReport(value: unknown): SdkHealthReport | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const report = value as Record<string, unknown>;
  if (Object.keys(report).length !== 2) return null;
  if (report["version"] !== SDK_HEALTH_PROTOCOL_VERSION) return null;
  const code = report["code"];
  if (typeof code !== "string" || !SDK_HEALTH_CODE_SET.has(code)) return null;
  return { version: SDK_HEALTH_PROTOCOL_VERSION, code: code as SdkHealthCode };
}
