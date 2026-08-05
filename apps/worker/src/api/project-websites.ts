import {
  MAX_PROJECT_WEBSITE_BODY_BYTES,
  ensureProjectWebsiteRequestSchema,
  uuidv7,
  websiteAllowedOrigins,
  websiteNameFromUrl,
  type EnsureProjectWebsiteResponse,
  type ProjectKeyAudit,
  type ProjectWebsite,
  type ProjectWebsiteInstallStatus,
  type ProjectWebsitesResponse,
  type WideEventLogger,
} from "@orange-replay/shared";
import { configKvKey } from "@orange-replay/shared/constants";
import { shardDb, type Env } from "../env.ts";
import {
  createProjectRecorderKey,
  refreshProjectConfigDelivery,
  revokeProjectRecorderKey,
} from "../project-config/delivery.ts";
import { readStoredProjectConfig } from "../project-config/storage.ts";
import { jsonError, jsonResponse, readJsonBodyCapped } from "../http.ts";
import type { SessionAuthContext } from "./auth.ts";
import { keyManagementRateLimitAllows } from "./project-keys.ts";
import { nextWorkspaceCookieDomain } from "./project-website-domain.ts";

interface WebsiteSummaryRow {
  [key: string]: unknown;
  id: string;
  name: string;
  origin: string;
  first_event_at: number | null;
}

interface WebsiteRow extends WebsiteSummaryRow {
  allowed_origins: string;
  created_at: number;
  recorder_key_id: string | null;
  recorder_secret_ciphertext: string | null;
  recorder_secret_iv: string | null;
}

interface WebsiteConfigRow {
  [key: string]: unknown;
  id: string;
  origin: string;
  allowed_origins: string;
  created_at: number;
}

interface WebsiteKeyRow {
  [key: string]: unknown;
  id: string;
  name: string;
  key_hash: string;
  key_hash_prefix: string;
  active: number;
  created_at: number;
  created_by: string | null;
  revoked_at: number | null;
  revoked_by: string | null;
}

