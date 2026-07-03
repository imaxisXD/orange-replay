export interface LoaderRuntimeConfig {
  bundleUrl: string;
}

type LoaderWindow = Window & { __orq?: unknown[]; __orLoaderStarted?: boolean };

export function installLoaderRuntime(config: LoaderRuntimeConfig): void {
  const win = window as LoaderWindow;
  if (win.__orLoaderStarted === true) {
    return;
  }

  win.__orLoaderStarted = true;
  const doc = document;
  const queue = (win.__orq = win.__orq || []);
  const now = () => Date.now();
  const push = (item: Record<string, unknown>) => {
    if (typeof item["t"] !== "number") {
      item["t"] = now();
    }
    queue.push(item);
  };

  win.addEventListener(
    "error",
    (event) => {
      const error = event as ErrorEvent;
      push({ k: "error", m: error.message || String(error.error || "error") });
    },
    true,
  );

  win.addEventListener(
    "unhandledrejection",
    (event) => {
      const reason = (event as PromiseRejectionEvent).reason;
      push({
        k: "unhandledrejection",
        m: reasonMessage(reason),
      });
    },
    true,
  );

  doc.addEventListener(
    "click",
    (event) => {
      const mouse = event as MouseEvent;
      push({
        k: "click",
        x: mouse.clientX || 0,
        y: mouse.clientY || 0,
        w: win.innerWidth || 0,
        h: win.innerHeight || 0,
        target: mouse.target,
      });
    },
    true,
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

function reasonMessage(reason: unknown): string {
  if (reason !== null && typeof reason === "object" && "message" in reason) {
    return String(reason.message);
  }

  return String(reason);
}
