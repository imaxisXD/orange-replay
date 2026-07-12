import { readFile } from "node:fs/promises";
import { expect, test, type Page, type Request } from "@playwright/test";
import {
  decodeIngestBody,
  FLAG_UNCOMPRESSED,
  parseSegment,
  segmentBatch,
  type ProjectConfig,
  type SessionManifest,
} from "@orange-replay/shared";

const stateFile = new URL("../.playwright-state.json", import.meta.url);
const textSecret = "private alpha workspace";
const passwordSecret = "CorrectHorseOrange!42";
const decoder = new TextDecoder();

test("records a real browser session into the local worker", async ({ page }) => {
  const state = await readState();
  const sentBatches = collectBrowserBatches(page);
  const sdkConsoleMessages: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (text.includes("Signal Board")) {
      sdkConsoleMessages.push(text);
    }
  });

  await seedProject(state);

  await page.goto(state.demoUrl);
  await expect(page.getByRole("heading", { name: "Signal Board starter kit" })).toBeVisible();
  const sessionId = await readSessionId(page);

  await page.getByLabel("Workspace name").fill(textSecret);
  await page.getByLabel("Admin password").fill(passwordSecret);
  await page.getByRole("button", { name: "Add product row" }).click();
  await page.getByRole("button", { name: "Show stock panel" }).click();
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.mouse.wheel(0, 1_800);

  const pageError = page.waitForEvent("pageerror");
  await page.getByRole("button", { name: "Trigger TypeError" }).click();
  await expect(pageError).resolves.toHaveProperty("message", expect.stringContaining("run"));

  await page.getByRole("link", { name: "Open order details" }).click();
  await page.waitForURL(/\/page2\.html/);
  await expect(page.getByRole("heading", { name: "Order details" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm checklist" }).click();
  await page.waitForTimeout(1_500);
  // Quota 202-drop handling is covered by unit tests on both sides; an
  // instant flip cannot be asserted here because ingest reads config through
  // KV with cacheTtl 60 — the documented (and priced-in) propagation window.
  expect(sdkConsoleMessages).toEqual([]);

  expect(await readSessionId(page)).toBe(sessionId);
  await page.close();

  await waitForFinalize(state, sessionId);
  const manifest = await readManifestFromApi(state, sessionId);
  const indexed = await waitForIndexedSession(state, sessionId);

  expect(indexed.session?.["session_id"]).toBe(sessionId);
  expect(Number(indexed.session?.["clicks"])).toBeGreaterThan(0);
  expect(Number(indexed.session?.["errors"])).toBeGreaterThanOrEqual(1);

  const timeline = JSON.stringify(manifest.timeline);
  expect(manifest.timeline.some((event) => event.k === "click")).toBe(true);
  const errorEvent = manifest.timeline.find((event) => event.k === "error");
  expect(errorEvent?.d).toEqual(expect.stringContaining("run"));
  expect(errorEvent?.d ?? "").not.toContain("\n");
  expect(errorEvent?.d?.length ?? 0).toBeLessThanOrEqual(200);
  expect(timeline).not.toContain(textSecret);
  expect(timeline).not.toContain(passwordSecret);

  const replay = await downloadReplayPayloads(state, manifest);
  expect(replay.text).not.toContain(textSecret);
  expect(replay.text).not.toContain(passwordSecret);
  expect(replay.text).toContain("Signal Board starter kit");
  expect(replay.events.length).toBeGreaterThan(0);
  expect(replay.compressedBatchCount).toBeGreaterThan(0);

  const compressedBrowserBatch = sentBatches.find(
    (batch) => (batch.flags & FLAG_UNCOMPRESSED) === 0 && batch.body !== undefined,
  );
  expect(compressedBrowserBatch).toBeDefined();
  if (compressedBrowserBatch?.body !== undefined) {
    const decoded = decodeIngestBody(compressedBrowserBatch.body);
    await expect(gunzipToText(decoded.payload)).resolves.toContain("[");
  }
});

test("records through explicit inline transport when CSP blocks blob workers", async ({ page }) => {
  const state = await readState();
  const sentBatches = collectBrowserBatches(page);
  const disabledWarnings: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (text.includes("or:disabled")) {
      disabledWarnings.push(text);
    }
  });

  await seedProject(state);
  await page.goto(`${state.cspDemoUrl}?transport=inline`);
  await expect(page.getByRole("heading", { name: "Signal Board starter kit" })).toBeVisible();
  await page.getByRole("button", { name: "Add product row" }).click();
  await page.getByRole("button", { name: "Save settings" }).click();
  await poll(async () => (sentBatches.length > 0 ? true : null), 5_000);

  expect(disabledWarnings).toEqual([]);
  expect(sentBatches.length).toBeGreaterThan(0);
  await page.close();
});

