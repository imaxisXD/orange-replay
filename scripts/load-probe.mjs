// Scaled-down local load probe (T4.5 final judgment).
// Drives synthetic wire-format sessions at a local wrangler dev worker and
// reports append latency percentiles plus end-to-end finalize/index counts.
// Usage: node scripts/load-probe.mjs [--worker http://127.0.0.1:8787]
//        [--sessions 50] [--batches 10] [--concurrency 10]
// Requires DEV_TEST_ROUTES=1 on the worker (seeding) and a short closeMs via
// TEST_TIMINGS so sessions finalize quickly after the run.
import { gzipSync } from "node:zlib";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((value, index, list) =>
      value.startsWith("--") ? [value.slice(2), list[index + 1]] : null,
    )
    .filter(Boolean),
);
const WORKER = args.worker ?? "http://127.0.0.1:8787";
const SESSIONS = Number(args.sessions ?? 50);
const BATCHES = Number(args.batches ?? 10);
const CONCURRENCY = Number(args.concurrency ?? 10);
const KEY = "or_load_probe_key";
const PROJECT = "load-probe";

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

console.log(`load-probe: ${SESSIONS} sessions x ${BATCHES} batches, concurrency ${CONCURRENCY}`);
const latencies = [];
let failed = 0;
const t0 = Date.now();
const sessionIds = Array.from({ length: SESSIONS }, (_, i) => `probe-${t0}-${i}`);

let cursor = 0;
async function lane() {
  while (cursor < sessionIds.length) {
    const mine = sessionIds[cursor++];
    const tab = `${mine}-tab`;
    for (let seq = 0; seq < BATCHES; seq++) {
      try {
        latencies.push(await ingest(mine, tab, seq, t0 + seq * 1000));
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
const total = SESSIONS * BATCHES;
console.log(
  `appends: ${latencies.length}/${total} ok, ${failed} failed, wall ${(wallMs / 1000).toFixed(1)}s (${(latencies.length / (wallMs / 1000)).toFixed(0)} req/s)`,
);
console.log(
  `latency ms  p50 ${pct(latencies, 50)}  p95 ${pct(latencies, 95)}  p99 ${pct(latencies, 99)}  max ${latencies.at(-1)?.toFixed(1)}`,
);

// Wait for finalize (closeMs must be short via TEST_TIMINGS), then count indexed sessions.
const waitMs = Number(args.finalizeWait ?? 20000);
console.log(`waiting ${waitMs / 1000}s for finalize + consumer indexing...`);
await new Promise((r) => setTimeout(r, waitMs));

const token = args.token ?? "dev-local-token";
let indexed = 0;
let before;
for (;;) {
  const url = new URL(`${WORKER}/api/v1/projects/${PROJECT}/sessions`);
  url.searchParams.set("limit", "100");
  if (before) url.searchParams.set("before", String(before));
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  if (res.status !== 200) throw new Error(`list failed ${res.status}`);
  const data = await res.json();
  const mine = data.sessions.filter((s) => s.session_id.startsWith(`probe-${t0}-`));
  indexed += mine.length;
  if (!data.nextBefore || data.sessions.length === 0) break;
  before = data.nextBefore;
}
console.log(`indexed sessions: ${indexed}/${SESSIONS}`);
if (indexed < SESSIONS) {
  console.log(
    "NOTE: rerun the count after a few more seconds if consumer lag; check worker log for DLQ/errors otherwise.",
  );
  process.exitCode = 2;
} else {
  console.log("PROBE PASS");
}
