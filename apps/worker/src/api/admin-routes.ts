import type { Env } from "../env.ts";
import { jsonError, jsonResponse } from "../http.ts";

interface CountRow {
  [key: string]: unknown;
  count: number;
}

interface AdminStatsRow {
  [key: string]: unknown;
  users: number;
  new_users: number;
  workspaces: number;
  projects: number;
  active_keys: number;
}

interface AdminUserRow {
  [key: string]: unknown;
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: string | null;
  banned: number | boolean | null;
  ban_reason: string | null;
  created_at: number;
  last_signed_in_at: number | null;
  workspace_count: number;
}

export async function getAdminStats(env: Env): Promise<Response> {
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const row = await env.IDX_00.prepare(
    `SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM users WHERE created_at >= ?) AS new_users,
      (SELECT COUNT(*) FROM orgs) AS workspaces,
      (SELECT COUNT(*) FROM projects) AS projects,
      (SELECT COUNT(*) FROM keys WHERE active = 1) AS active_keys`,
  )
    .bind(sevenDaysAgo)
    .first<AdminStatsRow>();

  return jsonResponse(
    {
      users: row?.users ?? 0,
      newUsers: row?.new_users ?? 0,
      workspaces: row?.workspaces ?? 0,
      projects: row?.projects ?? 0,
      activeKeys: row?.active_keys ?? 0,
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}

export async function getAdminUsers(url: URL, env: Env): Promise<Response> {
  const query = parseAdminUsersQuery(url.searchParams);
  if (!query.ok) return jsonError(query.error, 400);

  const searchText = query.search === null ? null : `%${escapeLike(query.search)}%`;
  const where =
    searchText === null ? "" : "WHERE u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\'";
  const searchBindings = searchText === null ? [] : [searchText, searchText];

  const [rows, total] = await Promise.all([
    env.IDX_00.prepare(
      `SELECT
        u.id AS id,
        u.name AS name,
        u.email AS email,
        u.image AS image,
        u.role AS role,
        u.banned AS banned,
        u.ban_reason AS ban_reason,
        u.created_at AS created_at,
        MAX(s.created_at) AS last_signed_in_at,
        COUNT(DISTINCT m.org_id) AS workspace_count
      FROM users u
      LEFT JOIN auth_sessions s ON s.user_id = u.id
      LEFT JOIN members m ON m.user_id = u.id
      ${where}
      GROUP BY u.id
      ORDER BY u.created_at DESC, u.id DESC
      LIMIT ? OFFSET ?`,
    )
      .bind(...searchBindings, query.limit, query.offset)
      .all<AdminUserRow>(),
    readCount(env.IDX_00, `SELECT COUNT(*) AS count FROM users u ${where}`, searchBindings),
  ]);

  return jsonResponse(
    {
      users: (rows.results ?? []).map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        image: row.image,
        role: row.role ?? "user",
        banned: row.banned === true || row.banned === 1,
        banReason: row.ban_reason,
        createdAt: row.created_at,
        lastSignedInAt: row.last_signed_in_at,
        workspaceCount: row.workspace_count,
      })),
      total,
      limit: query.limit,
      offset: query.offset,
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}

async function readCount(
  database: D1Database,
  sql: string,
  bindings: (string | number)[] = [],
): Promise<number> {
  const row = await database
    .prepare(sql)
    .bind(...bindings)
    .first<CountRow>();
  return row?.count ?? 0;
}

function parseAdminUsersQuery(
  params: URLSearchParams,
):
  | { ok: true; limit: number; offset: number; search: string | null }
  | { ok: false; error: string } {
  const limit = readWholeNumber(params.get("limit"), 25);
  if (limit === null || limit < 1 || limit > 100) {
    return { ok: false, error: "invalid_limit" };
  }

  const offset = readWholeNumber(params.get("offset"), 0);
  if (offset === null || offset < 0 || offset > 100_000) {
    return { ok: false, error: "invalid_offset" };
  }

  const rawSearch = params.get("search");
  const search = rawSearch?.trim() || null;
  if (search !== null && search.length > 100) {
    return { ok: false, error: "invalid_search" };
  }

  return { ok: true, limit, offset, search };
}

function readWholeNumber(value: string | null, fallback: number): number | null {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