test("fails safe when CSP blocks the default worker transport", async ({ page }) => {
  const state = await readState();
  const sentBatches = collectBrowserBatches(page);
  const disabledWarnings: string[] = [];
  page.on("console", (message) => {
    const text = message.text();
    if (text.includes("or:disabled")) disabledWarnings.push(text);
  });

  await seedProject(state);
  await page.goto(state.cspDemoUrl);
  await expect(page.getByRole("heading", { name: "Signal Board starter kit" })).toBeVisible();
  await page.getByRole("button", { name: "Add product row" }).click();
  await page.waitForTimeout(1_500);

  expect(disabledWarnings).toEqual([expect.stringContaining("recording stopped")]);
  expect(sentBatches).toHaveLength(0);
  await page.close();
});

test("sample rate zero sends no ingest requests", async ({ page }) => {
  const state = await readState();
  const sentBatches = collectBrowserBatches(page);

  await page.goto(`${state.demoUrl}?sampleRate=0`);
  await expect(page.getByRole("heading", { name: "Signal Board starter kit" })).toBeVisible();
  await page.getByRole("button", { name: "Add product row" }).click();
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.waitForTimeout(1_500);

  expect(sentBatches).toHaveLength(0);
});

test("duplicated tabs mint distinct tab ids and both send batches", async ({ browser }) => {
  const state = await readState();
  await seedProject(state);
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const now = String(Date.now());
    window.sessionStorage.setItem("or:s", "dupe-session-e2e");
    window.sessionStorage.setItem("or:t", "dupe-tab-e2e");
    window.sessionStorage.setItem("or:q", "0");
    window.sessionStorage.setItem("or:last", now);
    document.cookie = "or_s=dupe-session-e2e; Path=/; SameSite=Lax";
  });

  const first = await context.newPage();
  const second = await context.newPage();
  const firstBatches = collectBrowserBatches(first);
  const secondBatches = collectBrowserBatches(second);

  try {
    await Promise.all([first.goto(state.demoUrl), second.goto(state.demoUrl)]);
    await Promise.all([
      expect(first.getByRole("heading", { name: "Signal Board starter kit" })).toBeVisible(),
      expect(second.getByRole("heading", { name: "Signal Board starter kit" })).toBeVisible(),
    ]);
    await first.waitForTimeout(150);
    await first.getByRole("button", { name: "Add product row" }).click();
    await second.getByRole("button", { name: "Show stock panel" }).click();

    await poll(async () => {
      const tabs = new Set([...firstBatches, ...secondBatches].map((batch) => batch.tab));
      return firstBatches.length > 0 && secondBatches.length > 0 && tabs.size === 2
        ? tabs.size
        : null;
    }, 5_000);

    const tabs = new Set([...firstBatches, ...secondBatches].map((batch) => batch.tab));
    expect(tabs.size).toBe(2);
  } finally {
    await context.close();
  }
});

interface ServerState {
  workerUrl: string;
  demoUrl: string;
  cspDemoUrl: string;
  apiToken: string;
  ingestKey: string;
  projectId: string;
  orgId: string;
  timings: {
    closeMs: number;
  };
}

interface BrowserBatch {
  flags: number;
  session?: string;
  tab?: string;
  body?: Uint8Array;
}

interface ConsumerSessionBody {
  session: Record<string, unknown> | null;
  events: Record<string, unknown>[];
  usage: Record<string, unknown>[];
}

interface DebugBody {
  hasState: boolean;
  finalized: boolean;
}

async function readState(): Promise<ServerState> {
  return JSON.parse(await readFile(stateFile, "utf8")) as ServerState;
}

