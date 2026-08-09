import {
  decodeIngestBody,
  manifestKey,
  parseSegment,
  segmentBatch,
  sessionManifestSchema,
  sessionPrefix,
  startWideEvent,
  type ReplayAssetCaptureMessage,
  type SessionManifest,
  type WideEventOutcome,
} from "@orange-replay/shared";
import { expiresAtFromEndedAt } from "../consumer/helpers.ts";
import { shardDb, type Env } from "../env.ts";
import { fetchPublicReplayAsset, safePublicAssetUrl, type ReplayAssetKind } from "./security.ts";

const MAX_SNAPSHOTS = 3;
const MAX_CANDIDATES = 64;
const MAX_CSS_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_NODES = 100_000;
const MAX_PROJECT_FETCHES_PER_DAY = 256;
const MAX_URL_ATTEMPTS_PER_DAY = 2;
const MAX_PROJECT_ASSET_BYTES = 512 * 1024 * 1024;
const MAX_DECODED_BATCH_BYTES = 16 * 1024 * 1024;
const MAX_CAPTURE_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_CAPTURE_SEGMENT_BYTES = 8 * 1024 * 1024;
const ASSET_URL_CACHE_MS = 24 * 60 * 60 * 1_000;
const ASSET_PREFIX = "replay-assets/sha256";
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

export interface AssetCandidate {
  rawUrl: string;
  fetchUrl: string;
  parentHash: string;
}

export function collectReplayAssetCandidatesForTest(
  node: unknown,
  baseUrl: string,
): readonly AssetCandidate[] {
  const state: CaptureState = {
    candidates: [],
    queued: new Set(),
    map: [],
    cssBytesScanned: 0,
    snapshotNodes: 0,
    fetches: 0,
    capturedBytes: 0,
    refsSeen: 0,
    refsRejected: 0,
    cacheHits: 0,
    fetchRejected: 0,
    fetchFailed: 0,
    storageRejected: 0,
  };
  collectSnapshotAssets(node, baseUrl, state);
  return state.candidates;
}

export interface ReplayAssetMapEntry {
  sourceUrl: string;
  parentHash: string;
  assetHash: string;
  contentType: string;
  bytes: number;
  kind: ReplayAssetKind;
}

interface StoredAsset {
  assetHash: string;
  contentType: string;
  bytes: number;
  kind: ReplayAssetKind;
}

interface CaptureState {
  candidates: AssetCandidate[];
  queued: Set<string>;
  map: ReplayAssetMapEntry[];
  cssBytesScanned: number;
  snapshotNodes: number;
  fetches: number;
  capturedBytes: number;
  refsSeen: number;
  refsRejected: number;
  cacheHits: number;
  fetchRejected: number;
  fetchFailed: number;
  storageRejected: number;
}

