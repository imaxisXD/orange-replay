import {
  MAX_PUBLIC_PAGE_RECORDINGS,
  MAX_PUBLIC_PAGE_SETTINGS_BODY_BYTES,
  type PublicPageSettingsUpdate,
  startWideEvent,
} from "@orange-replay/shared";
import type { Env } from "../env.ts";
import { readPublicationSettings, replacePublicationSettings } from "../public-page/publication.ts";
import { isValidPathId } from "../query/session-query.ts";
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
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, error: "invalid_public_page_settings" };
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3 ||
    keys[0] !== "enabled" ||
    keys[1] !== "expectedRevision" ||
    keys[2] !== "sessionIds"
  ) {
    return { ok: false, error: "invalid_public_page_settings" };
  }
  if (
    typeof record.enabled !== "boolean" ||
    !Number.isSafeInteger(record.expectedRevision) ||
    (record.expectedRevision as number) < 0 ||
    !Array.isArray(record.sessionIds)
  ) {
    return { ok: false, error: "invalid_public_page_settings" };
  }
  if (record.sessionIds.length > MAX_PUBLIC_PAGE_RECORDINGS) {
    return { ok: false, error: "too_many_public_recordings" };
  }
  if (!record.sessionIds.every((sessionId) => typeof sessionId === "string")) {
    return { ok: false, error: "invalid_recording_id" };
  }
  const sessionIds = record.sessionIds as string[];
  if (!sessionIds.every(isValidPathId)) {
    return { ok: false, error: "invalid_recording_id" };
  }
  if (new Set(sessionIds).size !== sessionIds.length) {
    return { ok: false, error: "duplicate_recording_id" };
  }
  return {
    ok: true,
    value: {
      enabled: record.enabled,
      expectedRevision: record.expectedRevision as number,
      sessionIds,
    },
  };
}
