import { HDR_REQUEST_ID } from "@orange-replay/shared";
import type { Env } from "../env.ts";
import {
  presenceShardIndex,
  presenceShardName,
  presenceShardNames,
  type PresenceSession,
} from "./presence-logic.ts";

type PresenceWritePath = "/ping" | "/remove";
type PresenceReadPath = "/list" | "/install-status" | "/debug";

interface PresenceWriteBody {
  projectId: string;
  sessionId: string;
  [key: string]: unknown;
}

interface PresenceListBody {
  sessions?: PresenceSession[];
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
  body: Record<string, unknown>,
): Promise<Body[] | null> {
  const results = await Promise.allSettled(
    presenceShardNames(projectId).map(async (name) => {
      const response = await env.PRESENCE.getByName(name).fetch(
        `https://presence.internal${path}`,
        requestInit(requestId, body),
      );
      if (!response.ok) {
        throw new Error(`presence registry returned ${response.status}`);
      }
      return (await response.json()) as Body;
    }),
  );
  const bodies = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  return bodies.length === 0 ? null : bodies;
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