async function seedProject(
  state: ServerState,
  overrides: Partial<Pick<ProjectConfig, "quotaState" | "sampleRate">> = {},
): Promise<void> {
  const config: ProjectConfig = {
    projectId: state.projectId,
    orgId: state.orgId,
    shard: 0,
    active: true,
    sampleRate: overrides.sampleRate ?? 1,
    allowedOrigins: ["*"],
    maskPolicyVersion: 1,
    quotaState: overrides.quotaState ?? "ok",
    retentionDays: 30,
  };

  const response = await fetch(`${state.workerUrl}/__test/ingest/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      key: state.ingestKey,
      kv: true,
      config,
    }),
  });

  expect(response.status).toBe(200);
}

function collectBrowserBatches(page: Page): BrowserBatch[] {
  const batches: BrowserBatch[] = [];

  page.on("request", (request: Request) => {
    const url = new URL(request.url());
    if (request.method() !== "POST" || url.pathname !== "/v1/ingest") {
      return;
    }

    const body = request.postDataBuffer();
    batches.push({
      flags: Number(request.headers()["x-or-flags"] ?? -1),
      session: request.headers()["x-or-session"],
      tab: request.headers()["x-or-tab"],
      body: body === null ? undefined : new Uint8Array(body),
    });
  });

  return batches;
}

async function readSessionId(page: Page): Promise<string> {
  const value = await page.evaluate(() => window.sessionStorage.getItem("or:s"));
  expect(value).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
  return value ?? "";
}

async function waitForFinalize(state: ServerState, sessionId: string): Promise<void> {
  await poll(async () => {
    const response = await fetch(
      `${state.workerUrl}/__test/do/debug?projectId=${encodeURIComponent(
        state.projectId,
      )}&sessionId=${encodeURIComponent(sessionId)}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as DebugBody;
    return body.hasState === false && body.finalized === true ? body : null;
  }, state.timings.closeMs + 15_000);
}

async function readManifestFromApi(
  state: ServerState,
  sessionId: string,
): Promise<SessionManifest> {
  return poll(async () => {
    const response = await fetch(
      `${state.workerUrl}/api/v1/projects/${state.projectId}/sessions/${sessionId}/manifest`,
      { headers: authHeaders(state) },
    );
    if (response.status === 404) {
      return null;
    }
    expect(response.status).toBe(200);
    return (await response.json()) as SessionManifest;
  }, 20_000);
}

async function waitForIndexedSession(
  state: ServerState,
  sessionId: string,
): Promise<ConsumerSessionBody> {
  return poll(async () => {
    const response = await fetch(
      `${state.workerUrl}/__test/consumer/session?id=${encodeURIComponent(sessionId)}`,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as ConsumerSessionBody;
    return body.session === null ? null : body;
  }, 20_000);
}

async function downloadReplayPayloads(
  state: ServerState,
  manifest: SessionManifest,
): Promise<{ events: unknown[]; text: string; compressedBatchCount: number }> {
  const events: unknown[] = [];
  const texts: string[] = [];
  let compressedBatchCount = 0;

  for (const segment of manifest.segments) {
    const name = lastPathPart(segment.key);
    const response = await fetch(
      `${state.workerUrl}/api/v1/projects/${state.projectId}/sessions/${manifest.sessionId}/segments/${name}`,
      { headers: authHeaders(state) },
    );
    expect(response.status).toBe(200);

    const parsed = parseSegment(new Uint8Array(await response.arrayBuffer()));
    for (let index = 0; index < parsed.count; index += 1) {
      // Stored batches keep their replay index beside the gzip payload so the
      // player can preserve tab and checkpoint metadata.
      const payload = decodeIngestBody(segmentBatch(parsed, index)).payload;
      if (payload[0] !== 0x1f || payload[1] !== 0x8b) {
        throw new Error(`Stored replay batch ${name}#${index} is not gzip data.`);
      }
      const text = await gunzipToText(payload);
      compressedBatchCount += 1;
      texts.push(text);
      const parsedEvents = JSON.parse(text) as unknown[];
      events.push(...parsedEvents);
    }
  }

  return { events, text: texts.join("\n"), compressedBatchCount };
}

async function gunzipToText(payload: Uint8Array): Promise<string> {
  const body = new Response(payload as unknown as BodyInit).body;
  if (body === null) {
    throw new Error("gzip body missing");
  }

  const plain = await new Response(body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
  return decoder.decode(plain);
}

async function poll<T>(fn: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== null) {
      return value;
    }
    await delay(250);
  }

  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

function authHeaders(state: ServerState): Record<string, string> {
  return { authorization: `Bearer ${state.apiToken}` };
}

function lastPathPart(path: string): string {
  const part = path.split("/").at(-1);
  if (part === undefined || part.length === 0) {
    throw new Error(`segment key has no file name: ${path}`);
  }
  return part;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
