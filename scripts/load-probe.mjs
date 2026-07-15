// Scaled-down local load probe (T4.5 final judgment).
// Drives synthetic wire-format sessions at a local wrangler dev worker and
// reports append latency percentiles plus end-to-end finalize/index counts.
// Usage: node scripts/load-probe.mjs [--worker http://127.0.0.1:8787]
//        [--sessions 50] [--batches 10] [--concurrency 10]
// Requires DEV_TEST_ROUTES=1 plus Better Auth test secrets on the worker, and
// a short closeMs via TEST_TIMINGS so sessions finalize quickly after the run.
import { gzipSync } from "node:zlib";

const args = readArgs(process.argv.slice(2));
const WORKER = readWorkerUrl(args.worker ?? "http://127.0.0.1:8787");
const SESSIONS = readPositiveInteger(args.sessions, "--sessions", 50, 10_000);
const BATCHES = readPositiveInteger(args.batches, "--batches", 10, 10_000);
const CONCURRENCY = readPositiveInteger(args.concurrency, "--concurrency", 10, 500);
const FINALIZE_WAIT_MS = readPositiveInteger(args.finalizeWait, "--finalizeWait", 20_000, 600_000);
const EXPECTED_APPENDS = SESSIONS * BATCHES;
if (!Number.isSafeInteger(EXPECTED_APPENDS) || EXPECTED_APPENDS > 1_000_000) {
  throw new Error("--sessions multiplied by --batches must be at most 1000000.");
}
const KEY = "or_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PROJECT = "load-probe";

