import {
  BLOCKED_CLICK_DETAIL,
  buildClickDetail,
  isBlockedElement,
  mergeBlockSelector,
  truncateDetail,
} from "./scrub.ts";
import type { InitOptions } from "./types.ts";
import { shouldSampleSession } from "./sampling.ts";
import { SessionManager } from "./session.ts";

export interface LoaderRuntimeConfig {
  bundleUrl: string;
  init?: InitOptions;
  queueLimit?: number;
}

type LoaderWindow = Window & {
  __orq?: unknown[] | { push(item: unknown): number };
  __orCleanup?: Array<() => void>;
  __orInit?: InitOptions;
  __orLoaderStarted?: boolean;
  __orConfig?: unknown;
};

const DEFAULT_QUEUE_LIMIT = 100;

export function installLoaderRuntime(config: LoaderRuntimeConfig): void {
  const win = window as LoaderWindow;
  if (win.__orLoaderStarted === true) {
    return;
  }

  win.__orLoaderStarted = true;
  const doc = document;
  const queue = (win.__orq = Array.isArray(win.__orq) ? win.__orq : []);
  const cleanup = (win.__orCleanup = win.__orCleanup || []);
  const queueLimit = cleanQueueLimit(config.queueLimit);
  const blockSelector = mergeBlockSelector(config.init?.blockSelector);
  const now = () => Date.now();
  const push = (item: Record<string, unknown>) => {
    if (typeof item["t"] !== "number") {
      item["t"] = now();
    }
    if (queue.length >= queueLimit) {
      queue.splice(0, queue.length - queueLimit + 1);
    }
    queue.push(item);
  };

  if (config.init !== undefined) {
    win.__orInit = config.init;
    push({ k: "init", o: config.init });
  }

  addManagedListener(
    win,
    "error",
    (event) => {
      const error = event as ErrorEvent;
      push({ k: "error", m: truncateDetail(error.message || String(error.error || "error")) });
    },
    true,
    cleanup,
  );

  addManagedListener(
    win,
    "unhandledrejection",
    (event) => {
      const reason = (event as PromiseRejectionEvent).reason;
      push({
        k: "unhandledrejection",
        m: truncateDetail(reasonMessage(reason)),
      });
    },
    true,
    cleanup,
  );

  addManagedListener(
    doc,
    "click",
    (event) => {
      const mouse = event as MouseEvent;
      const target = asElement(mouse.target);
      push({
        k: "click",
        d: isBlockedElement(target, blockSelector)
          ? BLOCKED_CLICK_DETAIL
          : buildClickDetail(target),
        x: mouse.clientX || 0,
        y: mouse.clientY || 0,
        w: win.innerWidth || 0,
        h: win.innerHeight || 0,
      });
    },
    true,
    cleanup,
  );

  push({
    k: "vital",
    start: win.performance?.timeOrigin || now(),
    u: win.location.href,
  });

  void loadRecorderWhenSampled(win, doc, config, cleanup, queue);
}

async function loadRecorderWhenSampled(
  win: LoaderWindow,
  doc: Document,
  config: LoaderRuntimeConfig,
  cleanup: Array<() => void>,
  queue: unknown[],
): Promise<void> {
  const init = config.init;
  if (init === undefined || init.key.length === 0 || init.ingestUrl.length === 0) {
    appendRecorderScript(doc, config.bundleUrl, init);
    return;
  }

  const ingestUrl = init.ingestUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(`${ingestUrl}/v1/config`, {
      method: "GET",
      headers: { "x-or-key": init.key },
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    });
    if (!response.ok) {
      appendRecorderScript(doc, config.bundleUrl, init);
      return;
    }

    const remote = await response.json();
    const gate = parseLoaderGate(remote, ingestUrl, config.bundleUrl);
    if (gate === null) {
      appendRecorderScript(doc, config.bundleUrl, init);
      return;
    }

    const session = new SessionManager({
      projectRef: gate.projectRef ?? init.key,
      now: () => Date.now(),
      cookieMode: win.location.protocol === "https:" ? "secure" : "none",
      cookieDomain: gate.cookieDomain,
      hostname: win.location.hostname,
    });
    await session.ready;
    const sampled = shouldSampleSession(
      session.sessionId,
      Math.min(cleanSampleRate(init.sampleRate), gate.sampleRate),
    );
    session.stop();
    if (!sampled) {
      discardPreBuffer(win, cleanup, queue);
      return;
    }

    win.__orConfig = remote;
    appendRecorderScript(doc, gate.recorderUrl, init);
  } catch {
    appendRecorderScript(doc, config.bundleUrl, init);
  } finally {
    clearTimeout(timeout);
  }
}

