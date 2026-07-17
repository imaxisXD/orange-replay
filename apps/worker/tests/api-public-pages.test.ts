import type { PublicPageData, PublicPageSettings } from "@orange-replay/shared";
import { describe, expect, it } from "vite-plus/test";
import {
  assetProjectId,
  assetSessionId,
  authHeaders,
  listProjectId,
  makeManifest,
  makeSession,
  segmentBytes,
  segmentName,
  seedSession,
  setupApiTestWorkers,
  worker,
} from "./api-test-helpers.ts";

setupApiTestWorkers();

const privateEntryUrl =
  "https://private:secret@example.com/checkout/complete?email=private@example.com#access-token";
const privateSessionId = "api_public_private_session";

describe.sequential("public project pages", () => {
  it("keeps publication settings private and validates the selected recordings", async () => {
    const path = `/api/v1/projects/${assetProjectId}/public-page`;
    const anonymous = await worker.fetch(path);
    expect(anonymous.status).toBe(401);

    const initial = await worker.fetch(path, { headers: authHeaders() });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({
      enabled: false,
      publicId: null,
      publicUrl: null,
      revision: 0,
      recordings: [],
    });

    const missingRevision = await worker.fetch(path, {
      method: "PUT",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, sessionIds: [] }),
    });
    expect(missingRevision.status).toBe(400);
    expect(await missingRevision.json()).toEqual({ error: "invalid_public_page_settings" });

    const invalidRevision = await updateSettings(assetProjectId, true, [], -1);
    expect(invalidRevision.status).toBe(400);
    expect(await invalidRevision.json()).toEqual({ error: "invalid_public_page_settings" });

    const tooMany = await updateSettings(
      assetProjectId,
      true,
      Array.from({ length: 11 }, (_, index) => `recording_${index}`),
      0,
    );
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toEqual({ error: "too_many_public_recordings" });

    const duplicate = await updateSettings(
      assetProjectId,
      true,
      [assetSessionId, assetSessionId],
      0,
    );
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toEqual({ error: "duplicate_recording_id" });

    const otherProject = await updateSettings(assetProjectId, true, ["api_new"], 0);
    expect(otherProject.status).toBe(400);
    expect(await otherProject.json()).toEqual({ error: "recording_not_available" });
  });

  it("publishes safe SSR analytics and revokes recording access from every public route", async () => {
    const privateSession = makeSession({
      session_id: privateSessionId,
      project_id: assetProjectId,
      started_at: 6_000,
      ended_at: 7_000,
      duration_ms: 1_000,
      entry_url: privateEntryUrl,
      bytes: segmentBytes.byteLength,
      segment_count: 1,
    });
    await seedSession(
      privateSession,
      makeManifest(privateSession, [{ name: segmentName, bytes: segmentBytes }]),
      [{ name: segmentName, bytes: segmentBytes }],
    );

    const publishedResponse = await updateSettings(assetProjectId, true, [privateSessionId], 0);
    expect(publishedResponse.status).toBe(200);
    const settingsText = await publishedResponse.text();
    const settings = JSON.parse(settingsText) as PublicPageSettings;
    expect(settings.enabled).toBe(true);
    expect(settings.publicId).toMatch(/^pub_[a-f0-9]{36}$/);
    expect(settings.publicUrl).toMatch(new RegExp(`/p/${settings.publicId}$`));
    expect(settings.recordings).toHaveLength(1);
    expect(settings.recordings[0]?.sessionId).toBe(privateSessionId);
    expect(settings.recordings[0]?.entryPath).toBe("/checkout/complete");
    expect(settings.recordings[0]?.replayId).toMatch(/^replay_[a-f0-9]{36}$/);
    expect(settingsText).not.toContain("private:secret");
    expect(settingsText).not.toContain("example.com");
    expect(settingsText).not.toContain("private@example.com");
    expect(settingsText).not.toContain("access-token");

    const publicId = settings.publicId!;
    const publicReplayId = settings.recordings[0]!.replayId;
    const dataResponse = await worker.fetch(`/api/v1/public-pages/${publicId}`);
    expect(dataResponse.status).toBe(200);
    expect(dataResponse.headers.get("cache-control")).toBe("no-store");
    expect(dataResponse.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(dataResponse.headers.get("x-robots-tag")).toContain("noindex");
    const dataText = await dataResponse.text();
    const data = JSON.parse(dataText) as PublicPageData;
    expect(data.publicId).toBe(publicId);
    expect(data.analytics.sessions).toBe(2);
    expect(data.analytics.entryPages).toContainEqual(
      expect.objectContaining({ label: "/checkout/complete" }),
    );
    expect(data.recordings).toEqual([
      expect.objectContaining({ replayId: publicReplayId, entryPath: "/checkout/complete" }),
    ]);
    expect(dataText).not.toContain(privateSessionId);
    expect(dataText).not.toContain("private:secret");
    expect(dataText).not.toContain("example.com");
    expect(dataText).not.toContain("private@example.com");
    expect(dataText).not.toContain("access-token");
    expect(dataText).not.toContain('"projectId"');
    expect(dataText).not.toContain('"sessionId"');
    expect(dataText).not.toContain('"orgId"');
    expect(dataText).not.toContain('"liveNow"');
    expect(dataText).not.toContain('"analyticsState"');
    expect(dataText).not.toContain('"warehouseVersion"');

    const htmlResponse = await worker.fetch(`/p/${publicId}`);
    expect(htmlResponse.status).toBe(200);
    expect(htmlResponse.headers.get("cache-control")).toBe("no-store");
    expect(htmlResponse.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(htmlResponse.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(htmlResponse.headers.get("referrer-policy")).toBe("no-referrer");
    expect(htmlResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(htmlResponse.headers.get("x-frame-options")).toBe("DENY");
    const html = await htmlResponse.text();
    expect(html).toContain(`<title>${assetProjectId} analytics | Orange Replay</title>`);
    expect(html).toContain("Public analytics");
    expect(html).toContain("Sessions");
    expect(html).toContain(publicReplayId);
    expect(html).toContain("/checkout/complete");
    expect(html).not.toContain(privateSessionId);
    expect(html).not.toContain("private:secret");
    expect(html).not.toContain("example.com");
    expect(html).not.toContain("private@example.com");
    expect(html).not.toContain("access-token");
    expect(html).not.toContain('"projectId"');
    expect(html).not.toContain('"sessionId"');
    expect(html).not.toContain('"orgId"');

    const manifestResponse = await worker.fetch(
      `/api/v1/public-pages/${publicId}/replays/${publicReplayId}/manifest`,
    );
    expect(manifestResponse.status).toBe(200);
    expect(manifestResponse.headers.get("cache-control")).toBe("no-store");
    const manifestText = await manifestResponse.text();
    const manifest = JSON.parse(manifestText) as {
      projectId: string;
      sessionId: string;
      orgId: string;
      segments: { key: string }[];
      attrs: Record<string, unknown>;
    };
    expect(manifest.projectId).toBe(publicId);
    expect(manifest.sessionId).toBe(publicReplayId);
    expect(manifest.orgId).toBe("public");
    expect(manifest.segments[0]?.key).toBe(`p/${publicId}/${publicReplayId}/${segmentName}`);
    expect(manifest.attrs).not.toHaveProperty("city");
    expect(manifest.attrs).not.toHaveProperty("entryUrl");
    expect(manifestText).not.toContain(assetProjectId);
    expect(manifestText).not.toContain(privateSessionId);
    expect(manifestText).not.toContain("private@example.com");
    expect(manifestText).not.toContain("api_org");

    const segmentResponse = await worker.fetch(
      `/api/v1/public-pages/${publicId}/replays/${publicReplayId}/segments/${segmentName}`,
    );
    expect(segmentResponse.status).toBe(200);
    expect(segmentResponse.headers.get("cache-control")).toBe("no-store");
    expect(Array.from(new Uint8Array(await segmentResponse.arrayBuffer()))).toEqual(
      Array.from(segmentBytes),
    );

    const removedResponse = await updateSettings(assetProjectId, true, [], settings.revision);
    expect(removedResponse.status).toBe(200);
    const removedSettings = (await removedResponse.json()) as PublicPageSettings;
    const removedData = await worker.fetch(`/api/v1/public-pages/${publicId}`);
    expect(removedData.status).toBe(200);
    expect(((await removedData.json()) as PublicPageData).recordings).toEqual([]);
    const removedHtml = await worker.fetch(`/p/${publicId}`);
    expect(removedHtml.status).toBe(200);
    const removedHtmlText = await removedHtml.text();
    expect(removedHtmlText).toContain("No session recordings are shared on this page.");
    expect(removedHtmlText).not.toContain(publicReplayId);
    expect(
      (await worker.fetch(`/api/v1/public-pages/${publicId}/replays/${publicReplayId}/manifest`))
        .status,
    ).toBe(404);
    expect(
      (
        await worker.fetch(
          `/api/v1/public-pages/${publicId}/replays/${publicReplayId}/segments/${segmentName}`,
        )
      ).status,
    ).toBe(404);

    const restoredResponse = await updateSettings(
      assetProjectId,
      true,
      [privateSessionId],
      removedSettings.revision,
    );
    expect(restoredResponse.status).toBe(200);
    const restoredSettings = (await restoredResponse.json()) as PublicPageSettings;
    const restoredReplayId = restoredSettings.recordings[0]!.replayId;

    const disabledResponse = await updateSettings(
      assetProjectId,
      false,
      [privateSessionId],
      restoredSettings.revision,
    );
    expect(disabledResponse.status).toBe(200);
    const disabledSettings = (await disabledResponse.json()) as PublicPageSettings;
    expect(disabledSettings.recordings[0]?.sessionId).toBe(privateSessionId);
    const disabledData = await worker.fetch(`/api/v1/public-pages/${publicId}`);
    const disabledHtml = await worker.fetch(`/p/${publicId}`);
    expect(disabledData.status).toBe(404);
    expect(disabledHtml.status).toBe(404);
    expect(disabledHtml.headers.get("x-robots-tag")).toContain("noindex");
    expect(
      (await worker.fetch(`/api/v1/public-pages/${publicId}/replays/${restoredReplayId}/manifest`))
        .status,
    ).toBe(404);
    expect(
      (
        await worker.fetch(
          `/api/v1/public-pages/${publicId}/replays/${restoredReplayId}/segments/${segmentName}`,
        )
      ).status,
    ).toBe(404);

    const republishedResponse = await updateSettings(
      assetProjectId,
      true,
      [privateSessionId],
      disabledSettings.revision,
    );
    expect(republishedResponse.status).toBe(200);
    const republishedSettings = (await republishedResponse.json()) as PublicPageSettings;
    expect(republishedSettings.recordings[0]?.replayId).toBe(restoredReplayId);

    const deletion = await worker.fetch("/__test/consumer/seed-deletion", {
      method: "POST",
      body: JSON.stringify({ projectId: assetProjectId, sessionId: privateSessionId }),
    });
    expect(deletion.status).toBe(200);

    const deletedDataResponse = await worker.fetch(`/api/v1/public-pages/${publicId}`);
    expect(deletedDataResponse.status).toBe(200);
    expect(((await deletedDataResponse.json()) as PublicPageData).recordings).toEqual([]);
    const deletedHtmlResponse = await worker.fetch(`/p/${publicId}`);
    expect(deletedHtmlResponse.status).toBe(200);
    expect(await deletedHtmlResponse.text()).not.toContain(restoredReplayId);
    expect(
      (await worker.fetch(`/api/v1/public-pages/${publicId}/replays/${restoredReplayId}/manifest`))
        .status,
    ).toBe(404);
    expect(
      (
        await worker.fetch(
          `/api/v1/public-pages/${publicId}/replays/${restoredReplayId}/segments/${segmentName}`,
        )
      ).status,
    ).toBe(404);
    expect((await readSettings(assetProjectId)).recordings).toEqual([]);

    const deletedReselection = await updateSettings(
      assetProjectId,
      true,
      [privateSessionId],
      republishedSettings.revision,
    );
    expect(deletedReselection.status).toBe(400);
    expect(await deletedReselection.json()).toEqual({ error: "recording_not_available" });

    const cleanup = await updateSettings(assetProjectId, false, [], republishedSettings.revision);
    expect(cleanup.status).toBe(200);
  });

  it("does not publish a valid recording from another project", async () => {
    const response = await updateSettings(listProjectId, true, [assetSessionId], 0);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "recording_not_available" });
  });

  it("rejects concurrent first saves and stale full replacements", async () => {
    const [first, second] = await Promise.all([
      updateSettings(listProjectId, true, ["api_old"], 0),
      updateSettings(listProjectId, true, ["api_new"], 0),
    ]);
    expect([first.status, second.status].toSorted((left, right) => left - right)).toEqual([
      200, 409,
    ]);
    expect(await (first.status === 409 ? first : second).json()).toEqual({
      error: "public_page_settings_changed",
    });

    const created = await readSettings(listProjectId);
    const preparedResponse = await updateSettings(
      listProjectId,
      true,
      ["api_old", "api_new"],
      created.revision,
    );
    expect(preparedResponse.status).toBe(200);
    const prepared = (await preparedResponse.json()) as PublicPageSettings;

    const revokedResponse = await updateSettings(
      listProjectId,
      true,
      ["api_old"],
      prepared.revision,
    );
    expect(revokedResponse.status).toBe(200);
    const revoked = (await revokedResponse.json()) as PublicPageSettings;

    const staleRecordingSave = await updateSettings(
      listProjectId,
      true,
      ["api_old", "api_new"],
      prepared.revision,
    );
    expect(staleRecordingSave.status).toBe(409);
    expect(await staleRecordingSave.json()).toEqual({ error: "public_page_settings_changed" });
    expect(
      (await readSettings(listProjectId)).recordings.map((recording) => recording.sessionId),
    ).toEqual(["api_old"]);

    const disabledResponse = await updateSettings(
      listProjectId,
      false,
      ["api_old"],
      revoked.revision,
    );
    expect(disabledResponse.status).toBe(200);
    const disabled = (await disabledResponse.json()) as PublicPageSettings;

    const staleEnableSave = await updateSettings(
      listProjectId,
      true,
      ["api_old", "api_new"],
      revoked.revision,
    );
    expect(staleEnableSave.status).toBe(409);
    expect(await staleEnableSave.json()).toEqual({ error: "public_page_settings_changed" });

    const finalSettings = await readSettings(listProjectId);
    expect(finalSettings.enabled).toBe(false);
    expect(finalSettings.revision).toBe(disabled.revision);
    expect(finalSettings.recordings.map((recording) => recording.sessionId)).toEqual(["api_old"]);
  });
});

async function readSettings(projectId: string): Promise<PublicPageSettings> {
  const response = await worker.fetch(`/api/v1/projects/${projectId}/public-page`, {
    headers: authHeaders(),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as PublicPageSettings;
}

function updateSettings(
  projectId: string,
  enabled: boolean,
  sessionIds: string[],
  expectedRevision: number,
) {
  return worker.fetch(`/api/v1/projects/${projectId}/public-page`, {
    method: "PUT",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ enabled, expectedRevision, sessionIds }),
  });
}
