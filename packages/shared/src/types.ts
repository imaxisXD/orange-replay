export type IndexEventKind =
  | "click"
  | "rage"
  | "error"
  | "nav"
  | "custom"
  | "input"
  | "scroll"
  | "vital";

export interface IndexEvent {
  t: number;
  k: IndexEventKind;
  d?: string;
  m?: Record<string, string | number>;
}

export interface BatchIndex {
  v: 1;
  s: string;
  tab: string;
  seq: number;
  t0: number;
  t1: number;
  e: IndexEvent[];
  u?: string;
  enc?: { k: string };
}

export interface EdgeAttrs {
  country?: string;
  region?: string;
  city?: string;
  device?: string;
  browser?: string;
  os?: string;
  asn?: number;
}

export interface SegmentRef {
  key: string;
  bytes: number;
  t0: number;
  t1: number;
  batches: number;
}

export interface SessionCounts {
  batches: number;
  events: number;
  clicks: number;
  errors: number;
  rages: number;
  navs: number;
}

export interface SessionManifest {
  v: 1;
  sessionId: string;
  projectId: string;
  orgId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  segments: SegmentRef[];
  timeline: IndexEvent[];
  counts: SessionCounts;
  bytes: number;
  flags: number;
  enc?: { k: string };
  attrs: EdgeAttrs & { entryUrl?: string; urlCount?: number };
}

export interface ProjectConfig {
  projectId: string;
  orgId: string;
  shard: number;
  active: boolean;
  sampleRate: number;
  allowedOrigins: string[];
  maskPolicyVersion: number;
  quotaState: "ok" | "soft" | "exceeded";
  retentionDays: number;
  jurisdiction?: "eu" | "fedramp";
}

export interface FinalizeMessage {
  type: "session.finalized";
  sessionId: string;
  projectId: string;
  orgId: string;
  shard: number;
  requestId: string;
  manifestKey: string;
  startedAt: number;
  endedAt: number;
  bytes: number;
  segments: number;
  flags: number;
  counts: SessionCounts;
  attrs: SessionManifest["attrs"];
  retentionDays: number;
  events: IndexEvent[];
}

export interface IngestAck {
  ok: boolean;
  live: boolean;
  flushMs: number;
  drop?: boolean;
  closed?: boolean;
}
