import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { parseJsonc } from "./mirror-template/jsonc.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const scriptPath = join(scriptDir, "mirror-template.mjs");
const stamp = "2026-07-04T00:00:00.000Z";

describe("mirror-template", () => {
  it("generates the self-host template and detects drift", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "orange-replay-template-test-"));
    const outDir = join(tempDir, "template");

    try {
      const generated = await runMirror(["--out", outDir, "--allow-test-output", "--stamp", stamp]);
      expect(generated.code).toBe(0);

      const wrangler = await readFile(join(outDir, "wrangler.jsonc"), "utf8");
      const wranglerConfig = parseJsonc(wrangler, "generated wrangler.jsonc");
      expect(wrangler).toContain('"name": "orange-replay"');
      expect(wrangler).toContain("REPLACE_WITH_D1_ID");
      expect(wrangler).toContain("REPLACE_WITH_KV_ID");
      expect(wrangler).toContain("# created by setup docs");
      expect(wrangler).toContain("Better Auth and GitHub OAuth values");
      expect(wrangler).toContain("LIVE_TICKET_SECRET");
      expect(wrangler).toContain("ANALYTICS_ACTOR_RATE_LIMITER");
      expect(wrangler).toContain("ANALYTICS_PROJECT_RATE_LIMITER");
      expect(wrangler).toContain("ANALYTICS_GLOBAL_RATE_LIMITER");
      expect(wrangler).toContain("LIVE_TICKET_RATE_LIMITER");
      expect(
        wranglerConfig.ratelimits.find(
          (rateLimit) => rateLimit.name === "ANALYTICS_PROJECT_RATE_LIMITER",
        )?.simple,
      ).toEqual({ limit: 300, period: 60 });
      expect(wrangler).toContain('"crons": ["*/5 * * * *", "7,22,37,52 * * * *"]');
      expect(wrangler).not.toContain("DEV_TEST_ROUTES");
      expect(wrangler).not.toContain("TEST_TIMINGS");
      expect(wranglerConfig.assets).toEqual({
        directory: "../../apps/dashboard/dist",
        binding: "ASSETS",
        run_worker_first: [
          "/api/*",
          "/internal/*",
          "/v1/*",
          "/login",
          "/_admin",
          "/_admin/*",
          "/demo",
          "/demo/*",
          "/projects",
          "/projects/*",
          "/p/*",
        ],
      });

      const sourceMigration = await readFile(
        join(repoRoot, "apps/worker/migrations/0001_init.sql"),
        "utf8",
      );
      const mirroredMigration = await readFile(join(outDir, "migrations/0001_init.sql"), "utf8");
      expect(mirroredMigration).toBe(sourceMigration);

      const manifest = JSON.parse(await readFile(join(outDir, ".mirror-manifest.json"), "utf8"));
      expect(manifest).toEqual({
        generatedAt: stamp,
        sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });

      const cleanCheck = await runMirror([
        "--out",
        outDir,
        "--allow-test-output",
        "--stamp",
        stamp,
        "--check",
      ]);
      expect(cleanCheck.code).toBe(0);

      await writeFile(join(outDir, "README.md"), "tampered\n", "utf8");
      const tamperedCheck = await runMirror([
        "--out",
        outDir,
        "--allow-test-output",
        "--stamp",
        stamp,
        "--check",
      ]);
      expect(tamperedCheck.code).not.toBe(0);
      expect(`${tamperedCheck.stdout}\n${tamperedCheck.stderr}`).toContain("README.md");
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("does not allow source directories as temp output", async () => {
    const tempRepo = await mkdtemp(join(tmpdir(), "orange-replay-root-test-"));
    const scriptsDir = join(tempRepo, "scripts");
    const markerPath = join(scriptsDir, "keep.txt");

    try {
      await mkdir(scriptsDir, { recursive: true });
      await writeFile(markerPath, "keep me\n", "utf8");

      const result = await runMirror([
        "--root",
        tempRepo,
        "--out",
        scriptsDir,
        "--allow-test-output",
      ]);

      expect(result.code).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain(
        "--out cannot point at repo source directories",
      );
      await expect(readFile(markerPath, "utf8")).resolves.toBe("keep me\n");
    } finally {
      await rm(tempRepo, { force: true, recursive: true });
    }
  });

  it("rejects symbolic links in source and generated template files", async () => {
    const tempParent = await mkdtemp(join(tmpdir(), "orange-replay-template-test-links-"));
    const tempRepo = join(tempParent, "repo");
    const outDir = join(tempParent, "output");
    const workerDir = join(tempRepo, "apps/worker");
    const migrationsDir = join(workerDir, "migrations");

    try {
      await mkdir(migrationsDir, { recursive: true });
      await writeFile(
        join(workerDir, "wrangler.jsonc"),
        await readFile(join(repoRoot, "apps/worker/wrangler.jsonc"), "utf8"),
        "utf8",
      );
      await writeFile(join(tempParent, "outside.sql"), "SELECT 1;\n", "utf8");
      await symlink(join(tempParent, "outside.sql"), join(migrationsDir, "0001_link.sql"));

      const sourceLinkResult = await runMirror([
        "--root",
        tempRepo,
        "--out",
        outDir,
        "--allow-test-output",
      ]);
      expect(sourceLinkResult.code).not.toBe(0);
      expect(`${sourceLinkResult.stdout}\n${sourceLinkResult.stderr}`).toContain(
        "Symbolic links are not allowed",
      );

      await rm(join(migrationsDir, "0001_link.sql"));
      await writeFile(join(migrationsDir, "0001_init.sql"), "SELECT 1;\n", "utf8");
      const sourceWrangler = join(workerDir, "wrangler.jsonc");
      const outsideWrangler = join(tempParent, "outside-wrangler.jsonc");
      await writeFile(
        outsideWrangler,
        await readFile(join(repoRoot, "apps/worker/wrangler.jsonc"), "utf8"),
        "utf8",
      );
      await rm(sourceWrangler);
      await symlink(outsideWrangler, sourceWrangler);

      const wranglerLinkResult = await runMirror([
        "--root",
        tempRepo,
        "--out",
        outDir,
        "--allow-test-output",
      ]);
      expect(wranglerLinkResult.code).not.toBe(0);
      expect(`${wranglerLinkResult.stdout}\n${wranglerLinkResult.stderr}`).toContain(
        "Template path must be a regular file",
      );

      await rm(sourceWrangler);
      await writeFile(sourceWrangler, await readFile(outsideWrangler, "utf8"), "utf8");
      const generated = await runMirror([
        "--root",
        tempRepo,
        "--out",
        outDir,
        "--allow-test-output",
      ]);
      expect(generated.code).toBe(0);
      await rm(join(outDir, "README.md"));
      await symlink(join(tempParent, "outside.sql"), join(outDir, "README.md"));

      const outputLinkResult = await runMirror([
        "--root",
        tempRepo,
        "--out",
        outDir,
        "--allow-test-output",
        "--check",
      ]);
      expect(outputLinkResult.code).not.toBe(0);
      expect(`${outputLinkResult.stdout}\n${outputLinkResult.stderr}`).toContain(
        "Symbolic links are not allowed",
      );
    } finally {
      await rm(tempParent, { force: true, recursive: true });
    }
  });
});

function runMirror(args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({
        code: code ?? 1,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    });
  });
}
