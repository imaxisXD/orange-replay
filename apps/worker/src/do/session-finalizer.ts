import { finalizeMessageSchema, manifestKey, sessionManifestSchema } from "@orange-replay/shared";
import type { FinalizeMessage } from "@orange-replay/shared";
import { capFinalizeMessageToBudget } from "./session-budgets.ts";
import { buildFinalizeTimelineData } from "./session-finalize-data.ts";
import { buildSessionManifest } from "./session-manifest.ts";
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
  presenceRemoveError?: string;
}

export interface SessionFinalizerDependencies {
  recordings: R2Bucket;
  finalizeQueue: Queue<FinalizeMessage>;
  store: Pick<
    SessionRecorderStore,
    "segmentRowsForManifest" | "storedEventRows" | "replaceStateWithTombstone"
  >;
  segmentWriter: Pick<SessionSegmentWriter, "assertRecordingMatches">;
  getSessionState: () => SessionState | null;
  flushPendingBatches: () => Promise<void>;
  queuePresenceRemove: (
    projectId: string,
    sessionId: string,
    requestId: string,
  ) => string | undefined;
  closeViewers: () => void;
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
    const analyticsVersion = Math.min(2, state.analyticsVersion);

    const message = capFinalizeMessageToBudget({
      type: "session.finalized",
      sessionId: state.sessionId,
      projectId: state.projectId,
      orgId: state.orgId,
      shard: state.shard,
      requestId: state.firstRequestId,
      manifestKey: key,
      startedAt: manifest.startedAt,
      endedAt: manifest.endedAt,
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

    await this.dependencies.finalizeQueue.send(message, { contentType: "json" });
    metrics.presenceRemoveError = this.dependencies.queuePresenceRemove(
      state.projectId,
      state.sessionId,
      state.firstRequestId,
    );
    this.dependencies.closeViewers();

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
}
