import { HDR_REQUEST_ID } from "@orange-replay/shared";
import { isDevTestMode, type Env } from "../env.ts";
import {
  presenceShardIndex,
  presenceShardName,
  presenceShardNames,
  type PresenceHeadQuery,
  type PresenceSessionHead,
  type PresenceSession,
} from "./presence-logic.ts";

type PresenceWritePath = "/ping" | "/mark-finalizing" | "/remove";
type PresenceReadPath = "/list" | "/heads" | "/install-status" | "/debug";
const MAX_HEAD_RESPONSE_ROWS = 200;

interface PresenceWriteBody {
  projectId: string;
  sessionId: string;
  [key: string]: unknown;
}

interface PresenceListBody {
  sessions?: PresenceSession[];
}

interface PresenceHeadsBody {
  sessions?: PresenceSessionHead[];
}

interface PresenceHeadBody {
  session?: PresenceSessionHead | null;
}

interface PresenceInstallBody {
  firstEventAt?: number | null;
}

interface PresenceDebugBody extends PresenceInstallBody {
  rows?: number;
}

export async function sendPresenceSessionRequest(
  env: Env,
  path: PresenceWritePath,
  requestId: string,
  body: PresenceWriteBody,
): Promise<void> {
  const shard = presenceShardIndex(body.sessionId);
  const stub = env.PRESENCE.getByName(presenceShardName(body.projectId, shard));
  const response = await stub.fetch(
    `https://presence.internal${path}`,
    requestInit(requestId, body),
  );
  if (!response.ok) {
    throw new Error(`presence registry returned ${response.status}`);
  }
}

export async function listProjectPresence(
  env: Env,
  projectId: string,
  requestId: string,
  now: number,
): Promise<{ sessions: PresenceSession[] } | null> {
  const bodies = await readPresenceShards<PresenceListBody>(env, projectId, "/list", requestId, {
    projectId,
    now,
  });
  if (bodies === null) return null;
  const bySession = new Map<string, PresenceSession>();

  for (const body of bodies) {
    for (const session of body.sessions ?? []) {
      const current = bySession.get(session.session_id);
      if (current === undefined || session.last_seen > current.last_seen) {
        bySession.set(session.session_id, session);
      }
    }
  }

  return {
    sessions: [...bySession.values()].toSorted(
      (left, right) =>
        right.last_seen - left.last_seen || left.session_id.localeCompare(right.session_id),
    ),
  };
}

export async function listProjectSessionHeads(
  env: Env,
  projectId: string,
  requestId: string,
  query: PresenceHeadQuery,
): Promise<{ sessions: PresenceSessionHead[] } | null> {
  const { trackedSessionIds = [], ...sharedQuery } = query;
  const bodies = await readPresenceShards<PresenceHeadsBody>(
    env,
    projectId,
    "/heads",
    requestId,
    (shard) => {
      const shardTrackedSessionIds = trackedSessionIds.filter(
        (sessionId) => presenceShardIndex(sessionId) === shard,
      );
      return {
        projectId,
        ...sharedQuery,
        ...(shardTrackedSessionIds.length === 0
          ? {}
          : { trackedSessionIds: shardTrackedSessionIds }),
      };
    },
    true,
  );
  if (bodies === null) return null;
  const bySession = new Map<string, PresenceSessionHead>();

  for (const body of bodies) {
    for (const session of body.sessions ?? []) {
      const current = bySession.get(session.session_id);
      if (current === undefined || session.last_seen > current.last_seen) {
        bySession.set(session.session_id, session);
      }
    }
  }

  const sorted = [...bySession.values()].toSorted(presenceHeadComparator(query));
  const keptSessionIds = new Set(sorted.slice(0, query.limit).map((session) => session.session_id));
  const trackedSessionIdSet = new Set(query.trackedSessionIds ?? []);
  for (const session of sorted) {
    if (trackedSessionIdSet.has(session.session_id)) keptSessionIds.add(session.session_id);
  }
  return {
    sessions: sorted
      .filter((session) => keptSessionIds.has(session.session_id))
      .slice(0, MAX_HEAD_RESPONSE_ROWS),
  };
}