export async function ensureProjectWebsite(
  request: Request,
  env: Env,
  projectId: string,
  auth: SessionAuthContext,
  wideEvent: WideEventLogger,
): Promise<Response> {
  const body = await readJsonBodyCapped(request, MAX_PROJECT_WEBSITE_BODY_BYTES);
  if (!body.ok) return jsonError(body.error, body.status);
  const parsed = ensureProjectWebsiteRequestSchema.safeParse(body.value);
  if (!parsed.success) return jsonError("invalid_website", 400);
  if (!(await keyManagementRateLimitAllows(env, projectId, auth))) {
    return jsonError("rate_limited", 429);
  }

  const config = await readStoredProjectConfig(env, projectId);
  if (config === null) return jsonError("not_found", 404);

  const database = shardDb(env, 0);
  const url = parsed.data.website;
  const origin = url.origin;
  const websiteName = websiteNameFromUrl(url);
  const actorId = auth.hostedSession.user.id;
  let websiteWasCreated = false;
  let website: WebsiteRow | null;

  if (parsed.data.websiteId === undefined) {
    const now = Date.now();
    const proposedWebsiteId = `website_${uuidv7()}`;
    const insertResult = await database
      .prepare(
        `INSERT OR IGNORE INTO project_websites
          (id, project_id, name, origin, allowed_origins, first_event_at,
            recorder_key_id, recorder_secret_ciphertext, recorder_secret_iv,
            created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`,
      )
      .bind(
        proposedWebsiteId,
        projectId,
        websiteName,
        origin,
        JSON.stringify(websiteAllowedOrigins(url)),
        actorId,
        now,
        now,
      )
      .run();
    websiteWasCreated = (insertResult.meta.changes ?? 0) > 0;
    website = await readWebsite(database, projectId, origin);
  } else {
    const edited = await editPendingWebsite(
      env,
      database,
      projectId,
      parsed.data.websiteId,
      url,
      websiteName,
    );
    if (edited.status !== "ready") return pendingWebsiteEditError(edited.status);
    website = edited.website;
    if (edited.edited) wideEvent.set({ website_id: website.id, website_edited: true });
  }

  if (website === null) return jsonError("website_create_failed", 500);
  await mergeWebsiteIntoWorkspace(env, projectId, url, websiteName);

  let key = await readActiveWebsiteKey(database, projectId, website.id);
  if (website.first_event_at !== null) {
    wideEvent.set({ website_id: website.id, website_already_connected: true });
    return websiteResponse(website, key === null ? null : keyAudit(key), null, true, false);
  }

  if (key !== null) {
    const secret = await decryptWebsiteSecret(env, website, key.id);
    if (secret === null) return jsonError("website_key_unavailable", 503);
    wideEvent.set({ website_id: website.id, website_key_reused: true });
    return websiteResponse(website, keyAudit(key), secret, false, websiteWasCreated);
  }

  const created = await createProjectRecorderKey(
    env,
    projectId,
    `${websiteName} recorder`.slice(0, 64),
    actorId,
  );
  if (created.status !== "created") return createKeyError(created.status);

  try {
    const encrypted = await encryptWebsiteSecret(env, created.secret, website.id, created.key.id);
    await database.batch([
      database
        .prepare(
          `UPDATE keys
          SET website_id = ?, cache_synced = 0
          WHERE id = ? AND project_id = ? AND active = 1`,
        )
        .bind(website.id, created.key.id, projectId),
      database
        .prepare(
          `UPDATE project_websites
          SET recorder_key_id = ?, recorder_secret_ciphertext = ?, recorder_secret_iv = ?,
            updated_at = ?
          WHERE id = ? AND project_id = ? AND recorder_key_id IS NULL`,
        )
        .bind(
          created.key.id,
          encrypted.ciphertext,
          encrypted.iv,
          Date.now(),
          website.id,
          projectId,
        ),
    ]);
  } catch {
    await revokeProjectRecorderKey(env, projectId, created.key.id, actorId);
    website = await readWebsite(database, projectId, origin);
    key = website === null ? null : await readActiveWebsiteKey(database, projectId, website.id);
    if (website === null || key === null) return jsonError("website_key_unavailable", 503);
    const secret = await decryptWebsiteSecret(env, website, key.id);
    if (secret === null) return jsonError("website_key_unavailable", 503);
    return websiteResponse(website, keyAudit(key), secret, false, websiteWasCreated);
  }

  await refreshProjectConfigDelivery(env, projectId);
  website = await readWebsite(database, projectId, origin);
  if (website === null) return jsonError("website_create_failed", 500);
  wideEvent.set({ website_id: website.id, recorder_key_id: created.key.id });
  return websiteResponse(website, created.key, created.secret, false, websiteWasCreated);
}

type PendingWebsiteEditResult =
  | { status: "ready"; website: WebsiteRow; edited: boolean }
  | { status: "not_found" | "already_connected" | "origin_taken" | "changed" };

function pendingWebsiteEditError(
  status: Exclude<PendingWebsiteEditResult["status"], "ready">,
): Response {
  if (status === "not_found") return jsonError("website_not_found", 404);
  if (status === "already_connected") return jsonError("website_not_editable", 409);
  if (status === "origin_taken") return jsonError("website_already_exists", 409);
  return jsonError("website_changed", 409);
}

