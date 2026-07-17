import { createHash } from "node:crypto";
import path from "node:path";
import {
  confirmPrivateFilePublication,
  preparePrivateOutputFile,
  writePrivateFileOnceAtomically,
} from "../private-file.mjs";

const PROTOCOL_VERSION = 1;

export class BackfillCompletionProtocolError extends Error {
  constructor(message, options) {
    super(message, { cause: options.cause });
    this.name = "BackfillCompletionProtocolError";
    this.phase = options.phase;
    this.preparedArtifactPublished = true;
    this.allCompletionMarkersWritten = options.allCompletionMarkersWritten;
    this.completionReceiptPublished = options.completionReceiptPublished ?? false;
    this.failureReceiptPublished = options.failureReceiptPublished;
    this.failureReceiptRequired = options.failureReceiptRequired ?? true;
  }
}

export function backfillArtifactPaths(reportPath) {
  const resolvedReportPath = path.resolve(reportPath);
  const extension = path.extname(resolvedReportPath);
  const basename = path.basename(resolvedReportPath, extension);
  const suffix = extension || ".json";
  const directory = path.dirname(resolvedReportPath);
  return {
    reportPath: resolvedReportPath,
    completionReceiptPath: path.join(directory, `${basename}.completion${suffix}`),
    failureReceiptPath: path.join(directory, `${basename}.completion-failed${suffix}`),
  };
}

export async function prepareBackfillArtifactPaths(trustedRoot, artifacts, apply) {
  await preparePrivateOutputFile(trustedRoot, artifacts.reportPath);
  if (!apply) return;
  await preparePrivateOutputFile(trustedRoot, artifacts.completionReceiptPath);
  await preparePrivateOutputFile(trustedRoot, artifacts.failureReceiptPath);
}

export async function publishBackfillApplyArtifacts({
  artifacts,
  completedAt,
  confirmFile = confirmPrivateFilePublication,
  report,
  trustedRoot,
  writeCompletions,
  writeFile = writePrivateFileOnceAtomically,
}) {
  requireApplyReport(report);
  const completedAtText = completionTimeText(completedAt);
  if (typeof writeCompletions !== "function") {
    throw new Error("Backfill completion needs a D1 completion writer.");
  }

  const preparedReport = {
    ...report,
    completedAt: null,
    status: "prepared_for_completion",
    completionProtocol: {
      version: PROTOCOL_VERSION,
      state: "pending",
      completionMarkerTimestamp: completedAtText,
      completionReceiptFile: path.basename(artifacts.completionReceiptPath),
      failureReceiptFile: path.basename(artifacts.failureReceiptPath),
    },
  };
  const preparedText = jsonText(preparedReport);
  const reportSha256 = createHash("sha256").update(preparedText).digest("hex");

  // The immutable audit must exist before any D1 completion marker can be written.
  await writeFile(artifacts.reportPath, preparedText, trustedRoot);

  try {
    await writeCompletions();
  } catch (error) {
    const failureReceiptPublished = await tryWriteFailureReceipt({
      artifacts,
      completedAtText,
      d1Completion: "failed_or_partial",
      error,
      phase: "d1_completion",
      report,
      reportSha256,
      trustedRoot,
      writeFile,
    });
    throw new BackfillCompletionProtocolError(
      `Analytics backfill could not write every D1 completion marker: ${safeErrorMessage(error)}`,
      {
        cause: error,
        allCompletionMarkersWritten: false,
        failureReceiptPublished,
        phase: "d1_completion",
      },
    );
  }

  const completionReceipt = {
    version: PROTOCOL_VERSION,
    type: "analytics_backfill_completion",
    status: "complete",
    completedAt: completedAtText,
    reportFile: path.basename(artifacts.reportPath),
    reportId: report.reportId,
    reportSha256,
    projects: report.projects,
  };
  const completionText = jsonText(completionReceipt);
  try {
    await writeFile(artifacts.completionReceiptPath, completionText, trustedRoot);
  } catch (error) {
    const confirmation = await confirmPublishedReceipt(
      confirmFile,
      artifacts.completionReceiptPath,
      completionText,
      trustedRoot,
    );
    if (confirmation.published && confirmation.durable) {
      // The create-once receipt and its directory are durable. The writer only
      // failed after completing the required publication steps.
    } else if (confirmation.published) {
      throw new BackfillCompletionProtocolError(
        `D1 completion and its local receipt succeeded, but directory durability could not be confirmed: ${safeErrorMessage(confirmation.error ?? error)}`,
        {
          cause: confirmation.error ?? error,
          allCompletionMarkersWritten: true,
          completionReceiptPublished: true,
          failureReceiptPublished: false,
          failureReceiptRequired: false,
          phase: "completion_receipt_sync",
        },
      );
    } else if (!confirmation.missing) {
      throw new BackfillCompletionProtocolError(
        `D1 completion succeeded, but the local receipt path could not be safely confirmed: ${safeErrorMessage(error)}`,
        {
          cause: error,
          allCompletionMarkersWritten: true,
          completionReceiptPublished: false,
          failureReceiptPublished: false,
          failureReceiptRequired: false,
          phase: "completion_receipt_state",
        },
      );
    } else {
      const failureReceiptPublished = await tryWriteFailureReceipt({
        artifacts,
        completedAtText,
        d1Completion: "complete",
        error,
        phase: "completion_receipt",
        report,
        reportSha256,
        trustedRoot,
        writeFile,
      });
      throw new BackfillCompletionProtocolError(
        `D1 completion succeeded, but its local completion receipt could not be published: ${safeErrorMessage(error)}`,
        {
          cause: error,
          allCompletionMarkersWritten: true,
          failureReceiptPublished,
          phase: "completion_receipt",
        },
      );
    }
  }

  return {
    completionReceiptPath: artifacts.completionReceiptPath,
    reportPath: artifacts.reportPath,
    reportSha256,
  };
}