function appendRecorderScript(doc: Document, url: string, init: InitOptions | undefined): void {
  const script = doc.createElement("script");
  script.async = true;
  script.src = url;
  script.onerror = () => reportBundleLoadFailure(init);
  doc.head.appendChild(script);
}

function reportBundleLoadFailure(init: InitOptions | undefined): void {
  if (init === undefined || init.key.length === 0 || init.ingestUrl.length === 0) return;
  try {
    void fetch(`${init.ingestUrl.replace(/\/+$/, "")}/v1/sdk-health`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-or-key": init.key },
      body: '{"version":1,"code":"bundle_load_failed"}',
      cache: "no-store",
      credentials: "omit",
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* health reporting must never affect the host page */
  }
}

interface LoaderGate {
  recorderUrl: string;
  projectRef?: string;
  cookieDomain?: string;
  sampleRate: number;
}

function parseLoaderGate(
  value: unknown,
  ingestUrl: string,
  fallbackUrl: string,
): LoaderGate | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const sampleRate = record["sampleRate"];
  if (
    typeof sampleRate !== "number" ||
    !Number.isFinite(sampleRate) ||
    sampleRate < 0 ||
    sampleRate > 1
  ) {
    return null;
  }
  const rawProjectRef = record["sessionScope"] ?? record["projectId"];
  const projectRef = cleanProjectRef(rawProjectRef);
  if (rawProjectRef !== undefined && projectRef === undefined) return null;
  const cookieDomain = cleanCookieDomain(record["sessionCookieDomain"]);
  if (record["sessionCookieDomain"] !== undefined && cookieDomain === undefined) return null;

  let recorderUrl = fallbackUrl;
  if (record["recorderUrl"] !== undefined) {
    if (typeof record["recorderUrl"] !== "string") return null;
    try {
      const candidate = new URL(record["recorderUrl"], ingestUrl);
      if (candidate.origin !== new URL(ingestUrl).origin) return null;
      recorderUrl = candidate.toString();
    } catch {
      return null;
    }
  }
  return { recorderUrl, projectRef, cookieDomain, sampleRate };
}

function cleanProjectRef(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : undefined;
}

function cleanCookieDomain(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= 253 &&
    /^[a-z\d](?:[a-z\d.-]*[a-z\d])?$/i.test(value)
    ? value
    : undefined;
}

function cleanSampleRate(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

function discardPreBuffer(win: LoaderWindow, cleanup: Array<() => void>, queue: unknown[]): void {
  queue.splice(0);
  for (const remove of cleanup.splice(0)) {
    try {
      remove();
    } catch {
      /* loader cleanup must never affect the host page */
    }
  }
  win.__orq = { push: () => 0 };
}

function addManagedListener(
  target: Window | Document,
  type: string,
  listener: EventListener,
  capture: boolean,
  cleanup: Array<() => void>,
): void {
  target.addEventListener(type, listener, capture);
  cleanup.push(() => target.removeEventListener(type, listener, capture));
}

function reasonMessage(reason: unknown): string {
  if (reason !== null && typeof reason === "object" && "message" in reason) {
    return String(reason.message);
  }

  return String(reason);
}

function asElement(value: EventTarget | null): Element | null {
  return value instanceof Element ? value : null;
}

function cleanQueueLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) {
    return DEFAULT_QUEUE_LIMIT;
  }

  return Math.floor(value);
}