function readArgs(values) {
  const allowed = new Set(["worker", "sessions", "batches", "concurrency", "finalizeWait"]);
  const parsed = {};
  for (let index = 0; index < values.length; index += 2) {
    const option = values[index];
    const value = values[index + 1];
    if (typeof option !== "string" || !option.startsWith("--")) {
      throw new Error(`Unexpected load probe argument: ${String(option)}`);
    }
    const name = option.slice(2);
    if (!allowed.has(name)) throw new Error(`Unknown load probe option: ${option}`);
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${option} needs a value.`);
    }
    if (Object.hasOwn(parsed, name)) throw new Error(`${option} was provided more than once.`);
    parsed[name] = value;
  }
  return parsed;
}

function readPositiveInteger(value, option, fallback, maximum) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) {
    throw new Error(`${option} must be a whole number between 1 and ${maximum}.`);
  }
  return number;
}

function readWorkerUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--worker must be a valid HTTP or HTTPS origin.");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("--worker must be an HTTP or HTTPS origin without credentials or a path.");
  }
  return url.origin;
}

function encodeIngestBody(index, payload) {
  const head = new TextEncoder().encode(JSON.stringify(index));
  const body = new Uint8Array(head.length + 1 + payload.length);
  body.set(head, 0);
  body[head.length] = 0;
  body.set(payload, head.length + 1);
  return body;
}

function fakeEvents(sizeTarget) {
  const events = [];
  let size = 0;
  while (size < sizeTarget) {
    const e = {
      type: 3,
      data: { source: 1, positions: [{ x: size % 1400, y: size % 800, id: 1, timeOffset: 0 }] },
      timestamp: Date.now(),
    };
    events.push(e);
    size += 120;
  }
  return events;
}

async function ingest(session, tab, seq, t0) {
  const payload = gzipSync(Buffer.from(JSON.stringify(fakeEvents(2048))));
  const index = {
    v: 1,
    s: session,
    tab,
    seq,
    t0,
    t1: t0 + 900,
    e: seq % 3 === 0 ? [{ t: t0 + 100, k: "click", d: "button#probe" }] : [],
    u: "/load-probe",
  };
  const body = encodeIngestBody(index, payload);
  const started = performance.now();
  const res = await fetch(`${WORKER}/v1/ingest`, {
    method: "POST",
    headers: {
      "x-or-key": KEY,
      "x-or-session": session,
      "x-or-tab": tab,
      "x-or-seq": String(seq),
      "x-or-flags": "0",
      "content-type": "application/octet-stream",
    },
    body,
  });
  const ms = performance.now() - started;
  if (res.status !== 200) throw new Error(`ingest ${res.status}: ${await res.text()}`);
  return ms;
}

function pct(sorted, p) {
  if (sorted.length === 0) return "n/a";
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))].toFixed(1);
}

const seed = await fetch(`${WORKER}/__test/ingest/seed`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    key: KEY,
    kv: true,
    config: {
      projectId: PROJECT,
      orgId: "load-org",
      shard: 0,
      active: true,
      sampleRate: 1,
      allowedOrigins: ["*"],
      maskPolicyVersion: 1,
      quotaState: "ok",
      retentionDays: 30,
    },
  }),
});
if (seed.status !== 200) throw new Error(`seed failed ${seed.status}: ${await seed.text()}`);

const authSeed = await fetch(`${WORKER}/__test/api/hosted/session`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ projectIds: [PROJECT] }),
});
if (authSeed.status !== 200) {
  throw new Error(`Better Auth seed failed ${authSeed.status}: ${await authSeed.text()}`);
}
const authSeedBody = await authSeed.json();
if (
  typeof authSeedBody !== "object" ||
  authSeedBody === null ||
  typeof authSeedBody.cookie !== "string" ||
  authSeedBody.cookie.length === 0 ||
  /[\r\n]/.test(authSeedBody.cookie)
) {
  throw new Error("Better Auth seed returned an invalid session cookie.");
}
const sessionCookie = authSeedBody.cookie;

console.log(`load-probe: ${SESSIONS} sessions x ${BATCHES} batches, concurrency ${CONCURRENCY}`);
const latencies = [];
let attempted = 0;
let succeeded = 0;
let failed = 0;
const t0 = Date.now();
const sessionIds = Array.from({ length: SESSIONS }, (_, i) => `probe-${t0}-${i}`);

let cursor = 0;
async function lane() {
  while (cursor < sessionIds.length) {
    const mine = sessionIds[cursor++];
    const tab = `${mine}-tab`;
    for (let seq = 0; seq < BATCHES; seq++) {
      attempted += 1;
      try {
        latencies.push(await ingest(mine, tab, seq, t0 + seq * 1000));
        succeeded += 1;
      } catch (error) {
        failed += 1;
        if (failed <= 3) console.error(String(error).slice(0, 160));
      }
    }
  }
}
const wall0 = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, lane));
const wallMs = performance.now() - wall0;

latencies.sort((a, b) => a - b);
console.log(
  `appends: ${succeeded}/${EXPECTED_APPENDS} ok, ${failed} failed, wall ${(wallMs / 1000).toFixed(1)}s (${(succeeded / (wallMs / 1000)).toFixed(0)} req/s)`,
);
console.log(
  `latency ms  p50 ${pct(latencies, 50)}  p95 ${pct(latencies, 95)}  p99 ${pct(latencies, 99)}  max ${latencies.at(-1)?.toFixed(1)}`,
);

// Wait for finalize (closeMs must be short via TEST_TIMINGS), then count indexed sessions.
console.log(`waiting ${FINALIZE_WAIT_MS / 1000}s for finalize + consumer indexing...`);
await new Promise((resolve) => setTimeout(resolve, FINALIZE_WAIT_MS));

const indexedSessionIds = new Set();
const usedCursors = new Set();
let before;
for (;;) {
  const url = new URL(`${WORKER}/api/v1/projects/${PROJECT}/sessions`);
  url.searchParams.set("limit", "100");
  if (before) url.searchParams.set("before", String(before));
  const res = await fetch(url, { headers: { cookie: sessionCookie } });
  if (res.status !== 200) throw new Error(`list failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (typeof data !== "object" || data === null || !Array.isArray(data.sessions)) {
    throw new Error("Session list returned an invalid response.");
  }
  for (const session of data.sessions) {
    if (
      typeof session === "object" &&
      session !== null &&
      typeof session.session_id === "string" &&
      session.session_id.startsWith(`probe-${t0}-`)
    ) {
      indexedSessionIds.add(session.session_id);
    }
  }
  if (!data.nextBefore || data.sessions.length === 0) break;
  before = String(data.nextBefore);
  if (usedCursors.has(before)) throw new Error("Session list repeated its pagination cursor.");
  usedCursors.add(before);
}
const indexed = indexedSessionIds.size;
console.log(`indexed sessions: ${indexed}/${SESSIONS}`);
const workloadPassed =
  EXPECTED_APPENDS > 0 &&
  attempted === EXPECTED_APPENDS &&
  succeeded === EXPECTED_APPENDS &&
  latencies.length === EXPECTED_APPENDS &&
  failed === 0;
const everyExpectedSessionWasIndexed = sessionIds.every((sessionId) =>
  indexedSessionIds.has(sessionId),
);
if (!workloadPassed || indexed !== SESSIONS || !everyExpectedSessionWasIndexed) {
  console.log(
    "PROBE FAIL: every append must succeed and the indexed session set must match the workload.",
  );
  process.exitCode = 2;
} else {
  console.log("PROBE PASS");
}