export async function captureReplayAssets(
  message: ReplayAssetCaptureMessage,
  env: Env,
  attempts: number,
): Promise<void> {
  const event = startWideEvent("worker", "consumer.replay_assets", message.requestId);
  let outcome: WideEventOutcome = "success";
  const state: CaptureState = {
    candidates: [],
    queued: new Set(),
    map: [],
    cssBytesScanned: 0,
    snapshotNodes: 0,
    fetches: 0,
    capturedBytes: 0,
    refsSeen: 0,
    refsRejected: 0,
    cacheHits: 0,
    fetchRejected: 0,
    fetchFailed: 0,
    storageRejected: 0,
  };

  try {
    if (
      (await env.RECORDINGS.head(replayAssetMapKey(message.projectId, message.sessionId))) !== null
    ) {
      event.set({ already_complete: true });
      return;
    }
    const db = shardDb(env, message.shard);
    const projectAllowsAssets = await replayAssetsAreEnabled(db, message.projectId);
    if (projectAllowsAssets !== true) {
      event.set({
        asset_capture_disabled: projectAllowsAssets === false,
        project_missing: projectAllowsAssets === null,
      });
      if (projectAllowsAssets === false) await writeAssetMap(env.RECORDINGS, message, []);
      return;
    }
    const manifest = await readManifest(message, env);
    if (manifest.enc !== undefined) {
      await writeAssetMap(env.RECORDINGS, message, []);
      return;
    }
    const snapshots = await readSnapshotEvents(manifest, env);
    for (const snapshot of snapshots) {
      collectSnapshotAssets(snapshot.node, snapshot.baseUrl, state);
    }

    const blockedHosts = ownServiceHosts(env);
    let transientFetchError: unknown;
    for (let index = 0; index < state.candidates.length && index < MAX_CANDIDATES; index += 1) {
      const candidate = state.candidates[index];
      if (candidate === undefined) continue;
      const urlHash = await sha256Hex(candidate.fetchUrl);
      const cached = await findCachedAsset(db, message.projectId, urlHash);
      if (cached !== null) {
        state.cacheHits += 1;
        await linkSessionAsset(db, message, candidate, urlHash, cached);
        state.map.push(mapEntry(candidate, cached));
        if (cached.kind === "stylesheet") {
          await collectCachedStylesheetAssets(env.RECORDINGS, candidate, cached, state);
        }
        continue;
      }
      if (!(await reserveUrlAttempt(db, message.projectId, urlHash))) continue;
      if (!(await reserveProjectFetch(db, message.projectId))) break;
      state.fetches += 1;

      let fetched;
      try {
        fetched = await fetchPublicReplayAsset(candidate.fetchUrl, { blockedHosts });
      } catch (error) {
        if (isPermanentAssetRejection(error)) state.fetchRejected += 1;
        else {
          state.fetchFailed += 1;
          transientFetchError ??= error;
        }
        continue;
      }
      if (fetched === null) {
        state.fetchRejected += 1;
        continue;
      }
      const stored = await storeAsset(db, env.RECORDINGS, message.projectId, fetched);
      if (stored === null) {
        state.storageRejected += 1;
        continue;
      }
      await rememberFetchedAsset(db, message.projectId, urlHash, stored.assetHash);
      await linkSessionAsset(db, message, candidate, urlHash, stored);
      state.map.push(mapEntry(candidate, stored));
      state.capturedBytes += stored.bytes;

      if (stored.kind === "stylesheet") {
        const css = textDecoder.decode(fetched.bytes);
        collectCssAssets(css, fetched.finalUrl, stored.assetHash, state);
      }
    }

    if (transientFetchError !== undefined) throw transientFetchError;
    await writeAssetMap(env.RECORDINGS, message, state.map);
  } catch (error) {
    outcome = "server_error";
    event.fail(error);
    throw error;
  } finally {
    event.set({
      project_id: message.projectId,
      session_id: message.sessionId,
      candidates: state.candidates.length,
      assets_captured: state.map.length,
      asset_fetches: state.fetches,
      asset_bytes: state.capturedBytes,
      css_bytes_scanned: state.cssBytesScanned,
      asset_refs_seen: state.refsSeen,
      asset_refs_rejected: state.refsRejected,
      asset_cache_hits: state.cacheHits,
      asset_fetch_rejected: state.fetchRejected,
      asset_fetch_failed: state.fetchFailed,
      asset_storage_rejected: state.storageRejected,
      attempts,
    });
    event.emit(outcome);
  }
}

async function replayAssetsAreEnabled(db: D1Database, projectId: string): Promise<boolean | null> {
  const row = await db
    .prepare(`SELECT replay_assets_enabled AS enabled FROM projects WHERE id = ?`)
    .bind(projectId)
    .first<{ enabled: number }>();
  if (row === null) return null;
  return row.enabled === 1;
}

async function readManifest(
  message: ReplayAssetCaptureMessage,
  env: Env,
): Promise<SessionManifest> {
  const expectedKey = manifestKey(message.projectId, message.sessionId);
  if (message.manifestKey !== expectedKey) {
    throw new Error("The replay asset job has the wrong manifest key.");
  }
  const object = await env.RECORDINGS.get(expectedKey);
  if (object === null) throw new Error("The replay manifest is not available yet.");
  if (object.size > MAX_CAPTURE_MANIFEST_BYTES) {
    throw new Error("The replay manifest is too large for asset extraction.");
  }
  const parsed = sessionManifestSchema.safeParse(await object.json());
  if (!parsed.success) throw new Error("The replay manifest is invalid.");
  return parsed.data;
}

interface SnapshotEvent {
  node: unknown;
  baseUrl: string | undefined;
}

