import {
  manifestKey,
  sessionPrefix,
  type PublicPageBreakdownItem,
  type PublicPageData,
  type PublicPageRecording,
  type SessionManifest,
  type StatsBreakdownRow,
  startWideEvent,
} from "@orange-replay/shared";
import { sessionManifestSchema } from "@orange-replay/shared/schemas";
import { readFinalizedStats } from "../analytics/finalized-read.ts";
import { checkAnalyticsReadRateLimit } from "../analytics/read-rate-limit.ts";
import { isDevTestMode, type Env } from "../env.ts";
import { jsonError, jsonResponse, secureHeaders } from "../api/http.ts";
import { publicPageUrl, readPublicPageOrigin } from "../api/public-page-settings.ts";

const PUBLIC_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  "cross-origin-resource-policy": "same-origin",
  "x-robots-tag": "noindex, nofollow, noarchive",
} as const;

interface PublicProjectRow {
  [key: string]: unknown;
  project_id: string;
  public_id: string;
  project_name: string;
}

interface PublicRecordingRow {
  [key: string]: unknown;
  public_replay_id: string;
  position: number;
  started_at: number;
  duration_ms: number;
  entry_url: string | null;
  country: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
  clicks: number;
  errors: number;
  rages: number;
  page_count: number | null;
}

interface PublicReplaySourceRow {
  [key: string]: unknown;
  project_id: string;
  session_id: string;
}

export async function publicPageRateLimitAllows(env: Env, request: Request): Promise<boolean> {
  if (env.PUBLIC_PAGE_RATE_LIMITER === undefined) return isDevTestMode(env);
  const source = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
  try {
    const result = await env.PUBLIC_PAGE_RATE_LIMITER.limit({ key: `public-page:${source}` });
    return result.success;
  } catch {
    return false;
  }
}

export async function getPublicPageDataResponse(
  requestUrl: URL,
  env: Env,
  ctx: ExecutionContext,
  publicId: string,
  requestId: string,
  wideEvent: ReturnType<typeof startWideEvent>,
): Promise<Response> {
  const result = await readPublicPageData(requestUrl, env, ctx, publicId, requestId, wideEvent);
  if (!result.ok) return result.response;
  return jsonResponse(result.data, { headers: PUBLIC_RESPONSE_HEADERS });
}

export async function readPublicPageData(
  requestUrl: URL,
  env: Env,
  ctx: ExecutionContext,
  publicId: string,
  requestId: string,
  wideEvent: ReturnType<typeof startWideEvent>,
): Promise<{ ok: true; data: PublicPageData } | { ok: false; response: Response }> {
  const project = await readPublicProject(env.IDX_00, publicId);
  if (project === null) return { ok: false, response: publicNotFound() };

  const origin = readPublicPageOrigin(requestUrl, env);
  if (!origin.ok) return { ok: false, response: origin.response };

  const rateLimit = await checkAnalyticsReadRateLimit(env, null, project.project_id);
  if (!rateLimit.allowed) {
    wideEvent.set({ rate_limit: `analytics_${rateLimit.scope}` });
    return {
      ok: false,
      response: jsonError("rate_limited", 429, {
        ...PUBLIC_RESPONSE_HEADERS,
        "retry-after": "60",
      }),
    };
  }

  wideEvent.set({ cache_hit: false });
  const [statsRead, recordings] = await Promise.all([
    readFinalizedStats({
      env,
      projectId: project.project_id,
      requestedFilter: {},
      requestId,
      wideEvent,
      ctx,
      now: Date.now(),
    }),
    readPublicRecordings(env.IDX_00, project.project_id),
  ]);
  if (!statsRead.ok) {
    return {
      ok: false,
      response: jsonError("public_page_temporarily_unavailable", 503, PUBLIC_RESPONSE_HEADERS),
    };
  }

  const stats = statsRead.value;
  return {
    ok: true,
    data: {
      version: 1,
      publicId: project.public_id,
      publicUrl: publicPageUrl(origin.origin, project.public_id),
      projectName: project.project_name,
      generatedAt: Date.now(),
      analytics: {
        sessions: stats.sessions.value,
        averageDurationMs: stats.duration.average.value,
        p50DurationMs: stats.duration.p50.value,
        clicks: stats.clicks.value,
        pagesPerSession: stats.pagesPerSession.value,
        pagesCoveredSessions: stats.pagesPerSession.includedSessions.value,
        ragePercent: stats.insights.ragePercent.value,
        quickBackPercent: stats.insights.quickBackPercent.value,
        countries: safeBreakdown(stats.breakdowns.country),
        devices: safeBreakdown(stats.breakdowns.device),
        browsers: safeBreakdown(stats.breakdowns.browser),
        operatingSystems: safeBreakdown(stats.breakdowns.os),
        entryPages: safeBreakdown(stats.breakdowns.entryPage, true),
      },
      recordings,
    },
  };
}

