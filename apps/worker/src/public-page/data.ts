import {
  manifestKey,
  sessionPrefix,
  type PublicPageBreakdownItem,
  type PublicPageData,
  type SessionManifest,
  type StatsBreakdownRow,
  startWideEvent,
} from "@orange-replay/shared";
import { safePublicEntryPath } from "@orange-replay/shared/analytics-privacy";
import { sessionManifestSchema } from "@orange-replay/shared/schemas";
import { readFinalizedStats } from "../analytics/finalized-read.ts";
import { checkAnalyticsReadRateLimit } from "../analytics/read-rate-limit.ts";
import { isDevTestMode, type Env } from "../env.ts";
import { jsonError, jsonResponse, secureHeaders } from "../http.ts";
import {
  publicPageUrl,
  readPublishedProject,
  readPublishedRecordings,
  readPublishedReplaySource,
  resolvePublicPageOrigin,
} from "./publication.ts";

const PUBLIC_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  "cross-origin-resource-policy": "same-origin",
  "x-robots-tag": "noindex, nofollow, noarchive",
} as const;

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
  const project = await readPublishedProject(env.IDX_00, publicId);
  if (project === null) return { ok: false, response: publicNotFound() };

  const origin = resolvePublicPageOrigin(requestUrl, env);
  if (!origin.ok) {
    return {
      ok: false,
      response: jsonError(origin.error, 503),
    };
  }

  const rateLimit = await checkAnalyticsReadRateLimit(env, null, project.projectId);
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
      projectId: project.projectId,
      requestedFilter: {},
      requestId,
      wideEvent,
      ctx,
      now: Date.now(),
    }),
    readPublishedRecordings(env.IDX_00, publicId),
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
      publicId: project.publicId,
      publicUrl: publicPageUrl(origin.origin, project.publicId),
      projectName: project.projectName,
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
  const source = await readPublishedReplaySource(env.IDX_00, publicId, publicReplayId);
  if (source === null) return publicNotFound();

  const object = await env.RECORDINGS.get(manifestKey(source.projectId, source.sessionId));
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
  const source = await readPublishedReplaySource(env.IDX_00, publicId, publicReplayId);
  if (source === null) return publicNotFound();

  const object = await env.RECORDINGS.get(
    `${sessionPrefix(source.projectId, source.sessionId)}/${segmentName}`,
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

function safeBreakdown(
  rows: StatsBreakdownRow[],
  hideHostAndQuery = false,
): PublicPageBreakdownItem[] {
  return rows.map((row) => ({
    label: hideHostAndQuery ? safePublicEntryPath(row.label) : row.label,
    count: row.count.value,
    share: row.share.value,
  }));
}

function publicNotFound(): Response {
  return jsonError("not_found", 404, PUBLIC_RESPONSE_HEADERS);
}