async function readSnapshotEvents(manifest: SessionManifest, env: Env): Promise<SnapshotEvent[]> {
  const selected = selectedSnapshotSegments(manifest);
  const snapshots: SnapshotEvent[] = [];
  for (const segment of selected) {
    const object = await env.RECORDINGS.get(segment.key);
    if (
      object === null ||
      object.size !== segment.bytes ||
      object.size > MAX_CAPTURE_SEGMENT_BYTES
    ) {
      continue;
    }
    const parsed = parseSegment(new Uint8Array(await object.arrayBuffer()));
    for (let index = 0; index < parsed.count && snapshots.length < MAX_SNAPSHOTS; index += 1) {
      const batch = segmentBatch(parsed, index);
      let payload = batch;
      let baseUrl = manifest.attrs.entryUrl;
      try {
        const decoded = decodeIngestBody(batch);
        payload = decoded.payload;
        baseUrl = decoded.index.u ?? baseUrl;
      } catch {
        /* old segments stored the compressed replay JSON directly */
      }
      const events = await decodeReplayBatch(payload);
      for (const value of events) {
        if (isRecord(value) && value["type"] === 4) {
          const href = isRecord(value["data"]) ? value["data"]["href"] : undefined;
          if (typeof href === "string") baseUrl = href;
        }
        if (isRecord(value) && value["type"] === 2 && isRecord(value["data"])) {
          snapshots.push({ node: value["data"]["node"], baseUrl });
          if (snapshots.length >= MAX_SNAPSHOTS) break;
        }
      }
    }
    if (snapshots.length >= MAX_SNAPSHOTS) break;
  }
  return snapshots;
}

function selectedSnapshotSegments(manifest: SessionManifest): SessionManifest["segments"] {
  const selected = new Set<number>();
  let checkpoints = 0;
  for (let index = 0; index < manifest.segments.length && checkpoints < MAX_SNAPSHOTS; index += 1) {
    const count = manifest.segments[index]?.checkpoints?.length ?? 0;
    if (count > 0) {
      selected.add(index);
      checkpoints += count;
    }
  }
  if (selected.size === 0 && manifest.segments.length > 0) selected.add(0);
  return [...selected].map((index) => manifest.segments[index]!).slice(0, MAX_SNAPSHOTS);
}

async function decodeReplayBatch(payload: Uint8Array): Promise<unknown[]> {
  let bytes = payload;
  if (typeof DecompressionStream === "function") {
    try {
      const body = new Response(payload as unknown as BodyInit).body;
      if (body !== null)
        bytes = await readDecodedBody(body.pipeThrough(new DecompressionStream("gzip")));
    } catch (error) {
      if (error instanceof Error && error.name === "ReplayAssetDecodeLimitError") throw error;
      bytes = payload;
    }
  }
  if (bytes.byteLength > MAX_DECODED_BATCH_BYTES) throw decodeLimitError();
  const value = JSON.parse(textDecoder.decode(bytes)) as unknown;
  return Array.isArray(value) ? value : [];
}

async function readDecodedBody(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > MAX_DECODED_BATCH_BYTES) {
      await reader.cancel();
      throw decodeLimitError();
    }
    chunks.push(next.value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function decodeLimitError(): Error {
  const error = new Error("Replay asset extraction batch is too large.");
  error.name = "ReplayAssetDecodeLimitError";
  return error;
}

function collectSnapshotAssets(
  root: unknown,
  baseUrl: string | undefined,
  state: CaptureState,
): void {
  const pending: unknown[] = [root];
  while (pending.length > 0 && state.snapshotNodes < MAX_SNAPSHOT_NODES) {
    const node = pending.pop();
    if (!isRecord(node)) continue;
    state.snapshotNodes += 1;
    const tagName = typeof node["tagName"] === "string" ? node["tagName"].toLowerCase() : "";
    const attributes = isRecord(node["attributes"]) ? node["attributes"] : {};
    const rel = typeof attributes["rel"] === "string" ? attributes["rel"].toLowerCase() : "";

    if (tagName === "link" && rel.split(/\s+/).includes("stylesheet")) {
      addCandidate(attributes["href"], baseUrl, "", state);
    }
    if (tagName === "img" || tagName === "image" || tagName === "input") {
      addCandidate(attributes["src"] ?? attributes["rr_src"], baseUrl, "", state);
      collectSrcset(attributes["srcset"] ?? attributes["rrweb-original-srcset"], baseUrl, state);
    }
    addCandidate(attributes["background"], baseUrl, "", state);
    addCandidate(attributes["poster"], baseUrl, "", state);
    if (typeof attributes["style"] === "string") {
      collectCssAssets(attributes["style"], baseUrl, "", state);
    }

    const childNodes = node["childNodes"];
    if (!Array.isArray(childNodes)) continue;
    for (let index = childNodes.length - 1; index >= 0; index -= 1) {
      const child = childNodes[index];
      if (tagName === "style" && isRecord(child) && typeof child["textContent"] === "string") {
        collectCssAssets(child["textContent"], baseUrl, "", state);
      }
      pending.push(child);
    }
  }
}

function collectSrcset(value: unknown, baseUrl: string | undefined, state: CaptureState): void {
  if (typeof value !== "string") return;
  for (const candidate of value.split(",")) {
    addCandidate(candidate.trim().split(/\s+/, 1)[0], baseUrl, "", state);
  }
}

function collectCssAssets(
  css: string,
  baseUrl: string | undefined,
  parentHash: string,
  state: CaptureState,
): void {
  if (state.cssBytesScanned >= MAX_CSS_SCAN_BYTES) return;
  const available = MAX_CSS_SCAN_BYTES - state.cssBytesScanned;
  const bounded = new TextEncoder().encode(css).slice(0, available);
  state.cssBytesScanned += bounded.byteLength;
  const text = new TextDecoder().decode(bounded);
  for (const match of text.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/gis)) {
    addCandidate(match[2], baseUrl, parentHash, state);
  }
  for (const match of text.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']/gis)) {
    addCandidate(match[1], baseUrl, parentHash, state);
  }
}

