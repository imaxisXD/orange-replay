import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { prepareCloudflareBuildConfig } from "./prepare-cloudflare-build-config.mjs";
import { prepareD1FallbackConfig } from "./prepare-d1-fallback-config.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("private production config generation", () => {
  it("rejects a symlinked Cloudflare build destination without changing its target", async () => {
    await withTemporaryDirectory(async (directory) => {
      const target = path.join(directory, "outside.jsonc");
      const destination = path.join(directory, "wrangler.cloudflare-build.jsonc");
      await writeFile(target, "keep", "utf8");
      await symlink(target, destination);

      await expect(
        prepareCloudflareBuildConfig({
          environment: validBuildEnvironment(),
          sourceConfigPath: path.join(repoRoot, "apps", "worker", "wrangler.jsonc"),
          buildConfigPath: destination,
        }),
      ).rejects.toThrow("not safe to replace");
      await expect(readFile(target, "utf8")).resolves.toBe("keep");
    });
  });

  it("rejects a symlinked fallback input", async () => {
    await withTemporaryDirectory(async (directory) => {
      const target = path.join(directory, "selected-target.jsonc");
      const selected = path.join(directory, "wrangler.cloudflare-build.jsonc");
      await writeFile(target, selectedD1Config(), "utf8");
      await symlink(target, selected);

      await expect(
        prepareD1FallbackConfig({
          environment: { ORANGE_REPLAY_PROD_ANALYTICS_READ_BACKEND: "d1" },
          selectedConfigPath: selected,
          fallbackConfigPath: path.join(directory, "wrangler.d1-fallback.jsonc"),
        }),
      ).rejects.toThrow("not safe to read");
    });
  });

  it("rejects a symlinked fallback destination without changing its target", async () => {
    await withTemporaryDirectory(async (directory) => {
      const selected = path.join(directory, "wrangler.cloudflare-build.jsonc");
      const target = path.join(directory, "outside.jsonc");
      const destination = path.join(directory, "wrangler.d1-fallback.jsonc");
      await writeFile(selected, selectedD1Config(), "utf8");
      await writeFile(target, "keep", "utf8");
      await symlink(target, destination);

      await expect(
        prepareD1FallbackConfig({
          environment: { ORANGE_REPLAY_PROD_ANALYTICS_READ_BACKEND: "d1" },
          selectedConfigPath: selected,
          fallbackConfigPath: destination,
        }),
      ).rejects.toThrow("not safe to replace");
      await expect(readFile(target, "utf8")).resolves.toBe("keep");
    });
  });
});

function validBuildEnvironment() {
  return {
    ORANGE_REPLAY_PROD_KV_ID: "a".repeat(32),
    ORANGE_REPLAY_PROD_D1_ID: "11111111-1111-4111-8111-111111111111",
    CLOUDFLARE_ACCOUNT_ID: "b".repeat(32),
    ORANGE_REPLAY_PROD_ANALYTICS_STREAM_ID: "analytics-stream",
    ORANGE_REPLAY_PROD_ANALYTICS_DELETION_V2_STREAM_ID: "deletion-v2-stream",
    ORANGE_REPLAY_PROD_ANALYTICS_READ_BACKEND: "d1",
    ORANGE_REPLAY_PROD_ANALYTICS_DELETION_READ_VERSION: "v1",
    ORANGE_REPLAY_PROD_PUBLIC_PAGE_ORIGIN: "https://public.example.com",
  };
}

function selectedD1Config() {
  return `{
  "env": {
    "production": {
      "secrets": {
        "required": ["R2_SQL_TOKEN", "ANALYTICS_PURGE_RUNNER_TOKEN"],
      },
      "vars": {
        "ANALYTICS_READ_BACKEND": "d1",
      }
    }
  }
}\n`;
}

async function withTemporaryDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orange-replay-private-config-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
