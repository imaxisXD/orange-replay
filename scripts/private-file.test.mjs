import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { preparePrivateOutputDirectory, writePrivateFileOnceAtomically } from "./private-file.mjs";

describe("private report files", () => {
  it("creates private directories and a private report", async () => {
    await withPrivateRoot(async (root) => {
      const directory = path.join(root, "audits", "analytics-acceptance");
      const reportPath = path.join(directory, "report.json");

      await preparePrivateOutputDirectory(root, directory);
      await writePrivateFileOnceAtomically(reportPath, '{"match":true}\n', root);

      expect(await readFile(reportPath, "utf8")).toBe('{"match":true}\n');
      expect((await stat(path.join(root, "audits"))).mode & 0o777).toBe(0o700);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
    });
  });

  it("rejects a destination link without changing its target", async () => {
    await withPrivateRoot(async (root) => {
      const directory = path.join(root, "reports");
      const targetPath = path.join(root, "target.json");
      const reportPath = path.join(directory, "report.json");
      await mkdir(directory, { mode: 0o700 });
      await writePrivateFileOnceAtomically(targetPath, "unchanged\n", root);
      await symlink(targetPath, reportPath);

      await expect(writePrivateFileOnceAtomically(reportPath, "secret\n", root)).rejects.toThrow(
        "already exists",
      );
      expect(await readFile(targetPath, "utf8")).toBe("unchanged\n");
    });
  });

  it("rejects a linked directory below the trusted root", async () => {
    await withPrivateRoot(async (root) => {
      const actualDirectory = path.join(root, "actual");
      const linkedDirectory = path.join(root, "linked");
      await mkdir(actualDirectory, { mode: 0o700 });
      await symlink(actualDirectory, linkedDirectory);

      await expect(
        preparePrivateOutputDirectory(root, path.join(linkedDirectory, "reports")),
      ).rejects.toThrow("symbolic link");
    });
  });

  it("rejects a directory writable by another user group", async () => {
    await withPrivateRoot(async (root) => {
      const directory = path.join(root, "shared");
      await mkdir(directory, { mode: 0o700 });
      await chmod(directory, 0o770);

      await expect(preparePrivateOutputDirectory(root, directory)).rejects.toThrow(
        "must not be writable",
      );
    });
  });

  it("rejects a private root below a writable non-sticky ancestor", async () => {
    await withPrivateRoot(async (root) => {
      const sharedDirectory = path.join(root, "shared");
      const trustedRoot = path.join(sharedDirectory, "owned");
      await mkdir(sharedDirectory, { mode: 0o700 });
      await mkdir(trustedRoot, { mode: 0o700 });
      await chmod(sharedDirectory, 0o777);

      await expect(
        preparePrivateOutputDirectory(trustedRoot, path.join(trustedRoot, "reports")),
      ).rejects.toThrow("unsafe writable ancestor");
    });
  });

  it("allows a private root below a sticky shared ancestor", async () => {
    await withPrivateRoot(async (root) => {
      const sharedDirectory = path.join(root, "shared");
      const trustedRoot = path.join(sharedDirectory, "owned");
      const reportPath = path.join(trustedRoot, "report.json");
      await mkdir(sharedDirectory, { mode: 0o700 });
      await chmod(sharedDirectory, 0o1777);
      await mkdir(trustedRoot, { mode: 0o700 });

      await writePrivateFileOnceAtomically(reportPath, "safe\n", trustedRoot);

      expect(await readFile(reportPath, "utf8")).toBe("safe\n");
    });
  });

  it("never overwrites an existing report", async () => {
    await withPrivateRoot(async (root) => {
      const reportPath = path.join(root, "report.json");
      await writePrivateFileOnceAtomically(reportPath, "first\n", root);

      await expect(writePrivateFileOnceAtomically(reportPath, "second\n", root)).rejects.toThrow(
        "already exists",
      );
      expect(await readFile(reportPath, "utf8")).toBe("first\n");
    });
  });

  it("publishes one complete report when two writers race", async () => {
    await withPrivateRoot(async (root) => {
      const reportPath = path.join(root, "report.json");
      const results = await Promise.allSettled([
        writePrivateFileOnceAtomically(reportPath, "first\n", root),
        writePrivateFileOnceAtomically(reportPath, "second\n", root),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(["first\n", "second\n"]).toContain(await readFile(reportPath, "utf8"));
      expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    });
  });

  it("cleans up its temporary file after a publish failure", async () => {
    await withPrivateRoot(async (root) => {
      const reportPath = path.join(root, "report.json");
      await mkdir(reportPath, { mode: 0o700 });

      await expect(writePrivateFileOnceAtomically(reportPath, "secret\n", root)).rejects.toThrow(
        "already exists",
      );
      expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      expect((await lstat(reportPath)).isDirectory()).toBe(true);
    });
  });
});

async function withPrivateRoot(run) {
  const root = await mkdtemp(path.join(tmpdir(), "orange-replay-private-file-"));
  try {
    await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}
