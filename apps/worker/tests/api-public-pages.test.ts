import type { PublicPageData, PublicPageSettings } from "@orange-replay/shared";
import { describe, expect, it } from "vite-plus/test";
import {
  assetProjectId,
  assetSessionId,
  authHeaders,
  listProjectId,
  segmentBytes,
  segmentName,
  setupApiTestWorkers,
  worker,
} from "./api-test-helpers.ts";

setupApiTestWorkers();

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

    const tooMany = await updateSettings(
      assetProjectId,
      true,
      Array.from({ length: 11 }, (_, index) => `recording_${index}`),
    );
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toEqual({ error: "too_many_public_recordings" });

    const duplicate = await updateSettings(assetProjectId, true, [assetSessionId, assetSessionId]);
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toEqual({ error: "duplicate_recording_id" });

    const otherProject = await updateSettings(assetProjectId, true, ["api_new"]);
    expect(otherProject.status).toBe(400);
    expect(await otherProject.json()).toEqual({ error: "recording_not_available" });
  });

  it("publishes safe SSR analytics and one curated recording, then revokes both", async () => {
    const publishedResponse = await updateSettings(assetProjectId, true, [assetSessionId]);
    expect(publishedResponse.status).toBe(200);
    const settings = (await publishedResponse.json()) as PublicPageSettings;
    expect(settings.enabled).toBe(true);
    expect(settings.publicId).toMatch(/^pub_[a-f0-9]{36}$/);
    expect(settings.publicUrl).toMatch(new RegExp(`/p/${settings.publicId}$`));
    expect(settings.recordings).toHaveLength(1);
    expect(settings.recordings[0]?.sessionId).toBe(assetSessionId);
    expect(settings.recordings[0]?.replayId).toMatch(/^replay_[a-f0-9]{36}$/);

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
    expect(data.analytics.sessions).toBe(1);
    expect(data.recordings).toEqual([
      expect.objectContaining({ replayId: publicReplayId, entryPath: "/" }),
    ]);
    expect(dataText).not.toContain(assetSessionId);
    expect(dataText).not.toContain('"projectId"');
    expect(dataText).not.toContain('"sessionId"');
    expect(dataText).not.toContain('"orgId"');
    expect(dataText).not.toContain('"liveNow"');

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
    expect(html).not.toContain(assetSessionId);
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
    expect(manifestText).not.toContain(assetSessionId);
    expect(manifestText).not.toContain("api_org");

    const segmentResponse = await worker.fetch(
      `/api/v1/public-pages/${publicId}/replays/${publicReplayId}/segments/${segmentName}`,
    );
    expect(segmentResponse.status).toBe(200);
    expect(segmentResponse.headers.get("cache-control")).toBe("no-store");
    expect(Array.from(new Uint8Array(await segmentResponse.arrayBuffer()))).toEqual(
      Array.from(segmentBytes),
    );

    const removedResponse = await updateSettings(assetProjectId, true, []);
    expect(removedResponse.status).toBe(200);
    const removedManifest = await worker.fetch(
      `/api/v1/public-pages/${publicId}/replays/${publicReplayId}/manifest`,
    );
    expect(removedManifest.status).toBe(404);

    const disabledResponse = await updateSettings(assetProjectId, false, []);
    expect(disabledResponse.status).toBe(200);
    const disabledData = await worker.fetch(`/api/v1/public-pages/${publicId}`);
    const disabledHtml = await worker.fetch(`/p/${publicId}`);
    expect(disabledData.status).toBe(404);
    expect(disabledHtml.status).toBe(404);
    expect(disabledHtml.headers.get("x-robots-tag")).toContain("noindex");
  });

  it("does not publish a valid recording from another project", async () => {
    const response = await updateSettings(listProjectId, true, [assetSessionId]);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "recording_not_available" });
  });
});

function updateSettings(projectId: string, enabled: boolean, sessionIds: string[]) {
  return worker.fetch(`/api/v1/projects/${projectId}/public-page`, {
    method: "PUT",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ enabled, sessionIds }),
  });
}
