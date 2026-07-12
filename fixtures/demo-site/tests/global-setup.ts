import { writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";

interface DevWorker {
  address: string;
  port: number;
  stop(): Promise<void>;
}

interface WranglerModule {
  unstable_dev(
    entry: string,
    options: {
      config: string;
      vars: Record<string, string>;
      persist: boolean;
      experimental: { disableExperimentalWarning: boolean };
    },
  ): Promise<DevWorker>;
}

const demoDir = fileURLToPath(new URL("..", import.meta.url));
const repoDir = resolve(demoDir, "../..");
const workerDir = resolve(repoDir, "apps/worker");
const dashboardDir = resolve(repoDir, "apps/dashboard");
const stateFile = fileURLToPath(new URL("../.playwright-state.json", import.meta.url));
const apiToken = "demo-e2e-token-000000000000000000";
const ingestKey = `or_live_${"a".repeat(32)}`;
const timings = {
  segmentFlushMs: 700,
  segmentFlushBytes: 2048,
  flushTailMs: 700,
  closeMs: 3_000,
  presenceTtlMs: 20_000,
  presenceHeartbeatMs: 700,
  // Keep the server-driven SDK cadence below closeMs: at the production
  // default (15s) every lightly-active session finalizes between flushes
  // under the shortened closeMs, so live rows could never persist.
  sdkFlushMs: 1_000,
  sdkFlushLiveMs: 500,
};

export default async function globalSetup(): Promise<() => Promise<void>> {
  process.env.WRANGLER_WRITE_LOGS = "false";
  // The e2e Worker receives explicit test vars below. Never merge a developer's local .env.
  process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";
  const wrangler = await loadWrangler();
  const worker = await wrangler.unstable_dev(resolve(workerDir, "src/index.ts"), {
    config: resolve(workerDir, "wrangler.jsonc"),
    vars: {
      DEV_TEST_ROUTES: "1",
      DEV_API_TOKEN: apiToken,
      DEV_API_PROJECT_IDS: "demo-e2e-project",
      LIVE_TICKET_SECRET: "demo-e2e-live-ticket-000000000000",
      TEST_TIMINGS: JSON.stringify(timings),
    },
    persist: false,
    experimental: { disableExperimentalWarning: true },
  });
  const workerUrl = `http://${worker.address}:${worker.port}`;

  const vite = await createDemoServer(workerUrl, false);
  await vite.listen(0);
  const demoUrl = readViteUrl(vite);
  const cspVite = await createDemoServer(workerUrl, true);
  await cspVite.listen(0);
  const cspDemoUrl = readViteUrl(cspVite);
  const dashboardVite = await createDashboardServer(workerUrl);
  await dashboardVite.listen(0);
  const dashboardUrl = readViteUrl(dashboardVite);

  await writeFile(
    stateFile,
    JSON.stringify(
      {
        workerUrl,
        demoUrl,
        cspDemoUrl,
        dashboardUrl,
        apiToken,
        ingestKey,
        projectId: "demo-e2e-project",
        orgId: "demo-e2e-org",
        timings,
      },
      null,
      2,
    ),
  );

  return async () => {
    await Promise.allSettled([
      vite.close(),
      cspVite.close(),
      dashboardVite.close(),
      worker.stop(),
      rm(stateFile, { force: true }),
    ]);
  };
}

async function createDemoServer(workerUrl: string, withCsp: boolean): Promise<ViteDevServer> {
  const vite = await createServer({
    root: demoDir,
    configFile: resolve(demoDir, "vite.config.ts"),
    logLevel: "warn",
    server: {
      host: "127.0.0.1",
      headers: withCsp ? { "Content-Security-Policy": "worker-src 'self'" } : undefined,
    },
    define: {
      __ORANGE_REPLAY_WORKER_URL__: JSON.stringify(workerUrl),
      __ORANGE_REPLAY_INGEST_KEY__: JSON.stringify(ingestKey),
    },
  });

  return vite;
}

async function createDashboardServer(workerUrl: string): Promise<ViteDevServer> {
  const previousWorkerUrl = process.env.VITE_WORKER_URL;
  process.env.VITE_WORKER_URL = workerUrl;

  try {
    return await createServer({
      root: dashboardDir,
      configFile: resolve(dashboardDir, "vite.config.ts"),
      logLevel: "warn",
      server: {
        host: "127.0.0.1",
      },
    });
  } finally {
    if (previousWorkerUrl === undefined) {
      delete process.env.VITE_WORKER_URL;
    } else {
      process.env.VITE_WORKER_URL = previousWorkerUrl;
    }
  }
}

async function loadWrangler(): Promise<WranglerModule> {
  const requireFromWorker = createRequire(resolve(workerDir, "package.json"));
  const wranglerUrl = pathToFileURL(requireFromWorker.resolve("wrangler")).href;
  return (await import(wranglerUrl)) as WranglerModule;
}

function readViteUrl(vite: ViteDevServer): string {
  const address = vite.httpServer?.address();

  if (typeof address === "object" && address !== null) {
    return `http://127.0.0.1:${address.port}`;
  }

  throw new Error("Vite demo server did not expose a local port");
}
