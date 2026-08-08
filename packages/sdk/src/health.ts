import { HDR_KEY, SDK_HEALTH_PROTOCOL_VERSION, type SdkHealthCode } from "@orange-replay/shared";
import type { RecorderConfig } from "./types.ts";

export type SdkHealthReporter = (code: SdkHealthCode) => void;

export function createSdkHealthReporter(
  config: Pick<RecorderConfig, "ingestUrl" | "key">,
  fetchFn: typeof fetch,
): SdkHealthReporter {
  let reportStarted = false;

  return (code) => {
    if (reportStarted) return;
    reportStarted = true;
    try {
      void fetchFn(`${config.ingestUrl}/v1/sdk-health`, {
        method: "POST",
        headers: { "content-type": "application/json", [HDR_KEY]: config.key },
        body: JSON.stringify({ version: SDK_HEALTH_PROTOCOL_VERSION, code }),
        cache: "no-store",
        credentials: "omit",
        keepalive: true,
      }).catch(() => undefined);
    } catch {
      // Health reporting must never affect the customer page.
    }
  };
}