/** Update one unfinished Website in place so Back never creates a hidden key or Website. */
async function editPendingWebsite(
  env: Env,
  database: D1Database,
  projectId: string,
  websiteId: string,
  nextUrl: URL,
  nextName: string,
): Promise<PendingWebsiteEditResult> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await readWebsiteById(database, projectId, websiteId);
    if (current === null) return { status: "not_found" };
    if (current.first_event_at !== null) return { status: "already_connected" };
    if (current.origin === nextUrl.origin) {
      return { status: "ready", website: current, edited: false };
    }

    const sameOrigin = await readWebsite(database, projectId, nextUrl.origin);
    if (sameOrigin !== null && sameOrigin.id !== current.id) return { status: "origin_taken" };

    const config = await readStoredProjectConfig(env, projectId);
    if (config === null) return { status: "not_found" };
    const websiteRows = await readWebsiteConfigRows(database, projectId);
    const nextAllowedOrigins = workspaceOriginsAfterWebsiteEdit(
      config.allowedOrigins,
      websiteRows,
      current,
      nextUrl,
    );
    const nextCookieDomain = workspaceCookieDomainAfterWebsiteEdit(
      websiteRows,
      current.id,
      nextUrl,
    );
    const editedAt = Date.now() + attempt;
    let results: D1Result[];
    try {
      results = await database.batch([
        database
          .prepare(
            `UPDATE project_websites
            SET name = ?, origin = ?, allowed_origins = ?, updated_at = ?
            WHERE id = ? AND project_id = ? AND origin = ? AND first_event_at IS NULL
              AND EXISTS (
                SELECT 1 FROM projects WHERE id = ? AND config_version = ?
              )`,
          )
          .bind(
            nextName,
            nextUrl.origin,
            JSON.stringify(websiteAllowedOrigins(nextUrl)),
            editedAt,
            current.id,
            projectId,
            current.origin,
            projectId,
            config.version,
          ),
        database
          .prepare(
            `UPDATE keys
            SET name = ?, cache_synced = 0
            WHERE project_id = ? AND website_id = ? AND active = 1
              AND EXISTS (
                SELECT 1 FROM project_websites
                WHERE id = ? AND project_id = ? AND origin = ? AND updated_at = ?
              )`,
          )
          .bind(
            `${nextName} recorder`.slice(0, 64),
            projectId,
            current.id,
            current.id,
            projectId,
            nextUrl.origin,
            editedAt,
          ),
        database
          .prepare(
            `UPDATE projects
            SET allowed_origins = ?,
              session_cookie_domain = ?,
              name = CASE
                WHEN name = ? AND (
                  SELECT COUNT(*) FROM project_websites WHERE project_id = ?
                ) = 1 THEN ?
                ELSE name
              END,
              config_version = config_version + 1
            WHERE id = ? AND config_version = ?
              AND EXISTS (
                SELECT 1 FROM project_websites
                WHERE id = ? AND project_id = ? AND origin = ? AND updated_at = ?
              )`,
          )
          .bind(
            JSON.stringify(nextAllowedOrigins),
            nextCookieDomain,
            current.name,
            projectId,
            nextName,
            projectId,
            config.version,
            current.id,
            projectId,
            nextUrl.origin,
            editedAt,
          ),
      ]);
    } catch (error) {
      const duplicate = await readWebsite(database, projectId, nextUrl.origin);
      if (duplicate !== null && duplicate.id !== current.id) return { status: "origin_taken" };
      throw error;
    }

    if ((results[0]?.meta.changes ?? 0) > 0 && (results[2]?.meta.changes ?? 0) > 0) {
      await refreshProjectConfigDelivery(env, projectId);
      const edited = await readWebsiteById(database, projectId, current.id);
      if (edited === null) return { status: "not_found" };
      return { status: "ready", website: edited, edited: true };
    }

    const latest = await readWebsiteById(database, projectId, current.id);
    if (latest === null) return { status: "not_found" };
    if (latest.first_event_at !== null) return { status: "already_connected" };
    if (latest.origin !== current.origin) return { status: "changed" };
  }
  return { status: "changed" };
}

