import { writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer as createPortServer } from "node:net";
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
const betterAuthSecret = "demo-e2e-better-auth-secret-000000000000";
const ingestKey = `or_live_${"a".repeat(32)}`;
const timings = {
  segmentFlushMs: 700,
  segmentFlushBytes: 2048,
  flushTailMs: 700,
  // Leave a visible idle window so the product test proves the row and player
  // stay available after Live ends but before the immutable manifest is done.
  closeMs: 12_000,
  presenceTtlMs: 1_500,
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
  const dashboardPort = await findAvailablePort();
  const dashboardUrl = `http://127.0.0.1:${dashboardPort}`;
  const worker = await wrangler.unstable_dev(resolve(workerDir, "src/index.ts"), {
    config: resolve(workerDir, "wrangler.jsonc"),
    vars: {
      DEV_TEST_ROUTES: "1",
      BETTER_AUTH_SECRET: betterAuthSecret,
      BETTER_AUTH_URL: dashboardUrl,
      BETTER_AUTH_TRUSTED_ORIGINS: dashboardUrl,
      GITHUB_CLIENT_ID: "github-demo-e2e-client-id",
      GITHUB_CLIENT_SECRET: "github-demo-e2e-client-secret-000000",
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
  await dashboardVite.listen(dashboardPort);
  await seedDashboardProject(workerUrl);
  const sessionCookie = await seedDashboardSession(workerUrl);

  await writeFile(
    stateFile,
    JSON.stringify(
      {
        workerUrl,
        demoUrl,
        cspDemoUrl,
        dashboardUrl,
        sessionCookie,
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

async function seedDashboardProject(workerUrl: string): Promise<void> {
  const response = await fetch(`${workerUrl}/__test/ingest/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      key: ingestKey,
      kv: true,
      config: {
        projectId: "demo-e2e-project",
        orgId: "demo-e2e-org",
        shard: 0,
        active: true,
        sampleRate: 1,
        allowedOrigins: ["*"],
        maskPolicyVersion: 1,
        quotaState: "ok",
        retentionDays: 30,
      },
    }),
  });
  if (response.status !== 200) throw new Error("Could not seed the browser test project.");
}

async function seedDashboardSession(workerUrl: string): Promise<string> {
  const response = await fetch(`${workerUrl}/__test/api/hosted/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectIds: ["demo-e2e-project"] }),
  });
  if (response.status !== 200) throw new Error("Could not seed the browser Better Auth session.");
  const body = (await response.json()) as { cookie?: unknown };
  if (typeof body.cookie !== "string") throw new Error("Browser Better Auth cookie is missing.");
  return body.cookie;
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

function findAvailablePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createPortServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        server.close();
        reject(new Error("Could not reserve a dashboard test port."));
        return;
      }
      const { port } = address;
      server.close((error) => (error === undefined ? resolvePort(port) : reject(error)));
    });
  });
}
