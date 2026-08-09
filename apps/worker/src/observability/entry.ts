import * as Sentry from "@sentry/cloudflare";
import { PresenceRegistry as PresenceRegistryBase } from "../do/presence-registry.ts";
import { SessionRecorder as SessionRecorderBase } from "../do/session-recorder.ts";
import { isDevTestMode, type Env, type WorkerQueueMessage } from "../env.ts";
import worker from "../index.ts";
import {
  instrumentDurableObjectWhenSentryEnabled,
  sentryEnabled,
  workerSentryOptions,
} from "./sentry.ts";

export const SessionRecorder = instrumentDurableObjectWhenSentryEnabled(SessionRecorderBase);
export const PresenceRegistry = instrumentDurableObjectWhenSentryEnabled(PresenceRegistryBase);

const sentryBoundary = {
  ...worker,
  fetch(request, env, ctx) {
    if (isSentryTestRequest(request, env)) {
      throw new Error("Orange Replay Sentry test error.");
    }
    return worker.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env, WorkerQueueMessage>;

const monitoredWorker = Sentry.withSentry<Env, WorkerQueueMessage, unknown, typeof sentryBoundary>(
  workerSentryOptions,
  sentryBoundary,
);

export default {
  fetch(request, env, ctx) {
    return (sentryEnabled(env) ? monitoredWorker : sentryBoundary).fetch(request, env, ctx);
  },
  queue(batch, env, ctx) {
    return (sentryEnabled(env) ? monitoredWorker : sentryBoundary).queue(batch, env, ctx);
  },
  scheduled(controller, env, ctx) {
    return (sentryEnabled(env) ? monitoredWorker : sentryBoundary).scheduled(controller, env, ctx);
  },
} satisfies ExportedHandler<Env, WorkerQueueMessage>;

function isSentryTestRequest(request: Request, env: Env): boolean {
  return isDevTestMode(env) && new URL(request.url).pathname === "/__test/sentry-error";
}
