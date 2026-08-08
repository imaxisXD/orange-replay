const PRIVATE_ROUTE_SEGMENTS =
  /\/(projects|onboarding|sessions|public-pages|replays|websites|keys|p)\/[^/?#\s,;)}\]]+/giu;
const RECORDING_OBJECT_KEY = /(^|[\s:(])p\/[^/?#\s]+\/[^/?#\s]+/giu;
const ANALYTICS_EXPORT_ID = /\b(?:session|event|deletion):[^\s,;)}\]]+/giu;
const NAMED_PRIVATE_VALUE =
  /(\b(?:project|session|public(?:[-_. ]?page)?|website|workspace|user|export)[-_. ]?id\b\s*(?:=|:)\s*)[^\s,;)}\]]+/giu;
const RECORDER_KEY = /\bor_(?:live|test)_[a-z\d_-]+\b/giu;
const BEARER_TOKEN = /\bbearer\s+[a-z\d._~+/=-]+/giu;
const EMAIL_ADDRESS = /\b[a-z\d.!#$%&'*+/=?^_`{|}~-]+@[a-z\d-]+(?:\.[a-z\d-]+)+\b/giu;
const UUID = /\b[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}\b/giu;
const PRIVATE_ATTRIBUTE_NAME =
  /(?:authorization|cookie|query|body|param|project(?:[._-]?id)?|session(?:[._-]?id)?|public(?:[._-]?id)?|user(?:[._-]?id)?|email)/iu;
const URL_ATTRIBUTE_NAME = /(?:url|path|route|from|to)/iu;

interface MonitoringEventLike {
  breadcrumbs?: MonitoringBreadcrumbLike[] | null;
  exception?: { values?: Array<{ value?: string | null }> | null } | null;
  extra?: unknown;
  message?: string;
  request?: MonitoringRequestLike | null;
  tags?: Record<string, unknown>;
  transaction?: string;
  user?: unknown;
}

interface MonitoringBreadcrumbLike {
  data?: Record<string, unknown>;
  message?: string;
}

interface MonitoringRequestLike {
  cookies?: unknown;
  data?: unknown;
  headers?: unknown;
  query_string?: unknown;
  url?: string;
}

interface MonitoringSpanLike {
  data?: Record<string, unknown>;
  description?: string;
}

export function privateMonitoringDataCollection() {
  return {
    userInfo: false,
    cookies: false,
    httpHeaders: { request: false, response: false },
    httpBodies: [],
    urlQueryParams: false,
    graphQL: { document: false, variables: false },
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    stackFrameVariables: false,
    frameContextLines: 0,
  };
}

/** Removes account and recording identity before an error leaves Orange Replay. */
export function sanitizeMonitoringEvent<T>(event: T): T {
  const monitoringEvent = event as MonitoringEventLike;
  delete monitoringEvent.user;
  delete monitoringEvent.extra;

  if (typeof monitoringEvent.message === "string") {
    monitoringEvent.message = sanitizeTextWithRoutes(monitoringEvent.message);
  }
  if (typeof monitoringEvent.transaction === "string") {
    monitoringEvent.transaction = sanitizeTextWithRoutes(monitoringEvent.transaction);
  }
  for (const exception of monitoringEvent.exception?.values ?? []) {
    if (typeof exception.value === "string") {
      exception.value = sanitizeTextWithRoutes(exception.value);
    }
  }
  if (monitoringEvent.tags) monitoringEvent.tags = sanitizeAttributes(monitoringEvent.tags);

  const request = monitoringEvent.request;
  if (request) {
    if (typeof request.url === "string") request.url = sanitizeMonitoringUrl(request.url);
    delete request.cookies;
    delete request.data;
    delete request.headers;
    delete request.query_string;
  }

  for (const breadcrumb of monitoringEvent.breadcrumbs ?? []) {
    if (typeof breadcrumb.message === "string") {
      breadcrumb.message = sanitizeTextWithRoutes(breadcrumb.message);
    }
    if (breadcrumb.data) breadcrumb.data = sanitizeAttributes(breadcrumb.data);
  }

  return event;
}

/** Removes private route values and request details from performance spans. */
export function sanitizeMonitoringSpan<T>(span: T): T {
  const monitoringSpan = span as MonitoringSpanLike;
  if (typeof monitoringSpan.description === "string") {
    monitoringSpan.description = sanitizeTextWithRoutes(monitoringSpan.description);
  }
  if (monitoringSpan.data) monitoringSpan.data = sanitizeAttributes(monitoringSpan.data);
  return span;
}

export function sanitizeMonitoringUrl(value: string): string {
  const isAbsolute = /^[a-z][a-z\d+.-]*:\/\//iu.test(value);
  try {
    const url = new URL(value, "https://monitoring.invalid");
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.pathname = redactPrivateRouteSegments(url.pathname);
    return isAbsolute ? url.toString() : url.pathname;
  } catch {
    return sanitizeTextWithRoutes(value.split(/[?#]/u, 1)[0] ?? "");
  }
}

function sanitizeAttributes(attributes: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (PRIVATE_ATTRIBUTE_NAME.test(name)) continue;
    if (typeof value === "string") {
      sanitized[name] =
        URL_ATTRIBUTE_NAME.test(name) || value.startsWith("/") || /^[a-z]+:\/\//iu.test(value)
          ? sanitizeMonitoringUrl(value)
          : sanitizeTextWithRoutes(value);
    } else if (typeof value === "number" || typeof value === "boolean" || value === null) {
      sanitized[name] = value;
    }
  }
  return sanitized;
}

function sanitizeTextWithRoutes(value: string): string {
  return redactPrivateText(redactPrivateRouteSegments(value.replace(/([?#]).*$/u, "")));
}

function redactPrivateRouteSegments(value: string): string {
  return value
    .replace(RECORDING_OBJECT_KEY, (_match, prefix: string) => `${prefix}p/[project]/[session]`)
    .replace(PRIVATE_ROUTE_SEGMENTS, (_match, routeName: string) => {
      const label = routeName.toLowerCase() === "p" ? "public-page" : routeName.toLowerCase();
      return `/${routeName}/[${label}]`;
    });
}

function redactPrivateText(value: string): string {
  return value
    .replace(ANALYTICS_EXPORT_ID, "[analytics-export]")
    .replace(NAMED_PRIVATE_VALUE, "$1[redacted]")
    .replace(RECORDER_KEY, "[recorder-key]")
    .replace(BEARER_TOKEN, "Bearer [redacted]")
    .replace(EMAIL_ADDRESS, "[email]")
    .replace(UUID, "[id]");
}
