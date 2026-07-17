import { access, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  BackfillCompletionProtocolError,
  backfillArtifactPaths,
  prepareBackfillArtifactPaths,
  publishBackfillApplyArtifacts,
} from "./analytics/backfill-report-protocol.mjs";
import { writePrivateFileOnceAtomically } from "./private-file.mjs";

describe("analytics backfill report protocol", () => {
  it("publishes the immutable audit before D1 completion and the success receipt after it", async () => {
    await withPrivateRoot(async (root) => {
      const artifacts = backfillArtifactPaths(path.join(root, "production-applied.json"));
      await prepareBackfillArtifactPaths(root, artifacts, true);
      const order = [];

      await publishBackfillApplyArtifacts({
        artifacts,
        completedAt: 1_700_000_020_000,
        report: sampleApplyReport(),
        trustedRoot: root,
        writeCompletions: async () => {
          order.push("d1_completion");
          const prepared = JSON.parse(await readFile(artifacts.reportPath, "utf8"));
          expect(prepared.status).toBe("prepared_for_completion");
          expect(prepared.completedAt).toBeNull();
          expect(await pathExists(artifacts.completionReceiptPath)).toBe(false);
        },
      });

      order.push("returned");
      const prepared = JSON.parse(await readFile(artifacts.reportPath, "utf8"));
      const receipt = JSON.parse(await readFile(artifacts.completionReceiptPath, "utf8"));
      expect(order).toEqual(["d1_completion", "returned"]);
      expect(prepared.completionProtocol).toMatchObject({
        state: "pending",
        version: 1,
      });
      expect(receipt).toMatchObject({
        completedAt: "2023-11-14T22:13:40.000Z",
        reportId: "backfill_protocol_test",
        status: "complete",
        type: "analytics_backfill_completion",
      });
      expect(receipt.reportSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(await pathExists(artifacts.failureReceiptPath)).toBe(false);
    });
  });

  it("never calls D1 completion when the prepared report cannot be published", async () => {
    await withPrivateRoot(async (root) => {
      const artifacts = backfillArtifactPaths(path.join(root, "report-write-failed.json"));
      const writeCompletions = vi.fn();

      await expect(
        publishBackfillApplyArtifacts({
          artifacts,
          completedAt: 1_700_000_020_000,
          report: sampleApplyReport(),
          trustedRoot: root,
          writeCompletions,
          writeFile: async () => {
            throw new Error("simulated report disk failure");
          },
        }),
      ).rejects.toThrow("simulated report disk failure");

      expect(writeCompletions).not.toHaveBeenCalled();
      expect(await pathExists(artifacts.completionReceiptPath)).toBe(false);
      expect(await pathExists(artifacts.failureReceiptPath)).toBe(false);
    });
  });

  it("rejects a planted completion-receipt link before any D1 work", async () => {
    await withPrivateRoot(async (root) => {
      const artifacts = backfillArtifactPaths(path.join(root, "linked-receipt.json"));
      const targetPath = path.join(root, "target.json");
      await writePrivateFileOnceAtomically(targetPath, "unchanged\n", root);
      await symlink(targetPath, artifacts.completionReceiptPath);

      await expect(prepareBackfillArtifactPaths(root, artifacts, true)).rejects.toThrow(
        "already exists",
      );
      expect(await readFile(targetPath, "utf8")).toBe("unchanged\n");
    });
  });

  it("keeps only a pending audit and failure receipt when D1 completion fails", async () => {
    await withPrivateRoot(async (root) => {
      const artifacts = backfillArtifactPaths(path.join(root, "completion-failed.json"));
      await prepareBackfillArtifactPaths(root, artifacts, true);

      const failure = await publishBackfillApplyArtifacts({
        artifacts,
        completedAt: 1_700_000_020_000,
        report: sampleApplyReport(),
        trustedRoot: root,
        writeCompletions: async () => {
          expect(await pathExists(artifacts.reportPath)).toBe(true);
          throw new Error("simulated D1 completion failure");
        },
      }).catch((error) => error);

      expect(failure).toBeInstanceOf(BackfillCompletionProtocolError);
      expect(failure).toMatchObject({
        allCompletionMarkersWritten: false,
        phase: "d1_completion",
        preparedArtifactPublished: true,
      });
      const prepared = JSON.parse(await readFile(artifacts.reportPath, "utf8"));
      const failureReceipt = JSON.parse(await readFile(artifacts.failureReceiptPath, "utf8"));
      expect(prepared.status).toBe("prepared_for_completion");
      expect(prepared.completedAt).toBeNull();
      expect(failureReceipt).toMatchObject({
        d1Completion: "failed_or_partial",
        phase: "d1_completion",
        status: "failed",
      });
      expect(await pathExists(artifacts.completionReceiptPath)).toBe(false);
    });
  });

  it("does not claim the D1 completion failed when only its local receipt fails", async () => {
    await withPrivateRoot(async (root) => {
      const artifacts = backfillArtifactPaths(path.join(root, "receipt-failed.json"));
      await prepareBackfillArtifactPaths(root, artifacts, true);

      const failure = await publishBackfillApplyArtifacts({
        artifacts,
        completedAt: 1_700_000_020_000,
        report: sampleApplyReport(),
        trustedRoot: root,
        writeCompletions: async () => undefined,
        writeFile: async (filePath, contents, trustedRoot) => {
          if (filePath === artifacts.completionReceiptPath) {
            throw new Error("simulated receipt disk failure");
          }
          await writePrivateFileOnceAtomically(filePath, contents, trustedRoot);
        },
      }).catch((error) => error);

      expect(failure).toBeInstanceOf(BackfillCompletionProtocolError);
      expect(failure).toMatchObject({
        allCompletionMarkersWritten: true,
        phase: "completion_receipt",
        preparedArtifactPublished: true,
      });
      const prepared = JSON.parse(await readFile(artifacts.reportPath, "utf8"));
      const failureReceipt = JSON.parse(await readFile(artifacts.failureReceiptPath, "utf8"));
      expect(prepared.status).toBe("prepared_for_completion");
      expect(failureReceipt).toMatchObject({
        d1Completion: "complete",
        phase: "completion_receipt",
        status: "failed",
      });
      expect(await pathExists(artifacts.completionReceiptPath)).toBe(false);
    });
  });

  it("does not publish a conflicting failure receipt when success was already published", async () => {
    await withPrivateRoot(async (root) => {
      const artifacts = backfillArtifactPaths(path.join(root, "post-publish-error.json"));
      await prepareBackfillArtifactPaths(root, artifacts, true);

      await publishBackfillApplyArtifacts({
        artifacts,
        completedAt: 1_700_000_020_000,
        report: sampleApplyReport(),
        trustedRoot: root,
        writeCompletions: async () => undefined,
        writeFile: async (filePath, contents, trustedRoot) => {
          await writePrivateFileOnceAtomically(filePath, contents, trustedRoot);
          if (filePath === artifacts.completionReceiptPath) {
            throw new Error("simulated error after receipt publication");
          }
        },
      });

      const completionReceipt = JSON.parse(await readFile(artifacts.completionReceiptPath, "utf8"));
      expect(completionReceipt.status).toBe("complete");
      expect(await pathExists(artifacts.failureReceiptPath)).toBe(false);
    });
  });

  it("keeps one success receipt when its directory sync cannot be confirmed", async () => {
    await withPrivateRoot(async (root) => {
      const artifacts = backfillArtifactPaths(path.join(root, "receipt-sync-error.json"));
      await prepareBackfillArtifactPaths(root, artifacts, true);

      const failure = await publishBackfillApplyArtifacts({
        artifacts,
        completedAt: 1_700_000_020_000,
        confirmFile: async () => ({
          durable: false,
          error: new Error("simulated repeated directory sync failure"),
          published: true,
        }),
        report: sampleApplyReport(),
        trustedRoot: root,
        writeCompletions: async () => undefined,
        writeFile: async (filePath, contents, trustedRoot) => {
          await writePrivateFileOnceAtomically(filePath, contents, trustedRoot);
          if (filePath === artifacts.completionReceiptPath) {
            throw new Error("simulated error after receipt publication");
          }
        },
      }).catch((error) => error);

      expect(failure).toBeInstanceOf(BackfillCompletionProtocolError);
      expect(failure).toMatchObject({
        completionReceiptPublished: true,
        failureReceiptRequired: false,
        phase: "completion_receipt_sync",
      });
      expect(await pathExists(artifacts.completionReceiptPath)).toBe(true);
      expect(await pathExists(artifacts.failureReceiptPath)).toBe(false);
    });
  });

  it("does not create a failure receipt when the success path cannot be inspected", async () => {
    await withPrivateRoot(async (root) => {
      const artifacts = backfillArtifactPaths(path.join(root, "receipt-state-unknown.json"));
      await prepareBackfillArtifactPaths(root, artifacts, true);

      const failure = await publishBackfillApplyArtifacts({
        artifacts,
        completedAt: 1_700_000_020_000,
        confirmFile: async () => {
          throw new Error("simulated receipt inspection failure");
        },
        report: sampleApplyReport(),
        trustedRoot: root,
        writeCompletions: async () => undefined,
        writeFile: async (filePath, contents, trustedRoot) => {
          if (filePath === artifacts.completionReceiptPath) {
            throw new Error("simulated receipt write failure");
          }
          await writePrivateFileOnceAtomically(filePath, contents, trustedRoot);
        },
      }).catch((error) => error);

      expect(failure).toBeInstanceOf(BackfillCompletionProtocolError);
      expect(failure).toMatchObject({
        failureReceiptRequired: false,
        phase: "completion_receipt_state",
      });
      expect(await pathExists(artifacts.failureReceiptPath)).toBe(false);
    });
  });
});

function sampleApplyReport() {
  return {
    completedAt: null,
    mode: "apply",
    projects: [{ projectId: "project_1", requiredSequence: 4, sourceSessionCount: 2 }],
    reportId: "backfill_protocol_test",
    startedAt: "2023-11-14T22:13:00.000Z",
    status: "running",
    totals: { migrated: 2 },
  };
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function withPrivateRoot(run) {
  const root = await mkdtemp(path.join(tmpdir(), "orange-replay-backfill-protocol-"));
  try {
    await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}
