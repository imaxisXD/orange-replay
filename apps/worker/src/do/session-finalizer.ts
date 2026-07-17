import {
  analyticsSidecarKey,
  finalizeMessageSchema,
  manifestKey,
  sessionManifestSchema,
} from "@orange-replay/shared";
import type { FinalizeMessage, IndexEvent, SessionManifest } from "@orange-replay/shared";
import { capFinalizeMessageToBudget } from "./session-budgets.ts";
import {
  analyticsSidecarByteLength,
  analyticsSidecarParts,
  createAnalyticsSidecarStream,
} from "./session-analytics-sidecar.ts";
import { buildFinalizeTimelineData } from "./session-finalize-data.ts";
import {
  buildSessionManifest,
  manifestHasCheckpoint,
  sessionServerBounds,
} from "./session-manifest.ts";
import { rebuildFinalPageAnalytics } from "./session-page-tracking.ts";
import type { FinalizedTombstone, SessionRecorderStore } from "./session-recorder-store.ts";
import type { SessionSegmentWriter } from "./session-segment-writer.ts";
import type { SessionState } from "./session-state.ts";

const utf8Encoder = new TextEncoder();

export interface SessionFinalizeMetrics {
  segmentCount: number;
  bytes: number;
  batchCount: number;
  timelineEventsDropped: number;
  rageBursts: number;
  maxScrollDepth: number;
  interactionTimeMs: number;
  presenceMarkError?: string;
}

export interface SessionFinalizerDependencies {
  recordings: R2Bucket;
  finalizeQueue: Queue<FinalizeMessage>;
  store: Pick<
    SessionRecorderStore,
    "segmentRowsForManifest" | "storedEventRows" | "finalPageBatches" | "replaceStateWithTombstone"
  >;
  segmentWriter: Pick<
    SessionSegmentWriter,
    "assertRecordingMatches" | "assertRecordingStreamMatches"
  >;
  getSessionState: () => SessionState | null;
  flushPendingBatches: () => Promise<void>;
  markPresenceFinalizing: (
    projectId: string,
    sessionId: string,
    requestId: string,
    finalizingAt: number,
  ) => Promise<string | undefined>;
  finalizeViewers: (manifest: SessionManifest) => void;
  rememberTombstone: (tombstone: FinalizedTombstone) => void;
  scheduleTombstonePurge: (purgeAt: number) => Promise<void>;
}

export function createSessionFinalizeMetrics(): SessionFinalizeMetrics {
  return {
    segmentCount: 0,
    bytes: 0,
    batchCount: 0,
    timelineEventsDropped: 0,
    rageBursts: 0,
    maxScrollDepth: 0,
    interactionTimeMs: 0,
  };
}

export class SessionFinalizer {
  constructor(private readonly dependencies: SessionFinalizerDependencies) {}

