import type { SegmentRef, SessionManifest } from "@orange-replay/shared/types";
import { fetchSegmentBytes, loadSession } from "../api.ts";
import {
  chooseSegmentWindow,
  decodeSegmentBatches,
  discoverSegmentCheckpoints,
  findSegmentIndex,
  findPrimaryReplayTab,
  type DecodedReplayBatch,
  validateSegmentCheckpoints,
} from "../segments.ts";
import type { OrangePlayerOptions, SegmentWindow } from "../types.ts";
import type { DecodeWorkerHost } from "../worker-host.ts";

export interface LoadedRecordedSegment {
  index: number;
  segment: SegmentRef;
  batches: DecodedReplayBatch[];
}

interface LoadingSegment {
  promise: Promise<void>;
  controller: AbortController;
  generation: number;
  detachRootAbort: () => void;
}

interface LoadedSegmentStats {
  events: number;
  decodedBytes: number;
}

export const MAX_ACTIVE_REPLAY_EVENTS = 250_000;
export const MAX_ACTIVE_REPLAY_DECODED_BYTES = 128 * 1024 * 1024;

export interface ActiveReplayWindowSize {
  events: number;
  decodedBytes: number;
}

export interface RecordedSegmentLoaderOptions {
  request: Pick<OrangePlayerOptions, "api" | "projectId" | "sessionId" | "token">;
  signal: AbortSignal;
  worker: DecodeWorkerHost;
  isDestroyed: () => boolean;
  isFollowing: () => boolean;
  onSegmentLoaded: (loaded: LoadedRecordedSegment) => void;
}

export class RecordedSegmentLoader {
  private readonly options: RecordedSegmentLoaderOptions;
  private readonly loadedSegments = new Set<number>();
  private readonly loadingSegments = new Map<number, LoadingSegment>();
  private readonly loadedSegmentStats = new Map<number, LoadedSegmentStats>();
  private manifest: SessionManifest | undefined;
  private segments: SegmentRef[] = [];
  private loadGeneration = 0;
  private orderedLoadPlan = 0;
  private windowStartIndex = 0;
  private activeReplayTab: string | undefined;
  private activeEventCount = 0;
  private activeDecodedBytes = 0;

  constructor(options: RecordedSegmentLoaderOptions) {
    this.options = options;
  }

  loadManifest(): Promise<SessionManifest> {
    return loadSession(this.options.request.api, {
      projectId: this.options.request.projectId,
      sessionId: this.options.request.sessionId,
      token: this.options.request.token,
      signal: this.options.signal,
    });
  }

  useManifest(manifest: SessionManifest): void {
    this.manifest = manifest;
    this.segments = manifest.segments.map((segment) => ({
      ...segment,
      ...(segment.checkpoints === undefined
        ? {}
        : { checkpoints: segment.checkpoints.map((checkpoint) => ({ ...checkpoint })) }),
    }));
    this.activeReplayTab = findPrimaryReplayTab(this.segments);
  }

  get replayTab(): string | undefined {
    return this.activeReplayTab;
  }

  segmentWindowAt(timeMs: number): SegmentWindow | undefined {
    const manifest = this.manifest;
    if (manifest === undefined) {
      return undefined;
    }

    const targetTimestamp = manifest.startedAt + Math.max(0, timeMs);
    const index = findSegmentIndex(this.segments, manifest.startedAt, timeMs);
    return chooseSegmentWindow(this.segments, index, {
      targetTimestamp,
      replayTab: this.activeReplayTab,
    });
  }

  loadSegment(index: number): Promise<void> {
    const manifest = this.manifest;
    if (
      manifest === undefined ||
      index < this.windowStartIndex ||
      index < 0 ||
      index >= this.segments.length
    ) {
      return Promise.resolve();
    }

    if (this.loadedSegments.has(index)) {
      return Promise.resolve();
    }

    const activeLoad = this.loadingSegments.get(index);
    if (activeLoad !== undefined) {
      return activeLoad.promise;
    }

    const segment = this.segments[index];
    if (segment === undefined) {
      return Promise.resolve();
    }

    const generation = this.loadGeneration;
    const linkedAbort = createLinkedAbortController(this.options.signal);
    const loading: LoadingSegment = {
      controller: linkedAbort.controller,
      detachRootAbort: linkedAbort.detach,
      generation,
      promise: Promise.resolve(),
    };
    loading.promise = this.fetchAndDecodeSegment(
      index,
      segment,
      generation,
      loading.controller.signal,
    )
      .catch((error) => {
        if (loading.controller.signal.aborted || generation !== this.loadGeneration) {
          return;
        }
        throw error;
      })
      .finally(() => {
        loading.detachRootAbort();
        if (this.loadingSegments.get(index) === loading) {
          this.loadingSegments.delete(index);
        }
      });
    this.loadingSegments.set(index, loading);
    return loading.promise;
  }

  async loadSegmentsInOrder(indexes: readonly number[]): Promise<void> {
    const generation = this.loadGeneration;
    const plan = ++this.orderedLoadPlan;
    for (const index of indexes) {
      if (!this.isCurrentOrderedLoadPlan(plan, generation)) {
        return;
      }
      try {
        await this.loadSegment(index);
      } catch (error) {
        if (!this.isCurrentOrderedLoadPlan(plan, generation)) {
          return;
        }
        throw error;
      }
      if (!this.isCurrentOrderedLoadPlan(plan, generation)) {
        return;
      }
    }
  }

  hasLoaded(index: number): boolean {
    return this.loadedSegments.has(index);
  }

  isLoading(index: number): boolean {
    return this.loadingSegments.has(index);
  }