export async function getPublicManifest(
  env: Env,
  publicId: string,
  publicReplayId: string,
): Promise<Response> {
  const source = await readPublicReplaySource(env.IDX_00, publicId, publicReplayId);
  if (source === null) return publicNotFound();

  const object = await env.RECORDINGS.get(manifestKey(source.project_id, source.session_id));
  if (object === null) return publicNotFound();

  let manifest: SessionManifest;
  try {
    manifest = sessionManifestSchema.parse(await object.json());
  } catch {
    return jsonError("public_recording_unavailable", 503, PUBLIC_RESPONSE_HEADERS);
  }

  const publicManifest: SessionManifest = {
    ...manifest,
    projectId: publicId,
    sessionId: publicReplayId,
    orgId: "public",
    segments: manifest.segments.map((segment) => ({
      ...segment,
      key: `${sessionPrefix(publicId, publicReplayId)}/${segment.key.split("/").at(-1) ?? ""}`,
    })),
    timeline: manifest.timeline.map((event) => ({ t: event.t, k: event.k })),
    enc: undefined,
    attrs: {
      country: manifest.attrs.country,
      device: manifest.attrs.device,
      browser: manifest.attrs.browser,
      os: manifest.attrs.os,
      urlCount: manifest.attrs.urlCount,
      pageCount: manifest.attrs.pageCount,
    },
  };

  return jsonResponse(publicManifest, { headers: PUBLIC_RESPONSE_HEADERS });
}

export async function getPublicSegment(
  env: Env,
  publicId: string,
  publicReplayId: string,
  segmentName: string,
): Promise<Response> {
  const source = await readPublicReplaySource(env.IDX_00, publicId, publicReplayId);
  if (source === null) return publicNotFound();

  const object = await env.RECORDINGS.get(
    `${sessionPrefix(source.project_id, source.session_id)}/${segmentName}`,
  );
  if (object === null) return publicNotFound();

  return new Response(object.body, {
    headers: secureHeaders({
      ...PUBLIC_RESPONSE_HEADERS,
      "content-type": "application/octet-stream",
      "content-length": String(object.size),
      etag: object.httpEtag,
    }),
  });
}

async function readPublicProject(
  database: D1Database,
  publicId: string,
): Promise<PublicProjectRow | null> {
  return database
    .prepare(
      `SELECT page.project_id, page.public_id, project.name AS project_name
        FROM project_public_pages page
        INNER JOIN projects project ON project.id = page.project_id
        WHERE page.public_id = ?
          AND page.is_enabled = 1
        LIMIT 1`,
    )
    .bind(publicId)
    .first<PublicProjectRow>();
}

async function readPublicRecordings(
  database: D1Database,
  projectId: string,
): Promise<PublicPageRecording[]> {
  const result = await database
    .prepare(
      `SELECT selection.public_replay_id, selection.position,
              session.started_at, session.duration_ms, session.entry_url,
              session.country, session.device, session.browser, session.os,
              session.clicks, session.errors, session.rages, session.page_count
        FROM public_page_sessions selection
        INNER JOIN sessions session
          ON session.project_id = selection.project_id
         AND session.session_id = selection.session_id
        WHERE selection.project_id = ?
          AND NOT EXISTS (
            SELECT 1
            FROM session_deletions deletion
            WHERE deletion.project_id = selection.project_id
              AND deletion.session_id = selection.session_id
          )
        ORDER BY selection.position ASC`,
    )
    .bind(projectId)
    .all<PublicRecordingRow>();
  return (result.results ?? []).map((row) => ({
    replayId: row.public_replay_id,
    position: row.position,
    startedAt: row.started_at,
    durationMs: row.duration_ms,
    entryPath: safeEntryPath(row.entry_url),
    country: row.country,
    device: row.device,
    browser: row.browser,
    operatingSystem: row.os,
    clicks: row.clicks,
    errors: row.errors,
    rages: row.rages,
    pages: row.page_count,
  }));
}

async function readPublicReplaySource(
  database: D1Database,
  publicId: string,
  publicReplayId: string,
): Promise<PublicReplaySourceRow | null> {
  return database
    .prepare(
      `SELECT selection.project_id, selection.session_id
        FROM public_page_sessions selection
        INNER JOIN project_public_pages page ON page.project_id = selection.project_id
        INNER JOIN sessions session
          ON session.project_id = selection.project_id
         AND session.session_id = selection.session_id
        WHERE page.public_id = ?
          AND page.is_enabled = 1
          AND selection.public_replay_id = ?
          AND NOT EXISTS (
            SELECT 1
            FROM session_deletions deletion
            WHERE deletion.project_id = selection.project_id
              AND deletion.session_id = selection.session_id
          )
        LIMIT 1`,
    )
    .bind(publicId, publicReplayId)
    .first<PublicReplaySourceRow>();
}

function safeBreakdown(
  rows: StatsBreakdownRow[],
  hideHostAndQuery = false,
): PublicPageBreakdownItem[] {
  return rows.map((row) => ({
    label: hideHostAndQuery ? safeEntryPath(row.label) : row.label,
    count: row.count.value,
    share: row.share.value,
  }));
}

function safeEntryPath(value: string | null): string {
  if (!value) return "/";
  try {
    return new URL(value, "https://public.invalid").pathname || "/";
  } catch {
    return "/";
  }
}

function publicNotFound(): Response {
  return jsonError("not_found", 404, PUBLIC_RESPONSE_HEADERS);
}
