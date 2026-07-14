import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const runFile = promisify(execFile);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const playerDir = join(repoRoot, "packages/player");
const dashboardDir = join(repoRoot, "apps/dashboard");

describe("player package build", () => {
  it("keeps source exports and includes player styles in the dashboard", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "orange-replay-player-build-"));
    const playerOutput = join(tempDir, "player");
    const dashboardOutput = join(tempDir, "dashboard");
    const packagePath = join(playerDir, "package.json");
    const packageBefore = await readFile(packagePath, "utf8");
    const playerConfig = await readFile(join(playerDir, "vite.config.ts"), "utf8");

    try {
      expect(playerConfig).toContain("exports: false");
      await runFile("vp", ["pack", "--out-dir", playerOutput], {
        cwd: playerDir,
      });
      expect(await readFile(packagePath, "utf8")).toBe(packageBefore);
      await expect(readFile(join(playerOutput, "index.d.mts"), "utf8")).resolves.toContain(
        "OrangePlayer",
      );

      await runFile("vp", ["build", "--outDir", dashboardOutput], {
        cwd: dashboardDir,
      });
      const assetNames = await readdir(join(dashboardOutput, "assets"));
      const styles = await Promise.all(
        assetNames
          .filter((name) => name.endsWith(".css"))
          .map((name) => readFile(join(dashboardOutput, "assets", name), "utf8")),
      );
      const dashboardStyles = styles.join("\n");
      expect(dashboardStyles).toContain("M4%202.5V25");
      expect(dashboardStyles).toContain("drop-shadow(0 1px 2px");
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  }, 30_000);
});
