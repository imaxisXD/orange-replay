import type { SessionManifest } from "@orange-replay/shared/types";
import type { PlayerErrorEvent, ReplayEvent } from "../types.ts";
import type { RecordedSegmentLoader } from "./recorded-segment-loader.ts";

const REPLAY_END_TOLERANCE_MS = 100;

type PlayerErrorSeverity = NonNullable<PlayerErrorEvent["severity"]>;

export interface RecordedPlaybackHost {
  isPlaying(): boolean;
  isDestroyed(): boolean;
  isFollowing(): boolean;
  isPlayRequested(): boolean;
  isCurrentPlaybackOperation(operation: number): boolean;
  getManifest(): SessionManifest | undefined;
  getCurrentMs(): number;
  getPlaybackOperation(): number;
  setCurrentMs(currentMs: number): void;
  setPlaying(playing: boolean): void;
  setPlayRequested(playRequested: boolean): void;
  readRenderedTime(): number | null;
  emitProgress(): void;
  drawOverlay(): void;
  emitEnded(): void;
  startPlayback(): void;
  beginBuffering(segmentIndex: number): void;
  endBuffering(segmentIndex: number): void;
  onError(message: string, error?: unknown, severity?: PlayerErrorSeverity): void;
}

interface RecordedPlaybackControllerOptions {
  segments: RecordedSegmentLoader;
  host: RecordedPlaybackHost;
}

export class RecordedPlaybackController {
  private readonly segments: RecordedSegmentLoader;
  private readonly host: RecordedPlaybackHost;
  private progressFrame: number | undefined;
  private recoveringLoadedEnd = false;

  constructor(options: RecordedPlaybackControllerOptions) {
    this.segments = options.segments;
    this.host = options.host;
  }

  scheduleProgressLoop(): void {
    this.cancelProgressLoop();
    this.progressFrame = requestFrame(() => this.progressLoop());
  }

  cancelProgressLoop(): void {
    if (this.progressFrame === undefined) {
      return;
    }

    cancelFrame(this.progressFrame);
    this.progressFrame = undefined;
  }

  updateProgressTime(): void {
    const manifest = this.host.getManifest();
    if (!this.host.isPlaying() || manifest === undefined) {
      return;
    }

    const replayerTime = this.host.readRenderedTime();
    if (replayerTime === null) {
      return;
    }

    this.host.setCurrentMs(
      Math.max(this.host.getCurrentMs(), Math.min(manifest.durationMs, replayerTime)),
    );
  }

  prefetchAroundCurrentTime(): void {
    if (this.host.getManifest() === undefined || this.host.isFollowing()) {
      return;
    }

    const window = this.segments.segmentWindowAt(this.host.getCurrentMs());
    if (window === undefined) {
      return;
    }
    for (const segmentIndex of window.prefetchIndexes) {
      this.prefetchSegment(segmentIndex, "Could not prefetch replay segment.");
    }
  }

  prefetchSegment(index: number, errorMessage: string): void {
    if (
      this.segments.hasLoaded(index) ||
      this.segments.isLoading(index) ||
      this.host.isDestroyed()
    ) {
      return;
    }

    void this.segments.loadSegment(index).catch((error) => {
      if (!this.host.isDestroyed()) {
        this.host.onError(errorMessage, error, "warning");
      }
    });
  }

  handleReplayerFinish(): void {
    this.updateProgressTime();
    this.host.emitProgress();
    this.host.drawOverlay();

    const manifest = this.host.getManifest();
    if (this.host.isFollowing() || manifest === undefined || this.host.isDestroyed()) {
      return;
    }

    const nextSegmentIndex = this.segments.nextUnloadedSegmentIndex();
    if (nextSegmentIndex === undefined) {
      this.host.setCurrentMs(manifest.durationMs);
      this.finishIfDone();
      return;
    }

    if (this.recoveringLoadedEnd) {
      return;
    }

    const operation = this.host.getPlaybackOperation();
    this.recoveringLoadedEnd = true;
    this.host.setPlaying(false);
    this.cancelProgressLoop();
    this.host.beginBuffering(nextSegmentIndex);
    void this.segments
      .loadSegment(nextSegmentIndex)
      .then(() => {
        if (
          !this.host.isDestroyed() &&
          this.host.isCurrentPlaybackOperation(operation) &&
          this.host.isPlayRequested()
        ) {
          this.host.startPlayback();
        }
      })
      .catch((error) => {
        if (!this.host.isDestroyed()) {
          this.host.setPlayRequested(false);
          this.host.onError("Could not load the next replay segment.", error);
        }
      })
      .finally(() => {
        this.recoveringLoadedEnd = false;
        this.host.endBuffering(nextSegmentIndex);
      });
  }

  isAtRecordedEnd(manifest: SessionManifest, events: readonly ReplayEvent[]): boolean {
    if (this.segments.nextUnloadedSegmentIndex() !== undefined) {
      return false;
    }

    const lastEvent = events.at(-1);
    const lastEventMs =
      lastEvent === undefined ? manifest.durationMs : lastEvent.timestamp - manifest.startedAt;
    const replayEndMs = Math.min(manifest.durationMs, Math.max(0, lastEventMs));
    return this.host.getCurrentMs() >= Math.max(0, replayEndMs - REPLAY_END_TOLERANCE_MS);
  }

  private progressLoop(): void {
    const manifest = this.host.getManifest();
    if (!this.host.isPlaying() || manifest === undefined || this.host.isDestroyed()) {
      return;
    }

    this.updateProgressTime();
    this.host.emitProgress();
    this.host.drawOverlay();
    this.prefetchAroundCurrentTime();

    if (this.host.getCurrentMs() >= manifest.durationMs && !this.host.isFollowing()) {
      this.finishIfDone();
      return;
    }

    this.progressFrame = requestFrame(() => this.progressLoop());
  }

  private finishIfDone(): void {
    const manifest = this.host.getManifest();
    if (
      this.host.isFollowing() ||
      manifest === undefined ||
      this.host.getCurrentMs() < manifest.durationMs
    ) {
      return;
    }

    this.host.setPlaying(false);
    this.host.setPlayRequested(false);
    this.cancelProgressLoop();
    this.host.setCurrentMs(manifest.durationMs);
    this.host.emitProgress();
    this.host.emitEnded();
  }
}

function requestFrame(callback: () => void): number {
  if (typeof requestAnimationFrame === "function") {
    return requestAnimationFrame(callback);
  }

  return Number(setTimeout(callback, 16));
}

function cancelFrame(id: number): void {
  if (typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(id);
    return;
  }

  clearTimeout(id);
}
