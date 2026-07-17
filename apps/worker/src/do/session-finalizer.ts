import {
  analyticsSidecarKey,
  finalizeMessageSchema,
  manifestKey,
  sessionManifestSchema,
} from "@orange-replay/shared";
import type { FinalizeMessage, IndexEvent, SessionManifest } from "@orange-replay/shared";
import {
  capFinalizeMessageToBudget,
  MAX_FINALIZE_ANALYTICS_BATCHES,
  MAX_FINALIZE_ANALYTICS_EVENT_BYTES,
} from "./session-budgets.ts";
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
  acceptedUsageReservationsEnabled: boolean;
  reserveAcceptedUsage: (state: SessionState, bytes: number) => Promise<void>;
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

    let analyticsWorkTruncated =
      state.batchCount >= MAX_FINALIZE_ANALYTICS_BATCHES ||
      state.totalEventBytes >= MAX_FINALIZE_ANALYTICS_EVENT_BYTES;
    if (!analyticsWorkTruncated) {
      rebuildFinalPageAnalytics(state, this.dependencies.store.finalPageBatches());
    }

    const key = manifestKey(state.projectId, state.sessionId);
    // A deploy can change bounded manifest generation after the immutable
    // object was already written but before this Durable Object stored its
    // tombstone. In that recovery window, the existing valid object is the
    // canonical replay and must also drive the queue message.
    const existingManifest = await this.readExistingManifest(key, state);
    // Segment references are the only unavoidably retained list because the
    // manifest itself contains them. Skip rebuilding them when an earlier
    // finalization already published the canonical immutable manifest.
    const segmentsForManifest =
      existingManifest === null ? [...this.dependencies.store.segmentRowsForManifest()] : [];
    const timelineRows = takeRowsWithinBudget(
      this.dependencies.store.storedEventRows(),
      MAX_FINALIZE_ANALYTICS_BATCHES,
      MAX_FINALIZE_ANALYTICS_EVENT_BYTES,
    );
    const timelineData = buildFinalizeTimelineData(
      timelineRows,
      state.startedAt,
      state.lastActivity,
    );
    analyticsWorkTruncated ||= timelineRows.truncated;
    const derived = timelineData.insights;
    metrics.rageBursts = derived.rageEvents.length;
    metrics.maxScrollDepth = derived.maxScrollDepth;
    metrics.interactionTimeMs = derived.interactionTimeMs;
    const manifestState = analyticsWorkTruncated ? { ...state, analyticsVersion: 0 } : state;
    let manifest =
      existingManifest ??
      buildSessionManifest(
        manifestState,
        segmentsForManifest,
        timelineData.timeline,
        timelineData.counts,
      );
    sessionManifestSchema.parse(manifest);
    const sidecarKey = analyticsWorkTruncated
      ? undefined
      : analyticsSidecarKey(state.projectId, state.sessionId);
    const analyticsVersion = analyticsWorkTruncated ? 0 : Math.min(2, state.analyticsVersion);

    // Reserve the final delta before publishing the immutable manifest or its
    // queue job. A retry repeats the same monotonic reservation.
    if (this.dependencies.acceptedUsageReservationsEnabled) {
      await this.dependencies.reserveAcceptedUsage(
        state,
        Math.max(manifest.bytes, state.totalPayloadBytes + state.totalEventBytes),
      );
    }

    if (existingManifest === null) {
      const manifestWritten = await this.dependencies.recordings.put(
        key,
        JSON.stringify(manifest),
        {
          httpMetadata: { contentType: "application/json" },
          onlyIf: { etagDoesNotMatch: "*" },
        },
      );
      if (manifestWritten === null) {
        const concurrentlyWrittenManifest = await this.readExistingManifest(key, state);
        if (concurrentlyWrittenManifest === null) {
          throw new Error("The session manifest was not available after its write conflict.");
        }
        manifest = concurrentlyWrittenManifest;
        // The winner's immutable manifest can report a larger byte total than
        // this candidate. Keep the accepted reservation monotonic before the
        // queue message makes that winner visible to D1.
        if (this.dependencies.acceptedUsageReservationsEnabled) {
          await this.dependencies.reserveAcceptedUsage(
            state,
            Math.max(manifest.bytes, state.totalPayloadBytes + state.totalEventBytes),
          );
        }
      }
    }

    metrics.segmentCount = manifest.segments.length;
    metrics.bytes = manifest.bytes;
    metrics.batchCount = manifest.counts.batches;
    metrics.timelineEventsDropped = Math.max(
      0,
      timelineData.counts.events - manifest.timeline.length,
    );
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
      ...(sidecarKey === undefined ? {} : { analyticsSidecarKey: sidecarKey }),
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
    finalizeMessageSchema.parse(message);

    // The immutable replay is ready. Hand it to current viewers before any
    // analytics or queue work so those background steps cannot hold playback.
    this.dependencies.finalizeViewers(manifest);

    metrics.presenceMarkError = await this.dependencies.markPresenceFinalizing(
      state.projectId,
      state.sessionId,
      state.firstRequestId,
      state.finalizingAt ?? Date.now(),
    );

    if (sidecarKey !== undefined) {
      await this.writeAnalyticsSidecar(sidecarKey, derived.rageEvents);
    }

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

  private async readExistingManifest(
    key: string,
    state: SessionState,
  ): Promise<SessionManifest | null> {
    const object = await this.dependencies.recordings.get(key);
    if (object === null) return null;

    let manifest: SessionManifest;
    try {
      manifest = sessionManifestSchema.parse(await object.json<unknown>());
    } catch {
      throw new Error("The existing session manifest is invalid.");
    }
    if (
      manifest.projectId !== state.projectId ||
      manifest.orgId !== state.orgId ||
      manifest.sessionId !== state.sessionId
    ) {
      throw new Error("The existing session manifest belongs to a different session.");
    }
    return manifest;
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

    const parts = analyticsSidecarParts(this.analyticsRows(), derivedEvents)[Symbol.iterator]();
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
    const length = analyticsSidecarByteLength(this.analyticsRows(), derivedEvents);
    await this.dependencies.segmentWriter.assertRecordingStreamMatches(
      sidecarKey,
      createAnalyticsSidecarStream(this.analyticsRows(), derivedEvents),
      length,
    );
  }

  private analyticsRows(): Iterable<{ events: string }> {
    return takeRowsWithinBudget(
      this.dependencies.store.storedEventRows(),
      MAX_FINALIZE_ANALYTICS_BATCHES,
      MAX_FINALIZE_ANALYTICS_EVENT_BYTES,
    );
  }
}

interface BoundedEventRows<T> extends Iterable<T> {
  truncated: boolean;
}

function takeRowsWithinBudget<T extends { events: string }>(
  rows: Iterable<T>,
  rowLimit: number,
  byteLimit: number,
): BoundedEventRows<T> {
  const result: BoundedEventRows<T> = {
    truncated: false,
    *[Symbol.iterator]() {
      const iterator = rows[Symbol.iterator]();
      let bytesUsed = 0;
      try {
        for (let count = 0; count < rowLimit; count += 1) {
          const next = iterator.next();
          if (next.done) return;
          const nextBytes = utf8Encoder.encode(next.value.events).byteLength;
          if (bytesUsed + nextBytes > byteLimit) {
            result.truncated = true;
            return;
          }
          bytesUsed += nextBytes;
          yield next.value;
        }
        result.truncated = true;
      } finally {
        iterator.return?.();
      }
    },
  };
  return result;
}
