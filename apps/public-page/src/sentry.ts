import {
  privateMonitoringDataCollection,
  sanitizeMonitoringEvent,
  sanitizeMonitoringSpan,
} from "@orange-replay/shared/error-monitoring-privacy";
import * as Sentry from "@sentry/react";
import type { ErrorInfo } from "react";
import type { HydrationOptions } from "react-dom/client";

const reportedErrors = new WeakSet<object>();

export function initializePublicPageSentry(): HydrationOptions {
  const dsn = import.meta.env.VITE_SENTRY_DSN?.trim();
  if (!dsn) return {};

  Sentry.init({
    dsn,
    environment:
      import.meta.env.VITE_SENTRY_ENVIRONMENT?.trim() ||
      (import.meta.env.PROD ? "production" : "development"),
    tracesSampleRate: monitoringSampleRate(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE, 0.02),
    sampleRate: 1,
    enableLogs: false,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    dataCollection: privateMonitoringDataCollection(),
    integrations: [Sentry.browserTracingIntegration()],
    beforeSend: sanitizeMonitoringEvent,
    beforeSendTransaction: sanitizeMonitoringEvent,
    beforeSendSpan: sanitizeMonitoringSpan,
    initialScope: { tags: { surface: "public-page" } },
  });

  return {
    onCaughtError: (error, errorInfo) =>
      captureReactErrorOnce(error, errorInfo, "react.caught_error", true),
    onRecoverableError: (error, errorInfo) =>
      captureReactErrorOnce(error, errorInfo, "react.recoverable_error", true),
    onUncaughtError: (error, errorInfo) =>
      captureReactErrorOnce(error, errorInfo, "react.uncaught_error", false),
  };
}

function monitoringSampleRate(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function captureReactErrorOnce(
  error: unknown,
  errorInfo: ErrorInfo,
  mechanismType: string,
  handled: boolean,
): void {
  if (!Sentry.isInitialized()) return;
  if (typeof error === "object" && error !== null) {
    if (reportedErrors.has(error)) return;
    reportedErrors.add(error);
  }

  Sentry.captureReactException(error, errorInfo, {
    mechanism: { handled, type: mechanismType },
  });
}
