import {
  privateMonitoringDataCollection,
  sanitizeMonitoringEvent,
  sanitizeMonitoringSpan,
} from "@orange-replay/shared/error-monitoring-privacy";
import * as Sentry from "@sentry/react";
import type { ErrorInfo } from "react";
import type { RootOptions } from "react-dom/client";

interface BrowserSentrySettings {
  dsn: string;
  environment: string;
  tracesSampleRate: number;
}

const reportedErrors = new WeakSet<object>();

export function initializeDashboardSentry(router: unknown): RootOptions {
  const dsn = import.meta.env.VITE_SENTRY_DSN?.trim();
  if (!dsn) return {};

  Sentry.init(
    dashboardSentryOptions(
      {
        dsn,
        environment: import.meta.env.VITE_SENTRY_ENVIRONMENT?.trim() || monitoringEnvironment(),
        tracesSampleRate: monitoringSampleRate(
          import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE,
          0.05,
        ),
      },
      [Sentry.tanstackRouterBrowserTracingIntegration(router)],
    ),
  );

  return {
    onCaughtError: (error, errorInfo) =>
      captureReactErrorOnce(error, errorInfo, "react.caught_error", true),
    onRecoverableError: (error, errorInfo) =>
      captureReactErrorOnce(error, errorInfo, "react.recoverable_error", true),
    onUncaughtError: (error, errorInfo) =>
      captureReactErrorOnce(error, errorInfo, "react.uncaught_error", false),
  };
}

export function reportDashboardRouterError(error: Error, errorInfo: ErrorInfo): void {
  captureReactErrorOnce(error, errorInfo, "tanstack_router.error_boundary", true);
}

export function dashboardSentryOptions(
  settings: BrowserSentrySettings,
  integrations: Sentry.BrowserOptions["integrations"] = [],
): Sentry.BrowserOptions {
  return {
    dsn: settings.dsn,
    environment: settings.environment,
    tracesSampleRate: settings.tracesSampleRate,
    sampleRate: 1,
    enableLogs: false,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    dataCollection: privateMonitoringDataCollection(),
    integrations,
    beforeSend: sanitizeMonitoringEvent,
    beforeSendTransaction: sanitizeMonitoringEvent,
    beforeSendSpan: sanitizeMonitoringSpan,
    initialScope: { tags: { surface: "dashboard" } },
  };
}

export function monitoringSampleRate(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function monitoringEnvironment(): string {
  return import.meta.env.PROD ? "production" : "development";
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