  nextUnloadedSegmentIndex(): number | undefined {
    for (let index = this.windowStartIndex; index < this.segments.length; index += 1) {
      if (!this.loadedSegments.has(index)) {
        return index;
      }
    }
    return undefined;
  }

  clearLoadedSegments(): void {
    this.cancelLoadingSegments();
    this.loadedSegments.clear();
    this.loadedSegmentStats.clear();
    this.activeEventCount = 0;
    this.activeDecodedBytes = 0;
    this.windowStartIndex = 0;
  }

  clearLoadingSegments(): void {
    this.cancelLoadingSegments();
  }

  resetLoadedWindow(startIndex: number): void {
    this.clearLoadedSegments();
    this.windowStartIndex = cleanSegmentIndex(startIndex, this.segments.length);
  }

  forgetLoadedBefore(startIndex: number): void {
    const cleanStart = cleanSegmentIndex(startIndex, this.segments.length);
    this.windowStartIndex = cleanStart;

    for (const [index, loading] of this.loadingSegments) {
      if (index >= cleanStart) {
        continue;
      }
      loading.controller.abort();
      loading.detachRootAbort();
      this.loadingSegments.delete(index);
    }

    for (const index of this.loadedSegments) {
      if (index >= cleanStart) {
        continue;
      }
      this.loadedSegments.delete(index);
      const stats = this.loadedSegmentStats.get(index);
      if (stats !== undefined) {
        this.activeEventCount = Math.max(0, this.activeEventCount - stats.events);
        this.activeDecodedBytes = Math.max(0, this.activeDecodedBytes - stats.decodedBytes);
        this.loadedSegmentStats.delete(index);
      }
    }
  }

  private async fetchAndDecodeSegment(
    index: number,
    segment: SegmentRef,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    const bytes = await fetchSegmentBytes(this.options.request.api, {
      projectId: this.options.request.projectId,
      sessionId: this.options.request.sessionId,
      token: this.options.request.token,
      segment,
      signal,
    });
    if (this.isStaleLoad(index, generation, signal)) {
      return;
    }

    const batches = await decodeSegmentBatches(bytes, this.options.worker);
    if (this.isStaleLoad(index, generation, signal)) {
      return;
    }

    validateSegmentCheckpoints(segment, batches);
    if ((segment.checkpoints?.length ?? 0) === 0) {
      const discovered = discoverSegmentCheckpoints(batches);
      if (discovered.length > 0) {
        segment.checkpoints = discovered;
        this.activeReplayTab ??= findPrimaryReplayTab(this.segments);
      }
    }

    const stats = segmentStats(batches);
    this.assertActiveWindowBudget(stats);

    this.options.onSegmentLoaded({ index, segment, batches });
    if (this.isStaleLoad(index, generation, signal)) {
      return;
    }
    this.loadedSegments.add(index);
    this.loadedSegmentStats.set(index, stats);
    this.activeEventCount += stats.events;
    this.activeDecodedBytes += stats.decodedBytes;
  }

  private isStaleLoad(index: number, generation: number, signal: AbortSignal): boolean {
    return (
      signal.aborted || index < this.windowStartIndex || !this.isCurrentLoadGeneration(generation)
    );
  }

  private isCurrentLoadGeneration(generation: number): boolean {
    return (
      !this.options.signal.aborted &&
      generation === this.loadGeneration &&
      !this.options.isFollowing() &&
      !this.options.isDestroyed()
    );
  }

  private isCurrentOrderedLoadPlan(plan: number, generation: number): boolean {
    return plan === this.orderedLoadPlan && this.isCurrentLoadGeneration(generation);
  }

  private assertActiveWindowBudget(stats: LoadedSegmentStats): void {
    const limit = activeReplayWindowLimit(
      { events: this.activeEventCount, decodedBytes: this.activeDecodedBytes },
      stats,
    );
    if (limit === "events") {
      throw new Error("Replay checkpoint window has too many events to load safely.");
    }
    if (limit === "decodedBytes") {
      throw new Error("Replay checkpoint window is too large after decoding.");
    }
  }

  private cancelLoadingSegments(): void {
    this.loadGeneration += 1;
    for (const loading of this.loadingSegments.values()) {
      loading.controller.abort();
      loading.detachRootAbort();
    }
    this.loadingSegments.clear();
  }
}

export function activeReplayWindowLimit(
  current: ActiveReplayWindowSize,
  next: ActiveReplayWindowSize,
  limits: ActiveReplayWindowSize = {
    events: MAX_ACTIVE_REPLAY_EVENTS,
    decodedBytes: MAX_ACTIVE_REPLAY_DECODED_BYTES,
  },
): keyof ActiveReplayWindowSize | null {
  if (current.events + next.events > limits.events) {
    return "events";
  }
  if (current.decodedBytes + next.decodedBytes > limits.decodedBytes) {
    return "decodedBytes";
  }
  return null;
}

function segmentStats(batches: readonly DecodedReplayBatch[]): LoadedSegmentStats {
  let events = 0;
  let decodedBytes = 0;
  for (const batch of batches) {
    events += batch.events.length;
    decodedBytes += batch.decodedBytes;
  }
  return { events, decodedBytes };
}

function cleanSegmentIndex(index: number, segmentCount: number): number {
  if (segmentCount === 0) {
    return 0;
  }
  return Math.max(0, Math.min(segmentCount - 1, Math.floor(index)));
}

function createLinkedAbortController(rootSignal: AbortSignal): {
  controller: AbortController;
  detach: () => void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (rootSignal.aborted) {
    controller.abort();
  } else {
    rootSignal.addEventListener("abort", abort, { once: true });
  }
  return {
    controller,
    detach: () => rootSignal.removeEventListener("abort", abort),
  };
}
