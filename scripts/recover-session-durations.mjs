// Recover recorded-time durations and the playability fact for sessions
// indexed before docs/specs/fix-zero-duration-sessions.md landed.
//
// Reads each session's immutable manifest from the local R2 store, recomputes
// duration_ms from segment t0/t1 (recorded event time) and has_checkpoint
// from segment checkpoint metadata, then updates the local D1 sessions table.
// Manifests and segments are never modified and nothing is decompressed.
// Manifests written before checkpoint metadata existed stay NULL (unknown).
//
// Dry-run by default; pass --apply to write. Stop `vp run dev` first so the
// database is not written concurrently. A timestamped backup of the D1 file
// is created before any write. Hosted/production data is out of scope here:
// re-export corrected rows through the analytics backfill tooling
// (docs/specs/f4-r2-analytics-cutover.md), never with raw warehouse updates.
//
// Usage: node scripts/recover-session-durations.mjs [--apply]
//   [--d1 <path to miniflare D1 .sqlite>] [--r2 <path to .wrangler r2 dir>]

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { recoverManifestSessionFacts } from "./analytics/backfill-lib.mjs";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const workerDir = resolve(import.meta.dirname, "../apps/worker");
const d1Path =
  argValue("--d1") ??
  findLargestSqlite(join(workerDir, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject"));
const r2Dir = argValue("--r2") ?? join(workerDir, ".wrangler/state/v3/r2");

if (d1Path === undefined || !existsSync(r2Dir)) {
  console.error("Could not find the local D1 database or R2 state directory.");
  console.error("Pass --d1 and --r2 explicitly, or run `vp run dev` once to create them.");
  process.exit(1);
}

const objectsDbPath = findLargestSqlite(join(r2Dir, "miniflare-R2BucketObject"));
const blobsDir = findBlobsDir(r2Dir);
if (objectsDbPath === undefined || blobsDir === undefined) {
  console.error("Could not find the local R2 object metadata or blobs directory under", r2Dir);
  process.exit(1);
}

const db = new DatabaseSync(d1Path, { readOnly: !apply });
const objectsDb = new DatabaseSync(objectsDbPath, { readOnly: true });
const manifestBlobs = new Map(
  objectsDb
    .prepare("SELECT key, blob_id FROM _mf_objects WHERE key LIKE '%/manifest.json'")
    .all()
    .map((row) => [row.key, row.blob_id]),
);

const sessions = db
  .prepare("SELECT project_id, session_id, manifest_key, duration_ms, has_checkpoint FROM sessions")
  .all();

const summary = {
  sessions: sessions.length,
  manifestMissing: 0,
  manifestInvalid: 0,
  unchanged: 0,
  durationCorrected: 0,
  checkpointMarked: 0,
  applied: apply,
};
const updates = [];

for (const row of sessions) {
  const blobId = manifestBlobs.get(row.manifest_key);
  if (blobId === undefined) {
    summary.manifestMissing += 1;
    continue;
  }

  let recoveryFacts;
  try {
    recoveryFacts = recoverManifestSessionFacts(
      readFileSync(join(blobsDir, String(blobId)), "utf8"),
    );
  } catch {
    summary.manifestInvalid += 1;
    continue;
  }
  const durationMs = recoveryFacts.durationMs;
  // Preserve the existing value only for legacy manifests that predate
  // checkpoint arrays. Current manifests with empty arrays confirm false.
  const hasCheckpoint = recoveryFacts.hasCheckpoint ?? row.has_checkpoint;

  if (durationMs === row.duration_ms && hasCheckpoint === row.has_checkpoint) {
    summary.unchanged += 1;
    continue;
  }

  if (durationMs !== row.duration_ms) summary.durationCorrected += 1;
  if (hasCheckpoint !== row.has_checkpoint) summary.checkpointMarked += 1;
  updates.push({
    project_id: row.project_id,
    session_id: row.session_id,
    from_ms: row.duration_ms,
    to_ms: durationMs,
    has_checkpoint: hasCheckpoint,
  });
}

if (apply && updates.length > 0) {
  const backupDir = join(workerDir, ".wrangler/backups");
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  copyFileSync(d1Path, join(backupDir, `local-d1-before-duration-recovery-${stamp}.sqlite`));

  const update = db.prepare(
    "UPDATE sessions SET duration_ms = ?, has_checkpoint = ? WHERE project_id = ? AND session_id = ?",
  );
  db.exec("BEGIN");
  for (const change of updates) {
    update.run(change.to_ms, change.has_checkpoint, change.project_id, change.session_id);
  }
  db.exec("COMMIT");
}

for (const change of updates.slice(0, 20)) {
  const line = [
    String(change.session_id),
    `${Number(change.from_ms)}ms -> ${Number(change.to_ms)}ms`,
    `has_checkpoint=${change.has_checkpoint === null ? "NULL" : Number(change.has_checkpoint)}`,
  ].join("  ");
  console.log(line);
}
if (updates.length > 20) console.log(`… and ${updates.length - 20} more`);
console.log(JSON.stringify({ event: "recover_session_durations", ...summary }));
if (!apply && updates.length > 0) {
  console.log(`Dry run: ${updates.length} rows would change. Re-run with --apply to write.`);
}

function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function findLargestSqlite(dir) {
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sqlite") && name !== "metadata.sqlite")
    .map((name) => join(dir, name))
    .sort((left, right) => statSync(right).size - statSync(left).size);
  return files[0];
}

function findBlobsDir(dir) {
  for (const entry of readdirSync(dir)) {
    const candidate = join(dir, entry, "blobs");
    if (entry !== "miniflare-R2BucketObject" && existsSync(candidate)) return candidate;
  }
  return undefined;
}
