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

export interface LiveSessionSnapshot {
  startedAt: number;
  endedAt: number;
  durationMs: number;
  timeline: IndexEvent[];
  counts: SessionCounts;
}

export interface LiveHelloMessage {
  type: "hello";
  sessionId: string;
  startedAt: number;
  segments: SegmentRef[];
  pendingBatches: number;
  snapshot: LiveSessionSnapshot;
}

export interface LiveFinalizedMessage {
  type: "finalized";
  manifest: SessionManifest;
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
  id: string;
  name: string;
  keyHashPrefix: string;
  active: boolean;
  createdAt: number;
  createdBy: string | null;
  revokedAt: number | null;
  revokedBy: string | null;
}

export interface ProjectKeysResponse {
  keys: ProjectKeyAudit[];
}

export interface PublicPageBreakdownItem {
  label: string;
  count: number;
  share: number;
}

export interface PublicPageRecording {
  replayId: string;
  position: number;
  startedAt: number;
  durationMs: number;
  entryPath: string;
  country: string | null;
  device: string | null;
  browser: string | null;
  operatingSystem: string | null;
  clicks: number;
  errors: number;
  rages: number;
  pages: number | null;
}

export interface PublicPageSelectedRecording extends PublicPageRecording {
  sessionId: string;
}

export interface PublicPageAnalytics {
  sessions: number;
  averageDurationMs: number;
  p50DurationMs: number;
  clicks: number;
  pagesPerSession: number | null;
  pagesCoveredSessions: number;
  ragePercent: number | null;
  quickBackPercent: number | null;
  countries: PublicPageBreakdownItem[];
  devices: PublicPageBreakdownItem[];
  browsers: PublicPageBreakdownItem[];
  operatingSystems: PublicPageBreakdownItem[];
  entryPages: PublicPageBreakdownItem[];
}

/** Safe, anonymous data returned by the public page API. */
export interface PublicPageData {
  version: 1;
  publicId: string;
  publicUrl: string;
  projectName: string;
  generatedAt: number;
  analytics: PublicPageAnalytics;
  recordings: PublicPageRecording[];
}

/** Authenticated settings response. This is never returned by a public route. */
export interface PublicPageSettings {
  enabled: boolean;
  publicId: string | null;
  publicUrl: string | null;
  revision: number;
  recordings: PublicPageSelectedRecording[];
}

export interface PublicPageSettingsUpdate {
  enabled: boolean;
  sessionIds: string[];
}

/** Returned only at key creation. The secret is never persisted or returned again. */
export interface CreatedProjectKeyResponse {
  key: ProjectKeyAudit;
  secret: string;
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
  /** Immutable scrubbed events; never contains replay payload bytes. */
  analyticsSidecarKey?: string;
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
