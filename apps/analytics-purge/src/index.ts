import { Container, getContainer } from "@cloudflare/containers";
import type { StopParams } from "@cloudflare/containers";
import { setWideEventVersion, startWideEvent, uuidv7 } from "@orange-replay/shared";
import { redactedContainerError, startScheduledPurge } from "./scheduler.ts";

export class AnalyticsPurgeContainer extends Container<Env> {
  // The process exits on its own. Keep the SDK's inactivity stop beyond the
  // image's 40-minute hard limit so a healthy Spark run is not cut off early.
  sleepAfter = "45m";

  override onStop(params: StopParams): void {
    setWideEventVersion(this.env.CF_VERSION_METADATA?.tag ?? this.env.CF_VERSION_METADATA?.id);
    const event = startWideEvent("analytics-purge", "container.stop", uuidv7());
    event.set({ exit_code: params.exitCode, reason: params.reason });
    event.emit(params.exitCode === 0 && params.reason === "exit" ? "success" : "server_error");
  }

  override onError(error: unknown): unknown {
    setWideEventVersion(this.env.CF_VERSION_METADATA?.tag ?? this.env.CF_VERSION_METADATA?.id);
    const event = startWideEvent("analytics-purge", "container.error", uuidv7());
    event.fail(redactedContainerError(error, this.env));
    event.emit();
    return undefined;
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    setWideEventVersion(env.CF_VERSION_METADATA?.tag ?? env.CF_VERSION_METADATA?.id);
    const event = startWideEvent("analytics-purge", "http.not_found", uuidv7());
    try {
      return Response.json(
        { error: "not_found" },
        {
          status: 404,
          headers: {
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        },
      );
    } finally {
      event.set({ method: request.method, status_code: 404 });
      event.emit("client_error");
    }
  },

  async scheduled(controller, env): Promise<void> {
    await startScheduledPurge(env, controller.cron, getContainer(env.ANALYTICS_PURGE_CONTAINER));
  },
} satisfies ExportedHandler<Env>;
