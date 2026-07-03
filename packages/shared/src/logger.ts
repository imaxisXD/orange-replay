export type WideEventOutcome = "success" | "client_error" | "server_error" | "dropped";

export interface WideEventLogger {
  set(fields: Record<string, unknown>): void;
  fail(err: unknown): void;
  emit(outcome?: WideEventOutcome): void;
}

declare global {
  var __OR_VERSION__: string | undefined;
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
        version: globalThis.__OR_VERSION__ ?? "dev",
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
      error_name: err.name,
      error_message: err.message,
    };
  }

  return {
    error_message: String(err),
  };
}
