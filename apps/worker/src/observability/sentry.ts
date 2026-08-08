import {
  privateMonitoringDataCollection,
  sanitizeMonitoringEvent,
  sanitizeMonitoringSpan,
} from "@orange-replay/shared/error-monitoring-privacy";
import * as Sentry from "@sentry/cloudflare";
import type { DurableObject as CloudflareDurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";

export function workerSentryOptions(env: Env): Sentry.CloudflareOptions {
  const dsn = env.SENTRY_DSN?.trim();
  const release = env.CF_VERSION_METADATA?.tag?.trim() || env.CF_VERSION_METADATA?.id?.trim();

  return {
    dsn,
    enabled: Boolean(dsn),
    environment: env.SENTRY_ENVIRONMENT?.trim() || env.WORKER_ENV?.trim() || "development",
    release,
    sampleRate: 1,
    tracesSampleRate: monitoringSampleRate(env.SENTRY_TRACES_SAMPLE_RATE, 0.02),
    enableLogs: false,
    enableRpcTracePropagation: false,
    dataCollection: privateMonitoringDataCollection(),
    integrations: [Sentry.httpServerIntegration({ maxRequestBodySize: "none" })],
    beforeSend: sanitizeMonitoringEvent,
    beforeSendTransaction: sanitizeMonitoringEvent,
    beforeSendSpan: sanitizeMonitoringSpan,
    initialScope: { tags: { surface: "worker" } },
  };
}

export function sentryEnabled(env: Pick<Env, "SENTRY_DSN">): boolean {
  return Boolean(env.SENTRY_DSN?.trim());
}

export function instrumentDurableObjectWhenSentryEnabled<
  T extends CloudflareDurableObject<Env>,
  C extends new (state: DurableObjectState, env: Env) => T,
>(DurableObjectClass: C): C {
  const monitoredClass = Sentry.instrumentDurableObjectWithSentry(
    workerSentryOptions,
    DurableObjectClass,
  );

  return new Proxy(DurableObjectClass, {
    construct(target, argumentsList) {
      const env = argumentsList[1] as Env;
      const selectedClass = sentryEnabled(env) ? monitoredClass : target;
      return Reflect.construct(selectedClass, argumentsList, selectedClass);
    },
  });
}

export function monitoringSampleRate(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}