export async function readProjectSessionHead(
  env: Env,
  projectId: string,
  sessionId: string,
  requestId: string,
  now = Date.now(),
): Promise<PresenceSessionHead | null> {
  const shard = presenceShardIndex(sessionId);
  const response = await env.PRESENCE.getByName(presenceShardName(projectId, shard)).fetch(
    "https://presence.internal/head",
    requestInit(requestId, { projectId, sessionId, now }),
  );
  if (!response.ok) {
    throw new Error(`presence registry returned ${response.status}`);
  }
  const body = (await response.json()) as PresenceHeadBody;
  return body.session ?? null;
}

export async function readProjectInstallStatus(
  env: Env,
  projectId: string,
  requestId: string,
): Promise<{ firstEventAt: number | null } | null> {
  const bodies = await readPresenceShards<PresenceInstallBody>(
    env,
    projectId,
    "/install-status",
    requestId,
    { projectId },
  );
  if (bodies === null) return null;
  const values = bodies
    .map((body) => body.firstEventAt)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return { firstEventAt: values.length === 0 ? null : Math.min(...values) };
}

export async function readProjectPresenceDebug(
  env: Env,
  projectId: string,
  requestId: string,
): Promise<{ rows: number; firstEventAt: number | null } | null> {
  const bodies = await readPresenceShards<PresenceDebugBody>(env, projectId, "/debug", requestId, {
    projectId,
  });
  if (bodies === null) return null;
  const firstEventValues = bodies
    .map((body) => body.firstEventAt)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return {
    rows: bodies.reduce(
      (total, body) => total + (typeof body.rows === "number" ? body.rows : 0),
      0,
    ),
    firstEventAt: firstEventValues.length === 0 ? null : Math.min(...firstEventValues),
  };
}

async function readPresenceShards<Body>(
  env: Env,
  projectId: string,
  path: PresenceReadPath,
  requestId: string,
  body: Record<string, unknown> | ((shard: number) => Record<string, unknown>),
  requireEveryShard = false,
): Promise<Body[] | null> {
  const results = await Promise.allSettled(
    presenceShardNames(projectId).map(async (name, shard) => {
      if (path === "/heads" && shouldFailPresenceHeadShardForTest(env, shard)) {
        throw new Error("forced presence head shard failure");
      }
      const response = await env.PRESENCE.getByName(name).fetch(
        `https://presence.internal${path}`,
        requestInit(requestId, typeof body === "function" ? body(shard) : body),
      );
      if (!response.ok) {
        throw new Error(`presence registry returned ${response.status}`);
      }
      return (await response.json()) as Body;
    }),
  );
  const bodies = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  if (requireEveryShard && bodies.length !== results.length) return null;
  return bodies.length === 0 ? null : bodies;
}

export function shouldFailPresenceHeadShardForTest(
  env: Pick<Env, "DEV_TEST_ROUTES" | "WORKER_ENV" | "TEST_FAIL_PRESENCE_HEAD_SHARD">,
  shard: number,
): boolean {
  return isDevTestMode(env) && env.TEST_FAIL_PRESENCE_HEAD_SHARD === String(shard);
}

function requestInit(requestId: string, body: unknown): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [HDR_REQUEST_ID]: requestId,
    },
    body: JSON.stringify(body),
  };
}

function presenceHeadComparator(
  query: Pick<PresenceHeadQuery, "sort">,
): (left: PresenceSessionHead, right: PresenceSessionHead) => number {
  return (left, right) => {
    const leftValue =
      query.sort === "duration" ? Math.max(0, left.last_seen - left.started_at) : left.started_at;
    const rightValue =
      query.sort === "duration"
        ? Math.max(0, right.last_seen - right.started_at)
        : right.started_at;
    return rightValue - leftValue || right.session_id.localeCompare(left.session_id);
  };
}
