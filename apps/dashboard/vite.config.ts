import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseEnv } from "node:util";
import babel from "@rolldown/plugin-babel";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig, lazyPlugins, type Plugin, type UserConfig } from "vite-plus";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const workerDir = path.join(repoRoot, "apps", "worker");
const workerConfigPath = path.join(workerDir, "wrangler.jsonc");
const workerStatePath = path.join(workerDir, ".wrangler", "state");
const localAssetsDir = path.join(workerDir, ".wrangler", "dev-assets");
const landingPagePath = path.join(repoRoot, "landing", "index.html");
const sharedPackageRequire = createRequire(
  path.join(repoRoot, "packages", "shared", "package.json"),
);
const cssTreeBrowserModule = sharedPackageRequire.resolve("css-tree/dist/csstree.esm");
const requestedIntegratedDevServer = process.env["ORANGE_REPLAY_INTEGRATED_DEV"] === "1";
const workerFirstRoutes = [
  "/api/*",
  "/internal/*",
  "/v1/*",
  "/login",
  "/demo",
  "/demo/*",
  "/projects",
  "/projects/*",
  "/p/*",
  "/_admin",
  "/_admin/*",
];

export default defineConfig(({ command }) =>
  dashboardConfig(command === "serve" && requestedIntegratedDevServer),
);

function dashboardConfig(usesIntegratedDevServer: boolean): UserConfig {
  const isolatedWorkerUrl = usesIntegratedDevServer ? undefined : process.env["VITE_WORKER_URL"];

  return {
    plugins: lazyPlugins(() => [
      ...(usesIntegratedDevServer
        ? [
            localLandingPage(),
            ...cloudflare({
              configPath: workerConfigPath,
              persistState: { path: workerStatePath },
              inspectorPort: false,
              remoteBindings: false,
              config(workerConfig) {
                workerConfig.assets = {
                  binding: "ASSETS",
                  not_found_handling: "single-page-application",
                  run_worker_first: workerFirstRoutes,
                };

                const exampleVariables = readExampleWorkerVariables();
                if (exampleVariables !== undefined) {
                  workerConfig.vars = { ...workerConfig.vars, ...exampleVariables };
                }
              },
            }),
          ]
        : []),
      react(),
      babel({ presets: [reactCompilerPreset()] }),
      tailwindcss(),
    ]),
    publicDir: usesIntegratedDevServer ? localAssetsDir : "public",
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "src"),
        ...(usesIntegratedDevServer ? { "css-tree": cssTreeBrowserModule } : {}),
      },
    },
    build: {
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              {
                name: "react-runtime",
                test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/,
                priority: 20,
                includeDependenciesRecursively: false,
              },
              {
                name: "replay-engine",
                test: (moduleId) =>
                  /[\\/]packages[\\/]player[\\/]/.test(moduleId) ||
                  /node_modules[\\/](?:@rrweb[\\/]|@xstate[\\/]fsm[\\/]|base64-arraybuffer[\\/]|css-tree[\\/]|mitt[\\/]|rrdom[\\/]|rrweb[\\/]|rrweb-snapshot[\\/]|source-map-js[\\/])/.test(
                    moduleId,
                  ),
                priority: 10,
                maxSize: 350 * 1024,
                includeDependenciesRecursively: false,
              },
            ],
          },
        },
      },
    },
    server: {
      port: 8787,
      strictPort: true,
      ...(isolatedWorkerUrl === undefined
        ? {}
        : {
            // Browser tests can still isolate Wrangler from the dashboard on random ports.
            proxy: {
              "/api": { target: isolatedWorkerUrl, changeOrigin: true, ws: true },
              "/v1": { target: isolatedWorkerUrl, changeOrigin: true },
            },
          }),
    },
    lint: {
      options: {
        typeAware: true,
        typeCheck: true,
      },
    },
    fmt: {},
    test: {
      environment: "happy-dom",
    },
  };
}

function localLandingPage(): Plugin {
  return {
    name: "orange-replay-local-landing-page",
    apply: "serve",
    configureServer(server) {
      server.watcher.add(landingPagePath);
      server.watcher.on("change", (changedPath) => {
        if (changedPath === landingPagePath) {
          server.ws.send({ type: "full-reload", path: "*" });
        }
      });

      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        if (pathname !== "/" && pathname !== "/index.html") {
          next();
          return;
        }

        try {
          const source = readFileSync(landingPagePath, "utf8");
          const html = await server.transformIndexHtml(pathname, source);
          response.statusCode = 200;
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.setHeader("Cache-Control", "no-cache");
          response.end(request.method === "HEAD" ? undefined : html);
        } catch (error) {
          next(
            error instanceof Error ? error : new Error("The local landing page could not load."),
          );
        }
      });
    },
  };
}

function readExampleWorkerVariables(): Record<string, string> | undefined {
  if (process.env["ORANGE_REPLAY_USE_EXAMPLE_WORKER_ENV"] !== "1") return undefined;

  const examplePath = path.join(workerDir, ".env.example");
  if (!existsSync(examplePath)) return undefined;

  const variables: Record<string, string> = {};
  for (const [name, value] of Object.entries(parseEnv(readFileSync(examplePath, "utf8")))) {
    if (value !== undefined) variables[name] = value;
  }
  return variables;
}
