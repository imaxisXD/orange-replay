export const CHECKPOINT_SNAPSHOT_MIN_MS = 5_000;

export interface FullSnapshotRecorder {
  takeFullSnapshot(): void;
}

export interface CheckpointSnapshotLimiterOptions {
  recorder: FullSnapshotRecorder;
  now?: () => number;
}

export class CheckpointSnapshotLimiter {
  private readonly recorder: FullSnapshotRecorder;
  private readonly now: () => number;
  private lastSnapshotAt = Number.NEGATIVE_INFINITY;

  constructor(options: CheckpointSnapshotLimiterOptions) {
    this.recorder = options.recorder;
    this.now = options.now ?? Date.now;
  }

  requestSnapshot(): void {
    const currentTime = this.now();
    if (currentTime - this.lastSnapshotAt < CHECKPOINT_SNAPSHOT_MIN_MS) {
      return;
    }

    this.lastSnapshotAt = currentTime;
    this.recorder.takeFullSnapshot();
  }
}
