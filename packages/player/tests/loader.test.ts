import { describe, expect, it } from "vite-plus/test";
import type { SessionManifest } from "@orange-replay/shared/types";
import { buildSegment } from "@orange-replay/shared/wire";
import { fetchSegmentBytes, loadSession } from "../src/api.ts";
import { decodeSegmentEvents } from "../src/segments.ts";
import type { ReplayEvent } from "../src/types.ts";
import { DecodeWorkerHost } from "../src/worker-host.ts";

const encoder = new TextEncoder();

describe("manifest and segment loading", () => {
  it("loads a manifest and decodes an ORS1 segment built by shared helpers", async () => {
    const events = [makeEvent(1_100, "full"), makeEvent(1_200, "click")];
    const segment = buildSegment([await gzipJson(events)]);
    const manifest = makeManifest(segment.byteLength);
    const fetchCalls: string[] = [];
    const api = {
      baseUrl: "https://api.example.test",
      fetch: async (url: string | URL | Request) => {
        const requestUrl = requestUrlString(url);
        fetchCalls.push(requestUrl);

        if (requestUrl.endsWith("/manifest")) {
          return Response.json(manifest);
        }

        return new Response(segment as unknown as BodyInit, {
          headers: { "content-type": "application/octet-stream" },
        });
      },
    };

    const loadedManifest = await loadSession(api, {
      projectId: "project",
      sessionId: "session",
      token: "dev-token",
    });
    const segmentBytes = await fetchSegmentBytes(api, {
      projectId: "project",
      sessionId: "session",
      token: "dev-token",
      segment: manifest.segments[0]!,
    });
    const worker = new DecodeWorkerHost({ allowSynchronousFallback: true });

    expect(loadedManifest).toEqual(manifest);
    expect(await decodeSegmentEvents(segmentBytes, worker)).toEqual(events);
    expect(fetchCalls).toEqual([
      "https://api.example.test/api/v1/projects/project/sessions/session/manifest",
      "https://api.example.test/api/v1/projects/project/sessions/session/segments/seg-000001.ors",
    ]);
  });
});

async function gzipJson(events: readonly ReplayEvent[]): Promise<Uint8Array> {
  const body = new Response(encoder.encode(JSON.stringify(events))).body;
  if (body === null) {
    throw new Error("test gzip body missing");
  }

  return new Uint8Array(
    await new Response(body.pipeThrough(new CompressionStream("gzip"))).arrayBuffer(),
  );
}

function makeManifest(segmentBytes: number): SessionManifest {
  return {
    v: 1,
    sessionId: "session",
    projectId: "project",
    orgId: "org",
    startedAt: 1_000,
    endedAt: 2_000,
    durationMs: 1_000,
    segments: [
      {
        key: "p/project/session/seg-000001.ors",
        bytes: segmentBytes,
        t0: 1_000,
        t1: 2_000,
        batches: 1,
      },
    ],
    timeline: [{ t: 1_100, k: "click" }],
    counts: { batches: 1, events: 1, clicks: 1, errors: 0, rages: 0, navs: 0 },
    bytes: segmentBytes,
    flags: 0,
    attrs: {},
  };
}

function makeEvent(timestamp: number, name: string): ReplayEvent {
  return { type: 0, timestamp, data: { name } } as ReplayEvent;
}

function requestUrlString(url: string | URL | Request): string {
  if (typeof url === "string") {
    return url;
  }

  if (url instanceof URL) {
    return url.toString();
  }

  return url.url;
}
