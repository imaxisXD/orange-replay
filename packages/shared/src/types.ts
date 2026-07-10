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
  checkpointTimestamps?: number[];
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

export interface SegmentCheckpoint {
  timestamp: number;
  tab: string;
  batch: number;
}

export interface SegmentRef {
  key: string;
  bytes: number;
  t0: number;
  t1: number;
  batches: number;
  checkpoints?: SegmentCheckpoint[];
}

export interface SessionCounts {
  batches: number;
  events: number;
  clicks: number;
  errors: number;
  rages: number;
  navs: number;
}

export interface SessionInsights {
  maxScrollDepth: number;
  quickBacks: number;
  interactionTimeMs: number;
  /** 8-bucket activity histogram ("3a5f9c42-14"); null when the session had no events. */
  activityHist?: string | null;
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
  attrs: EdgeAttrs & { entryUrl?: string; urlCount?: number; pageCount?: number };
}

export type ProjectJurisdiction = "eu" | "fedramp";
export type ProjectQuotaState = "ok" | "soft" | "exceeded";

export interface MaskRule {
  selector: string;
  action: "mask" | "block";
}

export interface CaptureToggles {
  heatmaps: boolean;
  console: boolean;
  network: boolean;
  canvas: boolean;
}

export interface ProjectConfig {
  projectId: string;
  orgId: string;
  shard: number;
  active: boolean;
  sampleRate: number;
  allowedOrigins: string[];
  maskPolicyVersion: number;
  maskRules?: MaskRule[];
  capture?: CaptureToggles;
  quotaState: ProjectQuotaState;
  retentionDays: number;
  jurisdiction?: ProjectJurisdiction;
  version?: number;
}

export interface StoredProjectConfig extends ProjectConfig {
  maskRules: MaskRule[];
  capture: CaptureToggles;
  version: number;
}

/** Public capture settings returned to the browser recorder before capture starts. */
export interface RecorderProjectConfig {
  sampleRate: number;
  maskPolicyVersion: number;
  maskRules: MaskRule[];
  capture: CaptureToggles;
  version: number;
}

export interface ProjectConfigUpdate {
  expectedVersion: number;
  sampleRate: number;
  retentionDays: number;
  allowedOrigins: string[];
  maskPolicyVersion: number;
  maskRules: MaskRule[];
  capture: CaptureToggles;
}

export interface ProjectKeyAudit {
  key_hash: string;
  active: boolean;
  created_at: number;
}

export interface ProjectKeysResponse {
  keys: ProjectKeyAudit[];
}

export interface LiveTicketResponse {
  ticket: string;
  expiresAt: number;
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
  analyticsVersion?: number;
  insights?: SessionInsights;
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
  checkpoint?: boolean;
}
