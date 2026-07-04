// RPC contract between the ingest path and the SessionRecorder DO.
// Seed-owned and FINAL: T1.2 implements it, T1.3 calls it. Changing this file
// requires changing both tasks — raise in the report instead of editing.
import type { BatchIndex, EdgeAttrs } from "@orange-replay/shared";

export interface AppendArgs {
  requestId: string;
  projectId: string;
  orgId: string;
  shard: number;
  retentionDays: number;
  sessionId: string;
  tab: string;
  seq: number;
  flags: number;
  index: BatchIndex;
  payload: Uint8Array;
  attrs: EdgeAttrs;
  receivedAt: number;
}

export interface AppendResult {
  live: boolean;
  closed: boolean;
  flushMs: number;
  checkpoint?: boolean;
}
