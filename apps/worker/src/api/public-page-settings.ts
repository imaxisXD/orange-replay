import {
  MAX_PUBLIC_PAGE_SETTINGS_BODY_BYTES,
  publicPageSettingsUpdateSchema,
  type PublicPageSettingsUpdate,
  startWideEvent,
} from "@orange-replay/shared";
import type { Env } from "../env.ts";
import { readPublicationSettings, replacePublicationSettings } from "../public-page/publication.ts";
import { jsonError, jsonResponse, readJsonBodyCapped } from "../http.ts";

export async function getPublicPageSettings(
  requestUrl: URL,
  env: Env,
  projectId: string,
): Promise<Response> {
  const result = await readPublicationSettings(env.IDX_00, projectId, requestUrl, env);
  if (!result.ok) return jsonError(result.error, result.error === "not_found" ? 404 : 503);
  return jsonResponse(result.settings, { headers: { "cache-control": "private, no-store" } });
}

export async function putPublicPageSettings(
  request: Request,
  requestUrl: URL,
  env: Env,
  projectId: string,
  wideEvent: ReturnType<typeof startWideEvent>,
): Promise<Response> {
  const body = await readJsonBodyCapped(request, MAX_PUBLIC_PAGE_SETTINGS_BODY_BYTES);
  if (!body.ok) return jsonError(body.error, body.status);

  const update = parsePublicPageSettingsUpdate(body.value);
  if (!update.ok) return jsonError(update.error, 400);

  const result = await replacePublicationSettings(
    env.IDX_00,
    projectId,
    requestUrl,
    env,
    update.value,
  );
  if (!result.ok) {
    if (result.error === "not_found") return jsonError(result.error, 404);
    if (
      result.error === "public_page_origin_not_set" ||
      result.error === "public_page_origin_invalid"
    ) {
      return jsonError(result.error, 503);
    }
    if (result.error === "recording_not_available") return jsonError(result.error, 400);
    return jsonError(result.error, 409, { "cache-control": "private, no-store" });
  }

  const settings = result.settings;
  wideEvent.set({
    project_id: projectId,
    public_page_enabled: settings.enabled,
    public_recording_count: settings.recordings.length,
    public_page_revision: settings.revision,
  });
  return jsonResponse(settings, { headers: { "cache-control": "private, no-store" } });
}

function parsePublicPageSettingsUpdate(
  value: unknown,
): { ok: true; value: PublicPageSettingsUpdate } | { ok: false; error: string } {
  const parsed = publicPageSettingsUpdateSchema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };

  const sessionIssues = parsed.error.issues.filter((issue) => issue.path[0] === "sessionIds");
  if (sessionIssues.some((issue) => issue.code === "max_length")) {
    return { ok: false, error: "too_many_public_recordings" };
  }
  if (sessionIssues.some((issue) => issue.message === "session id must be unique")) {
    return { ok: false, error: "duplicate_recording_id" };
  }
  return {
    ok: false,
    error: sessionIssues.length > 0 ? "invalid_recording_id" : "invalid_public_page_settings",
  };
}
