import {
  MAX_PROJECT_CREATE_BODY_BYTES,
  projectCreateRequestSchema,
  uuidv7,
  type AccountResponse,
  type AccountWorkspace,
  type ProjectCreateResponse,
  type WideEventLogger,
} from "@orange-replay/shared";
import type { Env } from "../env.ts";
import {
  hostedProjectBootstrapReportId,
  prepareNewProjectAnalyticsReceipt,
} from "../analytics/project-bootstrap.ts";
import type { ProjectRole, SessionAuthContext } from "./auth.ts";
import { jsonError, jsonResponse, readJsonBodyCapped } from "../http.ts";
import { workspaceJourneyDomain } from "./project-website-domain.ts";

interface AccountProjectRow {
  [key: string]: unknown;
  org_id: string;
  org_name: string;
  org_slug: string;
  role: string;
  project_id: string | null;
  project_name: string | null;
  first_website_name: string | null;
  first_website_origin: string | null;
  journey_domain: string | null;
}

interface MembershipCountRow {
  [key: string]: unknown;
  membership_count: number;
}

export type { AccountResponse } from "@orange-replay/shared";

interface WorkspaceMembershipRow {
  [key: string]: unknown;
  role: string;
}

export async function getAccount(env: Env, auth: SessionAuthContext): Promise<Response> {
  const body = await readAccount(env, auth);
  return jsonResponse(body, { headers: { "cache-control": "private, no-store" } });
}

