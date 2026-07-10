import type { IndexEvent } from "@orange-replay/shared/types";
import type { eventWithTime } from "@orange-replay/rrweb-fork";
import type { Transport } from "../pipeline/transport.ts";
import type { WorkerHost } from "../pipeline/worker-host.ts";
import type { SessionManager } from "../session.ts";
import type { RecorderConfig } from "../types.ts";

export type FlushReason = "timer" | "visibility" | "pagehide" | "manual";

export type InternalFlushReason = FlushReason | "threshold";

export interface Sink {
  addRrwebEvent(event: eventWithTime): void;
  addIndexEvent(event: IndexEvent): void;
  onNavigation(url: string): void;
  flush(reason: FlushReason): Promise<void>;
  prepareForSessionRotation(): Promise<void>;
  resetAfterSessionRotation(): void;
  stop(): Promise<void>;
}

export interface InlineSinkOptions {
  config: RecorderConfig;
  session: SessionManager;
  window: Window;
  fetch?: typeof fetch;
  onSessionClosed?: () => void;
  onCheckpointRequested?: () => void;
}

export interface WorkerSinkOptions extends InlineSinkOptions {
  workerHost?: WorkerHost;
  transport?: Transport;
}
