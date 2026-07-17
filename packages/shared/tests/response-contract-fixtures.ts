import type {
  AccountResponse,
  CreatedProjectKeyResponse,
  ListSessionHeadsResponse,
  ListSessionsResponse,
  ProjectKeysResponse,
  ProjectStatsResponse,
  SessionFilter,
  SessionHead,
  SessionListItem,
} from "../src/index.ts";

export const validProjectKey = {
  id: "key_contract",
  name: "Production website",
  keyHashPrefix: "0123456789ab",
  active: true,
  createdAt: 1_000,
  createdBy: "user_contract",
  revokedAt: null,
  revokedBy: null,
} as const;

export const validProjectKeysResponse = {
  keys: [validProjectKey],
} satisfies ProjectKeysResponse;

export const validCreatedProjectKeyResponse = {
  key: validProjectKey,
  secret: "or_live_contract_secret",
} satisfies CreatedProjectKeyResponse;

export const validAccountResponse = {
  user: {
    id: "user_contract",
    name: "Sunny",
    email: "sunny@example.com",
    emailVerified: true,
    image: null,
    role: "user",
  },
  workspaces: [
    {
      id: "workspace_contract",
      name: "Sunny's workspace",
      slug: "sunny-workspace",
      role: "owner",
      projects: [{ id: "project_contract", name: "Orange Replay", role: "owner" }],
    },
  ],
  activeWorkspaceId: "workspace_contract",
  isAdmin: false,
} satisfies AccountResponse;

export const validSessionListItem = {
  session_id: "session_contract",
  project_id: "project_contract",
  org_id: "workspace_contract",
  started_at: 1_000,
  ended_at: 2_500,
  duration_ms: 1_500,
  country: "US",
  region: "CA",
  city: "San Francisco",
  device: "desktop",
  browser: "Chrome",
  os: "macOS",
  entry_url: "/checkout",
  url_count: 2,
  page_count: 2,
  analytics_version: 2,
  max_scroll_depth: 75,
  quick_backs: 1,
  interaction_time_ms: 800,
  activity_hist: "00000001-0f",
  clicks: 4,
  errors: 1,
  rages: 1,
  navs: 1,
  bytes: 1_024,
  segment_count: 1,
  flags: 0,
  manifest_key: "p/project_contract/session_contract/manifest.json",
  expires_at: 86_400_000,
  has_checkpoint: true,
} satisfies SessionListItem;

export const validListSessionsResponse = {
  sessions: [validSessionListItem],
  nextBefore: null,
  warehouseVersion: 42,
  analyticsState: "fresh",
} satisfies ListSessionsResponse;

export const validExactSessionHead = {
  ...validSessionListItem,
  activity: "complete",
  details_state: "exact",
  replay_source: "recorded",
} satisfies SessionHead;

export const validProvisionalSessionHead = {
  ...validSessionListItem,
  session_id: "session_live_contract",
  ended_at: 1_000,
  duration_ms: 0,
  has_checkpoint: null,
  activity: "live",
  details_state: "provisional",
  replay_source: "live",
} satisfies SessionHead;

export const validListSessionHeadsResponse = {
  sessions: [validExactSessionHead, validProvisionalSessionHead],
} satisfies ListSessionHeadsResponse;

const baseFilter = { country: "US", warehouse_version: 42 } satisfies SessionFilter;
const pageFilter = { ...baseFilter, has_page_coverage: true } satisfies SessionFilter;
const insightFilter = { ...baseFilter, has_insights: true } satisfies SessionFilter;
const rageFilter = { ...baseFilter, has_rage: true } satisfies SessionFilter;
const quickBackFilter = { ...baseFilter, has_quick_back: true } satisfies SessionFilter;
const regionFilter = { ...baseFilter, region: "CA" } satisfies SessionFilter;
const entryPageFilter = { ...baseFilter, entry_url: "/checkout" } satisfies SessionFilter;
const errorFilter = { ...baseFilter, error_detail: "Checkout failed" } satisfies SessionFilter;

export const validProjectStatsResponse = {
  filter: baseFilter,
  sessions: { value: 2, filter: baseFilter },
  duration: {
    average: { value: 1_500, filter: baseFilter },
    p50: { value: 1_500, filter: baseFilter },
  },
  clicks: { value: 8, filter: baseFilter },
  pagesPerSession: {
    value: 2,
    filter: pageFilter,
    includedSessions: { value: 2, filter: pageFilter },
    totalSessions: { value: 2, filter: baseFilter },
  },
  insights: {
    ragePercent: { value: 0.5, filter: rageFilter },
    quickBackPercent: { value: 0.5, filter: quickBackFilter },
    averageInteractionTimeMs: { value: 800, filter: insightFilter },
    averageMaxScrollDepth: { value: 75, filter: insightFilter },
    includedSessions: { value: 2, filter: insightFilter },
    totalSessions: { value: 2, filter: baseFilter },
  },
  breakdowns: {
    country: [
      {
        label: "US",
        filter: baseFilter,
        count: { value: 2, filter: baseFilter },
        share: { value: 1, filter: baseFilter },
      },
    ],
    region: [
      {
        label: "CA",
        filter: regionFilter,
        count: { value: 2, filter: regionFilter },
        share: { value: 1, filter: regionFilter },
      },
    ],
    device: [],
    browser: [],
    os: [],
    entryPage: [
      {
        label: "/checkout",
        filter: entryPageFilter,
        count: { value: 2, filter: entryPageFilter },
        share: { value: 1, filter: entryPageFilter },
      },
    ],
  },
  errors: [
    {
      detail: "Checkout failed",
      filter: errorFilter,
      count: { value: 2, filter: errorFilter },
      affectedSessions: { value: 1, filter: errorFilter },
    },
  ],
  liveNow: { value: 1, filter: baseFilter },
  warehouseVersion: 42,
  analyticsState: "fresh",
} satisfies ProjectStatsResponse;