export async function getProjectWebsiteInstallStatus(
  env: Env,
  projectId: string,
  websiteId: string,
): Promise<Response> {
  const row = await shardDb(env, 0)
    .prepare(
      "SELECT first_event_at, first_session_id FROM project_websites WHERE id = ? AND project_id = ?",
    )
    .bind(websiteId, projectId)
    .first<{ first_event_at: number | null; first_session_id: string | null }>();
  if (row === null) return jsonError("not_found", 404);
  const status = {
    firstEventAt: row.first_event_at,
    firstSessionId: row.first_session_id,
  } satisfies ProjectWebsiteInstallStatus;
  return jsonResponse(status, { headers: { "cache-control": "private, no-store" } });
}

export async function listProjectWebsites(
  env: Env,
  projectId: string,
  wideEvent: WideEventLogger,
): Promise<Response> {
  const rows = await shardDb(env, 0)
    .prepare(
      `SELECT id, name, origin, first_event_at
      FROM project_websites
      WHERE project_id = ?
      ORDER BY created_at ASC, id ASC`,
    )
    .bind(projectId)
    .all<WebsiteSummaryRow>();
  const websites = (rows.results ?? []).map(projectWebsite);
  wideEvent.set({
    website_count: websites.length,
    pending_website_count: websites.filter((website) => website.firstEventAt === null).length,
  });
  const response = { websites } satisfies ProjectWebsitesResponse;
  return jsonResponse(response, {
    headers: { "cache-control": "private, no-store", pragma: "no-cache" },
  });
}

export async function getProjectWebsiteSetup(
  env: Env,
  projectId: string,
  websiteId: string,
): Promise<Response> {
  const database = shardDb(env, 0);
  const website = await readWebsiteById(database, projectId, websiteId);
  if (website === null) return jsonError("not_found", 404);
  const key = await readActiveWebsiteKey(database, projectId, website.id);
  if (website.first_event_at !== null) {
    return websiteResponse(website, key === null ? null : keyAudit(key), null, true, false);
  }
  if (key === null) return jsonError("website_key_unavailable", 503);
  const secret = await decryptWebsiteSecret(env, website, key.id);
  if (secret === null) return jsonError("website_key_unavailable", 503);
  return websiteResponse(website, keyAudit(key), secret, false, false);
}

/** Mark only the Website attached to this key as connected after an accepted batch. */
export async function markProjectWebsiteConnected(
  env: Env,
  projectId: string,
  websiteId: string,
  keyHash: string,
  firstSessionId: string,
  firstEventAt: number,
): Promise<void> {
  const database = shardDb(env, 0);
  await database.batch([
    database
      .prepare(
        `UPDATE project_websites
        SET first_event_at = COALESCE(first_event_at, ?),
          first_session_id = COALESCE(first_session_id, ?),
          recorder_secret_ciphertext = NULL,
          recorder_secret_iv = NULL,
          updated_at = ?
        WHERE id = ? AND project_id = ?
          AND EXISTS (
            SELECT 1 FROM keys
            WHERE key_hash = ? AND website_id = ? AND project_id = ? AND active = 1
          )`,
      )
      .bind(
        firstEventAt,
        firstSessionId,
        firstEventAt,
        websiteId,
        projectId,
        keyHash,
        websiteId,
        projectId,
      ),
    database
      .prepare(
        "UPDATE keys SET cache_synced = 0 WHERE key_hash = ? AND website_id = ? AND active = 1",
      )
      .bind(keyHash, websiteId),
  ]);
  await env.CONFIG.delete(configKvKey(keyHash));
}