  async finalize(metrics: SessionFinalizeMetrics): Promise<void> {
    const stateBeforeFlush = this.dependencies.getSessionState();
    if (stateBeforeFlush === null) {
      return;
    }

    await this.dependencies.flushPendingBatches();
    const state = this.dependencies.getSessionState();
    if (state === null) {
      return;
    }

    const finalPageBatches = this.dependencies.store.finalPageBatches();
    if (
      finalPageBatches.length > 0 &&
      finalPageBatches.every((batch) => batch.pageAnalyticsVersion === 1)
    ) {
      rebuildFinalPageAnalytics(state, finalPageBatches);
    }

    const segmentsForManifest = this.dependencies.store.segmentRowsForManifest();
    const timelineRows = this.dependencies.store.storedEventRows();
    const timelineData = buildFinalizeTimelineData(
      timelineRows,
      state.startedAt,
      state.lastActivity,
    );
    const derived = timelineData.insights;
    metrics.rageBursts = derived.rageEvents.length;
    metrics.maxScrollDepth = derived.maxScrollDepth;
    metrics.interactionTimeMs = derived.interactionTimeMs;
    const manifest = buildSessionManifest(
      state,
      segmentsForManifest,
      timelineData.timeline,
      timelineData.counts,
    );
    metrics.segmentCount = manifest.segments.length;
    metrics.bytes = manifest.bytes;
    metrics.batchCount = manifest.counts.batches;
    metrics.timelineEventsDropped = Math.max(
      0,
      timelineData.counts.events - manifest.timeline.length,
    );
    const key = manifestKey(state.projectId, state.sessionId);
    const sidecarKey = analyticsSidecarKey(state.projectId, state.sessionId);
    const analyticsVersion = Math.min(2, state.analyticsVersion);
    // D1 keeps server-observed bounds for ordering and retention; the
    // recorded-time duration and checkpoint fact ride alongside them.
    const serverBounds = sessionServerBounds(state, manifest.segments);

    const message = capFinalizeMessageToBudget({
      type: "session.finalized",
      sessionId: state.sessionId,
      projectId: state.projectId,
      orgId: state.orgId,
      shard: state.shard,
      requestId: state.firstRequestId,
      manifestKey: key,
      analyticsSidecarKey: sidecarKey,
      startedAt: serverBounds.startedAt,
      endedAt: serverBounds.endedAt,
      durationMs: manifest.durationMs,
      hasCheckpoint: manifestHasCheckpoint(manifest.segments),
      bytes: manifest.bytes,
      segments: manifest.segments.length,
      flags: manifest.flags,
      analyticsVersion,
      ...(analyticsVersion >= 2
        ? {
            insights: {
              maxScrollDepth: derived.maxScrollDepth,
              quickBacks: state.quickBacks,
              interactionTimeMs: derived.interactionTimeMs,
              activityHist: timelineData.activityHist,
            },
          }
        : {}),
      counts: manifest.counts,
      attrs: manifest.attrs,
      retentionDays: state.retentionDays,
      events: timelineData.finalizeEvents,
    } satisfies FinalizeMessage);
    sessionManifestSchema.parse(manifest);
    finalizeMessageSchema.parse(message);

    const manifestWritten = await this.dependencies.recordings.put(key, JSON.stringify(manifest), {
      httpMetadata: { contentType: "application/json" },
      onlyIf: { etagDoesNotMatch: "*" },
    });
    if (manifestWritten === null) {
      await this.dependencies.segmentWriter.assertRecordingMatches(
        key,
        utf8Encoder.encode(JSON.stringify(manifest)),
      );
    }

    // The immutable replay is ready. Hand it to current viewers before any
    // analytics or queue work so those background steps cannot hold playback.
    this.dependencies.finalizeViewers(manifest);

    metrics.presenceMarkError = await this.dependencies.markPresenceFinalizing(
      state.projectId,
      state.sessionId,
      state.firstRequestId,
      state.finalizingAt ?? Date.now(),
    );

    await this.writeAnalyticsSidecar(sidecarKey, derived.rageEvents);

    await this.dependencies.finalizeQueue.send(message, { contentType: "json" });
    // A final sweep closes any socket accepted just before finalizing started.
    this.dependencies.finalizeViewers(manifest);

    const finalizedAt = Date.now();
    const purgeAt = finalizedAt + state.retentionDays * 86_400_000;
    const tombstone: FinalizedTombstone = {
      finalized: true,
      finalizedAt,
      purgeAt,
      firstRequestId: state.firstRequestId,
      projectId: state.projectId,
      orgId: state.orgId,
      sessionId: state.sessionId,
    };
    this.dependencies.store.replaceStateWithTombstone(tombstone);
    this.dependencies.rememberTombstone(tombstone);
    await this.dependencies.scheduleTombstonePurge(purgeAt);
  }

  private async writeAnalyticsSidecar(
    sidecarKey: string,
    derivedEvents: readonly IndexEvent[],
  ): Promise<void> {
    const existing = await this.dependencies.recordings.head(sidecarKey);
    if (existing !== null) {
      await this.assertAnalyticsSidecarMatches(sidecarKey, derivedEvents);
      return;
    }

    const parts = analyticsSidecarParts(this.dependencies.store.storedEventRows(), derivedEvents)[
      Symbol.iterator
    ]();
    const first = parts.next();
    if (first.done) throw new Error("Analytics sidecar did not contain a header.");
    const second = parts.next();

    if (second.done) {
      const written = await this.dependencies.recordings.put(sidecarKey, first.value, {
        httpMetadata: { contentType: "application/x-ndjson" },
        onlyIf: { etagDoesNotMatch: "*" },
      });
      if (written === null) {
        await this.assertAnalyticsSidecarMatches(sidecarKey, derivedEvents);
      }
      return;
    }

    const upload = await this.dependencies.recordings.createMultipartUpload(sidecarKey, {
      httpMetadata: { contentType: "application/x-ndjson" },
    });
    const uploaded: R2UploadedPart[] = [];
    try {
      let partNumber = 1;
      let current: IteratorResult<Uint8Array> = first;
      for (;;) {
        if (current.done) break;
        uploaded.push(await upload.uploadPart(partNumber, current.value));
        partNumber += 1;
        current = partNumber === 2 ? second : parts.next();
      }
      await upload.complete(uploaded);
    } catch (error) {
      await upload.abort().catch(() => undefined);
      throw error;
    }
  }

  private async assertAnalyticsSidecarMatches(
    sidecarKey: string,
    derivedEvents: readonly IndexEvent[],
  ): Promise<void> {
    // Every pass starts a fresh, paged query instead of keeping the full
    // sidecar in Worker memory.
    const length = analyticsSidecarByteLength(
      this.dependencies.store.storedEventRows(),
      derivedEvents,
    );
    await this.dependencies.segmentWriter.assertRecordingStreamMatches(
      sidecarKey,
      createAnalyticsSidecarStream(this.dependencies.store.storedEventRows(), derivedEvents),
      length,
    );
  }
}
