import { EventType, IncrementalSource, type eventWithTime } from "@orange-replay/rrweb-fork";

export const SDK_BUFFER_CAP_BYTES = 4 * 1024 * 1024;

export type DropTier = "mouse" | "scroll" | "keep";

export interface BufferedEvent<T> {
  value: T;
  bytes: number;
  tier: DropTier;
}

export interface TrimResult<T> {
  kept: Array<BufferedEvent<T>>;
  dropped: Array<BufferedEvent<T>>;
  bytes: number;
}

export interface BackpressureDecision {
  accept: boolean;
  tier: DropTier;
  bufferedBytes: number;
}

export class BackpressureController {
  private readonly capBytes: number;
  private currentBytes = 0;
  private pendingBytes = 0;
  private dropped = 0;

  constructor(capBytes = SDK_BUFFER_CAP_BYTES) {
    this.capBytes = capBytes;
  }

  canAccept(event: eventWithTime, bytes: number): BackpressureDecision {
    const tier = eventDropTier(event);
    const bufferedBytes = this.bufferedBytes();

    if (bufferedBytes + bytes <= this.capBytes || tier === "keep") {
      return { accept: true, tier, bufferedBytes };
    }

    this.dropped += 1;
    return { accept: false, tier, bufferedBytes };
  }

  addCurrentBytes(bytes: number): void {
    this.currentBytes += Math.max(0, bytes);
  }

  removeCurrentBytes(bytes: number): void {
    this.currentBytes = Math.max(0, this.currentBytes - Math.max(0, bytes));
  }

  addPendingBytes(bytes: number): void {
    this.pendingBytes += Math.max(0, bytes);
  }

  removePendingBytes(bytes: number): void {
    this.pendingBytes = Math.max(0, this.pendingBytes - Math.max(0, bytes));
  }

  bufferedBytes(): number {
    return this.currentBytes + this.pendingBytes;
  }

  droppedCount(): number {
    return this.dropped;
  }

  recordDropped(count: number): void {
    this.dropped += Math.max(0, Math.floor(count));
  }

  resetCurrentBytes(): void {
    this.currentBytes = 0;
  }
}

export function trimBufferedEvents<T>(
  events: readonly BufferedEvent<T>[],
  capBytes = SDK_BUFFER_CAP_BYTES,
): TrimResult<T> {
  let bytes = totalBytes(events);
  const dropped = new Set<number>();

  for (const tier of ["mouse", "scroll"] satisfies DropTier[]) {
    for (let i = 0; i < events.length && bytes > capBytes; i += 1) {
      const event = events[i];
      if (event === undefined || event.tier !== tier || dropped.has(i)) {
        continue;
      }

      dropped.add(i);
      bytes -= Math.max(0, event.bytes);
    }
  }

  const keptEvents: Array<BufferedEvent<T>> = [];
  const droppedEvents: Array<BufferedEvent<T>> = [];

  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event === undefined) {
      continue;
    }

    if (dropped.has(i)) {
      droppedEvents.push(event);
    } else {
      keptEvents.push(event);
    }
  }

  return { kept: keptEvents, dropped: droppedEvents, bytes };
}

export function eventDropTier(event: eventWithTime): DropTier {
  if (event.type !== EventType.IncrementalSnapshot) {
    return event.type === EventType.FullSnapshot ? "keep" : "keep";
  }

  const source = event.data.source;

  if (
    source === IncrementalSource.MouseMove ||
    source === IncrementalSource.TouchMove ||
    source === IncrementalSource.Drag ||
    source === IncrementalSource.MouseInteraction
  ) {
    return "mouse";
  }

  if (source === IncrementalSource.Scroll) {
    return "scroll";
  }

  return "keep";
}

function totalBytes<T>(events: readonly BufferedEvent<T>[]): number {
  let total = 0;
  for (const event of events) {
    total += Math.max(0, event.bytes);
  }
  return total;
}