function addCandidate(
  value: unknown,
  baseUrl: string | undefined,
  parentHash: string,
  state: CaptureState,
): void {
  if (typeof value !== "string") return;
  state.refsSeen += 1;
  if (state.candidates.length >= MAX_CANDIDATES) {
    state.refsRejected += 1;
    return;
  }
  const rawUrl = value.trim();
  if (rawUrl.length === 0 || rawUrl.startsWith("#") || rawUrl.startsWith("data:")) {
    state.refsRejected += 1;
    return;
  }
  const url = safePublicAssetUrl(rawUrl, baseUrl);
  if (url === null) {
    state.refsRejected += 1;
    return;
  }
  const key = `${parentHash}\n${rawUrl}`;
  if (state.queued.has(key)) return;
  state.queued.add(key);
  state.candidates.push({ rawUrl, fetchUrl: url.toString(), parentHash });
}

async function findCachedAsset(
  db: D1Database,
  projectId: string,
  urlHash: string,
): Promise<StoredAsset | null> {
  const row = await db
    .prepare(
      `SELECT o.asset_hash AS assetHash, o.content_type AS contentType, o.bytes,
        CASE
          WHEN o.content_type = 'text/css' THEN 'stylesheet'
          WHEN o.content_type LIKE 'image/%' THEN 'image'
          ELSE 'font'
        END AS kind
      FROM replay_asset_urls u
      JOIN replay_project_assets p
        ON p.project_id = u.project_id AND p.asset_hash = u.asset_hash
      JOIN replay_asset_objects o ON o.asset_hash = u.asset_hash
      WHERE u.project_id = ? AND u.source_url_hash = ? AND u.fetched_at >= ?
      LIMIT 1`,
    )
    .bind(projectId, urlHash, Date.now() - ASSET_URL_CACHE_MS)
    .first<{ assetHash: string; contentType: string; bytes: number; kind: ReplayAssetKind }>();
  return row;
}

async function collectCachedStylesheetAssets(
  bucket: R2Bucket,
  candidate: AssetCandidate,
  cached: StoredAsset,
  state: CaptureState,
): Promise<void> {
  const object = await bucket.get(replayAssetObjectKey(cached.assetHash));
  if (object === null || object.size !== cached.bytes || object.size > MAX_CSS_SCAN_BYTES) return;
  try {
    const css = textDecoder.decode(await object.arrayBuffer());
    collectCssAssets(css, candidate.fetchUrl, cached.assetHash, state);
  } catch {
    /* A broken cached stylesheet is skipped without risking replay playback. */
  }
}

async function rememberFetchedAsset(
  db: D1Database,
  projectId: string,
  urlHash: string,
  assetHash: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO replay_asset_urls (project_id, source_url_hash, asset_hash, fetched_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id, source_url_hash) DO UPDATE SET
        asset_hash = excluded.asset_hash,
        fetched_at = excluded.fetched_at`,
    )
    .bind(projectId, urlHash, assetHash, Date.now())
    .run();
}

async function reserveUrlAttempt(
  db: D1Database,
  projectId: string,
  urlHash: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO replay_asset_attempts (project_id, source_url_hash, day, attempts)
      VALUES (?, ?, ?, 1)
      ON CONFLICT(project_id, source_url_hash, day) DO UPDATE SET attempts = attempts + 1
      WHERE attempts < ?`,
    )
    .bind(projectId, urlHash, utcDay(), MAX_URL_ATTEMPTS_PER_DAY)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

