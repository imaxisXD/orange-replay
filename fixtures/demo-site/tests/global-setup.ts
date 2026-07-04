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
const stateFile = fileURLToPath(new URL("../.playwright-state.json", import.meta.url));
const apiToken = "demo-e2e-token";
const ingestKey = "or_demo_e2e_key";
const timings = {
  segmentFlushMs: 700,
  segmentFlushBytes: 2048,
  flushTailMs: 700,
  closeMs: 3_000,
};

export default async function globalSetup(): Promise<() => Promise<void>> {
  process.env.WRANGLER_WRITE_LOGS = "false";
  const wrangler = await loadWrangler();
  const worker = await wrangler.unstable_dev(resolve(workerDir, "src/index.ts"), {
    config: resolve(workerDir, "wrangler.jsonc"),
    vars: {
      DEV_TEST_ROUTES: "1",
      DEV_API_TOKEN: apiToken,
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

  await writeFile(
    stateFile,
    JSON.stringify(
      {
        workerUrl,
        demoUrl,
        cspDemoUrl,
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