export async function bootstrapAccount(env: Env, auth: SessionAuthContext): Promise<Response> {
  const userId = auth.hostedSession.user.id;
  const row = await env.IDX_00.prepare(
    "SELECT COUNT(*) AS membership_count FROM members WHERE user_id = ?",
  )
    .bind(userId)
    .first<MembershipCountRow>();

  if ((row?.membership_count ?? 0) === 0) {
    const shortId = await stableUserPart(userId);
    const workspaceId = `workspace_${shortId}`;
    const projectId = `project_${shortId}`;
    const memberId = `member_${shortId}`;
    const now = Date.now();
    const userName = readableUserName(auth);
    const workspaceName = `${userName}'s workspace`.slice(0, 100);
    const workspaceSlug = `${slugPart(userName)}-${shortId}`;

    await env.IDX_00.batch([
      env.IDX_00.prepare(
        `INSERT OR IGNORE INTO orgs
          (id, name, slug, logo, metadata, shard, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(workspaceId, workspaceName, workspaceSlug, null, null, 0, now),
      prepareProjectInsert(env.IDX_00, projectId, workspaceId, now, true),
      prepareNewProjectAnalyticsReceipt(env.IDX_00, projectId, now, hostedProjectBootstrapReportId),
      env.IDX_00.prepare(
        `INSERT OR IGNORE INTO members
          (id, org_id, user_id, role, created_at)
          VALUES (?, ?, ?, ?, ?)`,
      ).bind(memberId, workspaceId, userId, "owner", now),
      env.IDX_00.prepare(
        `UPDATE auth_sessions
          SET active_org_id = ?, updated_at = ?
          WHERE id = ? AND user_id = ? AND active_org_id IS NULL`,
      ).bind(workspaceId, now, auth.hostedSession.session.id, userId),
    ]);
  }

  const body = await readAccount(env, auth);
  return jsonResponse(body, { headers: { "cache-control": "private, no-store" } });
}

export async function createProject(
  request: Request,
  env: Env,
  auth: SessionAuthContext,
  wideEvent: WideEventLogger,
): Promise<Response> {
  const body = await readJsonBodyCapped(request, MAX_PROJECT_CREATE_BODY_BYTES);
  if (!body.ok) return jsonError(body.error, body.status);

  const parsed = projectCreateRequestSchema.safeParse(body.value);
  if (!parsed.success) return jsonError("invalid_workspace", 400);

  const membership = await env.IDX_00.prepare(
    "SELECT role FROM members WHERE org_id = ? AND user_id = ?",
  )
    .bind(parsed.data.workspaceId, auth.hostedSession.user.id)
    .first<WorkspaceMembershipRow>();
  const role = membership === null ? null : readProjectRole(membership.role);
  if (role !== "owner" && role !== "admin") return jsonError("forbidden", 403);

  const projectId = `project_${uuidv7()}`;
  const now = Date.now();
  await env.IDX_00.batch([
    prepareProjectInsert(env.IDX_00, projectId, parsed.data.workspaceId, now, false),
    prepareNewProjectAnalyticsReceipt(env.IDX_00, projectId, now, hostedProjectBootstrapReportId),
  ]);

  const account = await readAccount(env, auth);
  const project = account.workspaces
    .find((workspace) => workspace.id === parsed.data.workspaceId)
    ?.projects.find((candidate) => candidate.id === projectId);
  if (project === undefined) return jsonError("project_create_failed", 500);

  wideEvent.set({ project_id: projectId, org_id: parsed.data.workspaceId });
  const response = { project, account } satisfies ProjectCreateResponse;
  return jsonResponse(response, {
    status: 201,
    headers: { "cache-control": "private, no-store" },
  });
}

async function readAccount(env: Env, auth: SessionAuthContext): Promise<AccountResponse> {
  const user = auth.hostedSession.user;
  const rows = await env.IDX_00.prepare(
    `SELECT
      o.id AS org_id,
      o.name AS org_name,
      o.slug AS org_slug,
      m.role AS role,
      p.id AS project_id,
      p.name AS project_name,
      p.session_cookie_domain AS journey_domain,
      (
        SELECT website.name
        FROM project_websites website
        WHERE website.project_id = p.id
        ORDER BY website.created_at ASC, website.id ASC
        LIMIT 1
      ) AS first_website_name,
      (
        SELECT website.origin
        FROM project_websites website
        WHERE website.project_id = p.id
        ORDER BY website.created_at ASC, website.id ASC
        LIMIT 1
      ) AS first_website_origin
    FROM members m
    JOIN orgs o ON o.id = m.org_id
    LEFT JOIN projects p ON p.org_id = o.id
    WHERE m.user_id = ?
    ORDER BY o.created_at ASC, o.id ASC, p.created_at ASC, p.id ASC`,
  )
    .bind(user.id)
    .all<AccountProjectRow>();

  const workspaces = new Map<string, AccountWorkspace>();
  for (const row of rows.results ?? []) {
    const role = readProjectRole(row.role);
    if (role === null) continue;

    let workspace = workspaces.get(row.org_id);
    if (workspace === undefined) {
      workspace = {
        id: row.org_id,
        name: row.org_name,
        slug: row.org_slug,
        role,
        projects: [],
      };
      workspaces.set(row.org_id, workspace);
    }

    if (row.project_id !== null && row.project_name !== null) {
      const journeyDomain = workspaceJourneyDomain(row.journey_domain ?? undefined);
      workspace.projects.push({
        id: row.project_id,
        name: readWorkspaceDisplayName({
          projectId: row.project_id,
          storedName: row.project_name,
          firstWebsiteName: row.first_website_name,
        }),
        role,
        websiteOrigin: row.first_website_origin,
        journeyDomain,
      });
    }
  }

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      image: user.image,
      role: user.role ?? "user",
    },
    workspaces: [...workspaces.values()],
    activeWorkspaceId:
      auth.hostedSession.session.activeOrganizationId ??
      workspaces.values().next().value?.id ??
      null,
    isAdmin: auth.globalAdmin,
  };
}

/**
 * The database still calls a user-facing Workspace a project. Old local and
 * test data sometimes used the project id as its name. Keep that identity in
 * the id field and use the first Website name for display once one exists.
 */
export function readWorkspaceDisplayName({
  projectId,
  storedName,
  firstWebsiteName,
}: {
  projectId: string;
  storedName: string;
  firstWebsiteName: string | null;
}): string {
  const isInternalName = storedName === projectId || storedName === "Default project";
  return isInternalName && firstWebsiteName !== null ? firstWebsiteName : storedName;
}

function readProjectRole(value: string): ProjectRole | null {
  if (value === "owner" || value === "admin" || value === "member") {
    return value;
  }
  return null;
}

function readableUserName(auth: SessionAuthContext): string {
  const name = auth.hostedSession.user.name.trim();
  if (name.length > 0) return name;
  return auth.hostedSession.user.email.split("@")[0]?.trim() || "My";
}

function slugPart(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug.length > 0 ? slug : "workspace";
}

async function stableUserPart(userId: string): Promise<string> {
  const bytes = new TextEncoder().encode(userId);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let value = "";
  for (const byte of digest.slice(0, 10)) {
    value += byte.toString(16).padStart(2, "0");
  }
  return value;
}

function prepareProjectInsert(
  database: D1Database,
  projectId: string,
  workspaceId: string,
  createdAt: number,
  ignoreExisting: boolean,
): D1PreparedStatement {
  return database
    .prepare(
      `INSERT ${ignoreExisting ? "OR IGNORE " : ""}INTO projects
        (id, org_id, name, jurisdiction, retention_days, sample_rate,
          allowed_origins, mask_policy_version, mask_rules, capture_toggles,
          quota_state, config_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      projectId,
      workspaceId,
      "Default project",
      null,
      30,
      1,
      "[]",
      1,
      "[]",
      JSON.stringify({ heatmaps: false, console: false, network: false, canvas: false }),
      "ok",
      1,
      createdAt,
    );
}