async function confirmPublishedReceipt(confirmFile, filePath, contents, trustedRoot) {
  try {
    const result = await confirmFile(filePath, contents, trustedRoot);
    if (
      typeof result === "object" &&
      result !== null &&
      (result.published === true || result.missing === true) &&
      typeof result.durable === "boolean"
    ) {
      return result;
    }
  } catch {
    // The original writer error remains the useful failure when confirmation
    // cannot safely prove that the receipt was published.
  }
  return { durable: false, missing: false, published: false };
}

async function tryWriteFailureReceipt({
  artifacts,
  completedAtText,
  d1Completion,
  error,
  phase,
  report,
  reportSha256,
  trustedRoot,
  writeFile,
}) {
  const receipt = {
    version: PROTOCOL_VERSION,
    type: "analytics_backfill_completion_failure",
    status: "failed",
    failedAt: new Date().toISOString(),
    phase,
    d1Completion,
    completionMarkerTimestamp: completedAtText,
    reportFile: path.basename(artifacts.reportPath),
    reportId: report.reportId,
    reportSha256,
    error: safeErrorMessage(error),
    ...errorKind(error),
  };
  try {
    await writeFile(artifacts.failureReceiptPath, jsonText(receipt), trustedRoot);
    return true;
  } catch {
    return false;
  }
}

function requireApplyReport(report) {
  if (typeof report !== "object" || report === null || Array.isArray(report)) {
    throw new Error("Backfill completion needs an audit report.");
  }
  if (report.mode !== "apply") {
    throw new Error("Backfill completion artifacts are only valid in apply mode.");
  }
  if (typeof report.reportId !== "string" || report.reportId.length === 0) {
    throw new Error("Backfill completion needs a report id.");
  }
  if (!Array.isArray(report.projects)) {
    throw new Error("Backfill completion needs the reviewed project list.");
  }
}

function completionTimeText(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Backfill completion time must be a positive whole number.");
  }
  return new Date(value).toISOString();
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function safeErrorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 1_000 ? message : message.slice(0, 1_000);
}

function errorKind(error) {
  if (
    typeof error === "object" &&
    error !== null &&
    typeof error.kind === "string" &&
    error.kind.length > 0
  ) {
    return { errorKind: error.kind.slice(0, 100) };
  }
  return {};
}
