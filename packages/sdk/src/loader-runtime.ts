import {
  BLOCKED_CLICK_DETAIL,
  buildClickDetail,
  isBlockedElement,
  mergeBlockSelector,
  truncateDetail,
} from "./scrub.ts";
import type { InitOptions } from "./types.ts";

export interface LoaderRuntimeConfig {
  bundleUrl: string;
  init?: InitOptions;
  queueLimit?: number;
}

type LoaderWindow = Window & {
  __orq?: unknown[];
  __orCleanup?: Array<() => void>;
  __orInit?: InitOptions;
  __orLoaderStarted?: boolean;
};

const DEFAULT_QUEUE_LIMIT = 100;

export function installLoaderRuntime(config: LoaderRuntimeConfig): void {
  const win = window as LoaderWindow;
  if (win.__orLoaderStarted === true) {
    return;
  }

  win.__orLoaderStarted = true;
  const doc = document;
  const queue = (win.__orq = win.__orq || []);
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
    n: "navigation",
    start: win.performance?.timeOrigin || now(),
  });

  const script = doc.createElement("script");
  script.async = true;
  script.src = config.bundleUrl;
  doc.head.appendChild(script);
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
