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
  /** Replay tab identity. Older recordings may not have it. Never display as a label. */
  tab?: string;
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
  appliedDomMasking?: AppliedDomMasking;
}

/** Capture settings reported by the SDK, not proof that every payload is private. */
export interface AppliedDomMasking {
  v: 1;
  defaultsVersion: 1;
  inputs: "all";
  text: "selected";
  localRules: { text: boolean; block: boolean; ignore: boolean };
  remoteConfigVersion?: number;
  remoteMaskPolicyVersion?: number;
  rulesFingerprint?: string;
  canvas: boolean;
}

export interface DomMasking {
  v: 1;
  policies: { policy: AppliedDomMasking; batches: number }[];
  unknownBatches: number;
  overflowBatches: number;
  canvasCaptured?: boolean;
}

export interface DomMaskingSummary {
  coverage: "complete" | "partial" | "unknown";
  policyCount: number;
  canvas: boolean;
  inputs?: "all";
  text?: "selected";
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
  domMasking?: DomMasking;
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
  /** Websites visited during this Workspace journey, in first-seen order. */
  websiteIds?: string[];
  startedAt: number;
  endedAt: number;
  durationMs: number;
  segments: SegmentRef[];
  timeline: IndexEvent[];
  counts: SessionCounts;
  bytes: number;
  flags: number;
  domMasking?: DomMasking;
  domMaskingSummary?: DomMaskingSummary;
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
  /** Whether finalized replays may privately cache public page assets for visual fidelity. */
  replayAssets?: boolean;
  quotaState: ProjectQuotaState;
  retentionDays: number;
  jurisdiction?: ProjectJurisdiction;
  version?: number;
  /** Stable parent domain used only to continue one Workspace journey across its subdomains. */
  sessionCookieDomain?: string;
  /** Website that owns the recorder key used for this request. Legacy/manual keys omit it. */
  websiteId?: string;
  /** True until this Website sends its first accepted batch. */
  websitePending?: boolean;
}

export interface StoredProjectConfig extends ProjectConfig {
  maskRules: MaskRule[];
  capture: CaptureToggles;
  replayAssets: boolean;
  version: number;
}

/** Public capture settings returned to the browser recorder before capture starts. */
export interface RecorderProjectConfig {
  /** The ingest reader accepts applied DOM masking metadata. */
  domMaskingVersion?: 1;
  /** Content-hashed recorder bundle served by the ingest origin. */
  recorderUrl?: string;
  /** Stable public project id used to build dashboard session links. */
  projectId?: string;
  /** Stable Workspace scope. Different Website keys in one Workspace receive the same value. */
  sessionScope?: string;
  /** Explicit cookie domain for related Websites, such as example.com and app.example.com. */
  sessionCookieDomain?: string;
  /** Website that owns this recorder key. */
  websiteId?: string;
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
  replayAssets?: boolean;
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
  analyticsStatus?: "current" | "pending" | "stale" | "unknown";
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
  expectedRevision: number;
  sessionIds: string[];
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
  /** Recorded event-time span; absent from messages queued by older DOs. */
  durationMs?: number;
  /** True when any segment carries a full-snapshot checkpoint. */
  hasCheckpoint?: boolean;
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

/** Queue work created after a session has been indexed successfully. */
export interface ReplayAssetCaptureMessage {
  type: "session.replay-assets";
  sessionId: string;
  projectId: string;
  shard: number;
  requestId: string;
  manifestKey: string;
  endedAt: number;
  retentionDays: number;
}

export type WorkerQueueMessage = FinalizeMessage | ReplayAssetCaptureMessage;

export interface IngestAck {
  ok: boolean;
  live: boolean;
  flushMs: number;
  drop?: boolean;
  closed?: boolean;
  checkpoint?: boolean;
}