async function mergeWebsiteIntoWorkspace(
  env: Env,
  projectId: string,
  websiteUrl: URL,
  websiteName: string,
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const config = await readStoredProjectConfig(env, projectId);
    if (config === null) throw new Error("The workspace config could not be found.");
    const origins = [...new Set([...config.allowedOrigins, ...websiteAllowedOrigins(websiteUrl)])];
    const nextCookieDomain = nextWorkspaceCookieDomain(config.sessionCookieDomain, websiteUrl);
    const database = shardDb(env, 0);
    const workspace = await database
      .prepare("SELECT name FROM projects WHERE id = ?")
      .bind(projectId)
      .first<{ name: string }>();
    if (workspace === null) throw new Error("The workspace could not be found.");

    const originsChanged =
      origins.length !== config.allowedOrigins.length ||
      origins.some((origin, index) => origin !== config.allowedOrigins[index]);
    const cookieDomainChanged = (config.sessionCookieDomain ?? null) !== nextCookieDomain;
    const needsWorkspaceName = workspace.name === "Default project" || workspace.name === projectId;
    if (!originsChanged && !cookieDomainChanged && !needsWorkspaceName) return;

    const result = await database
      .prepare(
        `UPDATE projects
        SET allowed_origins = ?,
          session_cookie_domain = ?,
          name = CASE WHEN name = 'Default project' OR name = id THEN ? ELSE name END,
          config_version = config_version + 1
        WHERE id = ? AND config_version = ?`,
      )
      .bind(JSON.stringify(origins), nextCookieDomain, websiteName, projectId, config.version)
      .run();
    if ((result.meta.changes ?? 0) > 0) {
      await refreshProjectConfigDelivery(env, projectId);
      return;
    }
  }
  throw new Error("The workspace changed while the Website was being added.");
}

async function readWebsiteConfigRows(
  database: D1Database,
  projectId: string,
): Promise<WebsiteConfigRow[]> {
  const rows = await database
    .prepare(
      `SELECT id, origin, allowed_origins, created_at
      FROM project_websites
      WHERE project_id = ?
      ORDER BY created_at ASC, id ASC`,
    )
    .bind(projectId)
    .all<WebsiteConfigRow>();
  return rows.results ?? [];
}

function workspaceOriginsAfterWebsiteEdit(
  workspaceOrigins: string[],
  rows: WebsiteConfigRow[],
  current: WebsiteRow,
  nextUrl: URL,
): string[] {
  const currentOrigins = new Set(readWebsiteOrigins(current.allowed_origins));
  const originsUsedByOtherWebsites = new Set(
    rows
      .filter((row) => row.id !== current.id)
      .flatMap((row) => readWebsiteOrigins(row.allowed_origins)),
  );
  const nextOrigins = workspaceOrigins.filter(
    (origin) => !currentOrigins.has(origin) || originsUsedByOtherWebsites.has(origin),
  );
  for (const origin of websiteAllowedOrigins(nextUrl)) {
    if (!nextOrigins.includes(origin)) nextOrigins.push(origin);
  }
  return nextOrigins;
}

function workspaceCookieDomainAfterWebsiteEdit(
  rows: WebsiteConfigRow[],
  websiteId: string,
  nextUrl: URL,
): string | null {
  let cookieDomain: string | undefined;
  for (const row of rows) {
    const websiteUrl = row.id === websiteId ? nextUrl : new URL(row.origin);
    cookieDomain = nextWorkspaceCookieDomain(cookieDomain, websiteUrl) ?? undefined;
  }
  return cookieDomain ?? null;
}

function readWebsiteOrigins(value: string): string[] {
  let origins: unknown;
  try {
    origins = JSON.parse(value);
  } catch {
    throw new Error("The Website origins could not be read.");
  }
  if (!Array.isArray(origins) || !origins.every((origin) => typeof origin === "string")) {
    throw new Error("The Website origins are invalid.");
  }
  return origins;
}

async function readWebsite(
  database: D1Database,
  projectId: string,
  origin: string,
): Promise<WebsiteRow | null> {
  return database
    .prepare(
      `SELECT id, name, origin, allowed_origins, first_event_at, created_at, recorder_key_id,
        recorder_secret_ciphertext, recorder_secret_iv
      FROM project_websites
      WHERE project_id = ? AND origin = ?`,
    )
    .bind(projectId, origin)
    .first<WebsiteRow>();
}