async function reserveProjectFetch(db: D1Database, projectId: string): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO replay_asset_fetch_budgets (project_id, day, fetches)
      VALUES (?, ?, 1)
      ON CONFLICT(project_id, day) DO UPDATE SET fetches = fetches + 1
      WHERE fetches < ?`,
    )
    .bind(projectId, utcDay(), MAX_PROJECT_FETCHES_PER_DAY)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

async function storeAsset(
  db: D1Database,
  bucket: R2Bucket,
  projectId: string,
  fetched: Awaited<ReturnType<typeof fetchPublicReplayAsset>> & {},
): Promise<StoredAsset | null> {
  if (fetched === null) return null;
  const assetHash = await sha256Hex(fetched.bytes);
  const usage = await db
    .prepare(
      `SELECT COALESCE(SUM(bytes), 0) AS bytes,
        MAX(CASE WHEN asset_hash = ? THEN 1 ELSE 0 END) AS alreadyOwned
      FROM replay_project_assets WHERE project_id = ?`,
    )
    .bind(assetHash, projectId)
    .first<{ bytes: number; alreadyOwned: number }>();
  if (
    (usage?.alreadyOwned ?? 0) !== 1 &&
    (usage?.bytes ?? 0) + fetched.bytes.byteLength > MAX_PROJECT_ASSET_BYTES
  ) {
    return null;
  }

  const r2Key = `${ASSET_PREFIX}/${assetHash}`;
  await bucket.put(r2Key, fetched.bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: {
      contentType: fetched.contentType,
      cacheControl: "private, max-age=31536000, immutable",
    },
  });
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO replay_asset_objects
          (asset_hash, r2_key, content_type, bytes, created_at)
        VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(assetHash, r2Key, fetched.contentType, fetched.bytes.byteLength, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO replay_project_assets (project_id, asset_hash, bytes, created_at)
        SELECT ?, ?, ?, ?
        WHERE COALESCE((SELECT SUM(bytes) FROM replay_project_assets WHERE project_id = ?), 0) + ? <= ?
          OR EXISTS (
            SELECT 1 FROM replay_project_assets WHERE project_id = ? AND asset_hash = ?
          )`,
      )
      .bind(
        projectId,
        assetHash,
        fetched.bytes.byteLength,
        now,
        projectId,
        fetched.bytes.byteLength,
        MAX_PROJECT_ASSET_BYTES,
        projectId,
        assetHash,
      ),
  ]);
  const allowed = await db
    .prepare(`SELECT 1 AS ok FROM replay_project_assets WHERE project_id = ? AND asset_hash = ?`)
    .bind(projectId, assetHash)
    .first<{ ok: number }>();
  return allowed === null
    ? null
    : {
        assetHash,
        contentType: fetched.contentType,
        bytes: fetched.bytes.byteLength,
        kind: fetched.kind,
      };
}

async function linkSessionAsset(
  db: D1Database,
  message: ReplayAssetCaptureMessage,
  candidate: AssetCandidate,
  urlHash: string,
  asset: StoredAsset,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO replay_session_assets
        (project_id, session_id, parent_hash, source_url_hash, asset_hash, kind, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      message.projectId,
      message.sessionId,
      candidate.parentHash,
      urlHash,
      asset.assetHash,
      asset.kind,
      Date.now(),
      expiresAtFromEndedAt(message.endedAt, message.retentionDays),
    )
    .run();
}

function mapEntry(candidate: AssetCandidate, asset: StoredAsset): ReplayAssetMapEntry {
  return {
    sourceUrl: candidate.rawUrl,
    parentHash: candidate.parentHash,
    assetHash: asset.assetHash,
    contentType: asset.contentType,
    bytes: asset.bytes,
    kind: asset.kind,
  };
}

async function writeAssetMap(
  bucket: R2Bucket,
  message: ReplayAssetCaptureMessage,
  entries: readonly ReplayAssetMapEntry[],
): Promise<void> {
  await bucket.put(
    replayAssetMapKey(message.projectId, message.sessionId),
    JSON.stringify({ version: 1, entries }),
    {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json", cacheControl: "private, max-age=300" },
    },
  );
}

export function replayAssetMapKey(projectId: string, sessionId: string): string {
  return `${sessionPrefix(projectId, sessionId)}/asset-map.json`;
}

export function replayAssetObjectKey(assetHash: string): string {
  return `${ASSET_PREFIX}/${assetHash}`;
}

function ownServiceHosts(env: Env): string[] {
  return [env.BETTER_AUTH_URL, env.PUBLIC_PAGE_ORIGIN].flatMap((value) => {
    if (value === undefined) return [];
    try {
      return [new URL(value).hostname];
    } catch {
      return [];
    }
  });
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPermanentAssetRejection(error: unknown): boolean {
  return error instanceof Error && error.name === "ReplayAssetRejectedError";
}
