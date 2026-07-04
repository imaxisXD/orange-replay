export type WideEventOutcome =
  | "success"
  | "client_error"
  | "server_error"
  | "dropped"
  | "rate_limited";

export interface WideEventLogger {
  set(fields: Record<string, unknown>): void;
  fail(err: unknown): void;
  emit(outcome?: WideEventOutcome): void;
}

declare global {
  var __OR_VERSION__: string | undefined;
}

const DEFAULT_VERSION = "dev";
const MAX_ERROR_FIELD_CHARS = 500;

export function setWideEventVersion(version: string | null | undefined): void {
  globalThis.__OR_VERSION__ =
    typeof version === "string" && version.trim().length > 0 ? version : DEFAULT_VERSION;
}

export function startWideEvent(
  service: string,
  event: string,
  requestId?: string,
): WideEventLogger {
  const startedAt = nowMs();
  const fields: Record<string, unknown> = {};
  let failed = false;
  let emitted = false;

  return {
    set(nextFields: Record<string, unknown>): void {
      for (const [key, value] of Object.entries(nextFields)) {
        fields[key] = value;
      }
    },

    fail(err: unknown): void {
      failed = true;
      const errorInfo = errorFields(err);
      for (const [key, value] of Object.entries(errorInfo)) {
        fields[key] = value;
      }
    },

    emit(outcome?: WideEventOutcome): void {
      if (emitted) {
        return;
      }

      emitted = true;
      const finalOutcome = outcome ?? (failed ? "server_error" : "success");
      const line = {
        ...fields,
        ts: new Date().toISOString(),
        service,
        event,
        request_id: requestId ?? "",
        outcome: finalOutcome,
        duration_ms: Math.max(0, nowMs() - startedAt),
        version: globalThis.__OR_VERSION__ ?? DEFAULT_VERSION,
      };
      const encodedLine = JSON.stringify(line);

      if (finalOutcome === "server_error") {
        console.error(encodedLine);
        return;
      }

      console.log(encodedLine);
    },
  };
}

function nowMs(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function errorFields(err: unknown): Record<string, string> {
  if (err instanceof Error) {
    return {
      error_name: truncateErrorField(err.name),
      error_message: truncateErrorField(err.message),
    };
  }

  return {
    error_message: truncateErrorField(String(err)),
  };
}

function truncateErrorField(value: string): string {
  return value.length <= MAX_ERROR_FIELD_CHARS ? value : value.slice(0, MAX_ERROR_FIELD_CHARS);
}