async function readWebsiteById(
  database: D1Database,
  projectId: string,
  websiteId: string,
): Promise<WebsiteRow | null> {
  return database
    .prepare(
      `SELECT id, name, origin, allowed_origins, first_event_at, created_at, recorder_key_id,
        recorder_secret_ciphertext, recorder_secret_iv
      FROM project_websites
      WHERE project_id = ? AND id = ?`,
    )
    .bind(projectId, websiteId)
    .first<WebsiteRow>();
}

async function readActiveWebsiteKey(
  database: D1Database,
  projectId: string,
  websiteId: string,
): Promise<WebsiteKeyRow | null> {
  return database
    .prepare(
      `SELECT id, name, key_hash, substr(key_hash, 1, 12) AS key_hash_prefix,
        active, created_at, created_by, revoked_at, revoked_by
      FROM keys
      WHERE project_id = ? AND website_id = ? AND active = 1
      LIMIT 1`,
    )
    .bind(projectId, websiteId)
    .first<WebsiteKeyRow>();
}

function websiteResponse(
  row: WebsiteRow,
  key: ProjectKeyAudit | null,
  secret: string | null,
  alreadyConnected: boolean,
  created: boolean,
): Response {
  const website = projectWebsite(row);
  const response = {
    website,
    key,
    secret,
    alreadyConnected,
  } satisfies EnsureProjectWebsiteResponse;
  return jsonResponse(response, {
    status: created ? 201 : 200,
    headers: { "cache-control": "private, no-store", pragma: "no-cache" },
  });
}

function projectWebsite(row: WebsiteSummaryRow): ProjectWebsite {
  return {
    id: row.id,
    name: row.name,
    origin: row.origin,
    firstEventAt: row.first_event_at,
  };
}

function keyAudit(row: WebsiteKeyRow): ProjectKeyAudit {
  return {
    id: row.id,
    name: row.name,
    keyHashPrefix: row.key_hash_prefix,
    active: row.active === 1,
    createdAt: row.created_at,
    createdBy: row.created_by,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
  };
}

function createKeyError(
  status: Exclude<Awaited<ReturnType<typeof createProjectRecorderKey>>["status"], "created">,
): Response {
  if (status === "not_found") return jsonError("not_found", 404);
  if (status === "active_key_limit_reached" || status === "key_history_limit_reached") {
    return jsonError(status, 409);
  }
  if (status === "key_was_revoked") return jsonError(status, 409);
  return jsonError("key_cache_unavailable", 503);
}

async function encryptWebsiteSecret(
  env: Env,
  secret: string,
  websiteId: string,
  keyId: string,
): Promise<{ ciphertext: string; iv: string }> {
  const key = await websiteWrapKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(`${websiteId}:${keyId}`) },
    key,
    new TextEncoder().encode(secret),
  );
  return { ciphertext: base64Url(new Uint8Array(ciphertext)), iv: base64Url(iv) };
}

async function decryptWebsiteSecret(
  env: Env,
  website: WebsiteRow,
  keyId: string,
): Promise<string | null> {
  if (website.recorder_secret_ciphertext === null || website.recorder_secret_iv === null)
    return null;
  try {
    const value = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64Url(website.recorder_secret_iv),
        additionalData: new TextEncoder().encode(`${website.id}:${keyId}`),
      },
      await websiteWrapKey(env),
      fromBase64Url(website.recorder_secret_ciphertext),
    );
    return new TextDecoder().decode(value);
  } catch {
    return null;
  }
}

async function websiteWrapKey(env: Env): Promise<CryptoKey> {
  const secret =
    env.WEBSITE_KEY_WRAP_SECRET ??
    (env.WORKER_ENV === "production" ? undefined : env.BETTER_AUTH_SECRET);
  if (secret === undefined || secret.length < 32) {
    throw new Error("WEBSITE_KEY_WRAP_SECRET must contain at least 32 characters.");
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
