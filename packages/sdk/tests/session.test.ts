// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vite-plus/test";
import { CLOSE_SESSION_AFTER_IDLE_MS } from "@orange-replay/shared/constants";
import {
  SESSION_IDLE_MS,
  sessionCookieModeForLocation,
  sessionCookieNameForProject,
  SessionManager,
  sessionStorageKeysForProject,
  type StorageLike,
} from "../src/session.ts";
import { startSessionTouchListeners } from "../src/session-touch.ts";

const START_TIME = 1_700_000_000_000;

class MemoryStorage implements StorageLike {
  private readonly values = new Map<string, string>();
  setCount = 0;

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.setCount += 1;
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

class CookieDocument implements Pick<Document, "cookie"> {
  private values = new Map<string, string>();
  private expiresAt = new Map<string, number>();
  writeCount = 0;
  lastWrite = "";

  constructor(private readonly now: () => number = () => START_TIME) {}

  get cookie(): string {
    const now = this.now();
    return Array.from(this.values)
      .flatMap(([name, value]) => {
        const expiry = this.expiresAt.get(name);
        if (expiry !== undefined && expiry <= now) {
          this.values.delete(name);
          this.expiresAt.delete(name);
          return [];
        }
        return [`${name}=${value}`];
      })
      .join("; ");
  }

  set cookie(value: string) {
    this.writeCount += 1;
    this.lastWrite = value;
    const [pair = ""] = value.split(";", 1);
    const [name = "", rawValue = ""] = pair.split("=", 2);
    if (name.length === 0) {
      return;
    }

    if (value.toLowerCase().includes("expires=thu, 01 jan 1970")) {
      this.values.delete(name);
      this.expiresAt.delete(name);
      return;
    }

    this.values.set(name, rawValue);
    const maxAge = /(?:^|;\s*)max-age=(\d+)/i.exec(value)?.[1];
    const expires = /(?:^|;\s*)expires=([^;]+)/i.exec(value)?.[1];
    const expiry =
      maxAge === undefined
        ? expires === undefined
          ? Number.NaN
          : Date.parse(expires)
        : this.now() + Number(maxAge) * 1_000;
    if (Number.isFinite(expiry)) {
      this.expiresAt.set(name, expiry);
    } else {
      this.expiresAt.delete(name);
    }
  }
}

class FakeBroadcastChannel {
  private static channels = new Map<string, Set<FakeBroadcastChannel>>();

  private readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();
  private readonly name: string;

  constructor(name: string) {
    this.name = name;
    const channels = FakeBroadcastChannel.channels.get(name) ?? new Set();
    channels.add(this);
    FakeBroadcastChannel.channels.set(name, channels);
  }

  static reset(): void {
    FakeBroadcastChannel.channels.clear();
  }

  addEventListener(_type: "message", listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "message", listener: (event: MessageEvent<unknown>) => void): void {
    this.listeners.delete(listener);
  }

  postMessage(message: unknown): void {
    const peers = FakeBroadcastChannel.channels.get(this.name) ?? new Set();
    for (const peer of peers) {
      if (peer === this) {
        continue;
      }
      queueMicrotask(() => {
        for (const listener of peer.listeners) {
          listener({ data: message } as MessageEvent<unknown>);
        }
      });
    }
  }

  close(): void {
    FakeBroadcastChannel.channels.get(this.name)?.delete(this);
    this.listeners.clear();
  }
}

afterEach(() => {
  document.cookie = "or_s=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax";
  window.sessionStorage.clear();
  FakeBroadcastChannel.reset();
});

describe("SessionManager", () => {
  it("uses the same idle timeout as the server", () => {
    expect(SESSION_IDLE_MS).toBe(CLOSE_SESSION_AFTER_IDLE_MS);
    expect(SESSION_IDLE_MS).toBe(10 * 60_000);
  });

  it("persists session and tab ids in session storage", () => {
    const storage = new MemoryStorage();
    const cookieDocument = new CookieDocument();
    let idCount = 0;
    const makeId = () => `test-id-${String((idCount += 1)).padStart(8, "0")}`;

    const first = new SessionManager({
      projectRef: "project",
      now: () => START_TIME,
      storage,
      document: cookieDocument,
      makeId,
    });
    const second = new SessionManager({
      projectRef: "project",
      now: () => START_TIME + 100,
      storage,
      document: cookieDocument,
      makeId,
    });

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.tabId).toBe(first.tabId);
  });

  it("shares the session id across tabs through the first-party cookie", () => {
    const firstStorage = new MemoryStorage();
    const secondStorage = new MemoryStorage();
    const cookieDocument = new CookieDocument();
    const ids = ["session-one-000001", "tab-one", "tab-two"];
    const makeId = () => ids.shift() ?? "extra-id";

    const first = new SessionManager({
      projectRef: "project",
      now: () => START_TIME,
      storage: firstStorage,
      document: cookieDocument,
      makeId,
    });
    const second = new SessionManager({
      projectRef: "project",
      now: () => START_TIME + 100,
      storage: secondStorage,
      document: cookieDocument,
      makeId,
    });

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.tabId).not.toBe(first.tabId);
  });

  it("keeps the session just before and rotates at the exact ten-minute idle boundary", () => {
    const storage = new MemoryStorage();
    let now = START_TIME;
    const cookieDocument = new CookieDocument(() => now);
    const ids = ["session-one-000001", "tab-one", "session-two-000002"];
    const makeId = () => ids.shift() ?? "extra-id";
    const session = new SessionManager({
      projectRef: "project",
      now: () => now,
      storage,
      document: cookieDocument,
      makeId,
    });

    expect(session.nextSeq()).toBe(0);
    expect(session.nextSeq()).toBe(1);

    now += SESSION_IDLE_MS - 1;
    expect(session.touch()).toBe(false);
    expect(session.sessionId).toBe("session-one-000001");

    now += SESSION_IDLE_MS;
    expect(session.touch()).toBe(true);
    expect(session.sessionId).toBe("session-one-000001");
    expect(session.resumeAfterIdle()).toBe(true);

    expect(session.sessionId).toBe("session-two-000002");
    expect(session.nextSeq()).toBe(0);
  });

  it("continues the per-tab sequence after a same-tab re-init", () => {
    const storage = new MemoryStorage();
    const cookieDocument = new CookieDocument();
    const ids = ["session-one-000001", "tab-one"];
    const makeId = () => ids.shift() ?? "extra-id";
    const first = new SessionManager({
      projectRef: "project",
      now: () => START_TIME,
      storage,
      document: cookieDocument,
      makeId,
    });

    expect(first.nextSeq()).toBe(0);
    expect(first.nextSeq()).toBe(1);

    const second = new SessionManager({
      projectRef: "project",
      now: () => START_TIME + 100,
      storage,
      document: cookieDocument,
      makeId,
    });

    expect(second.sessionId).toBe("session-one-000001");
    expect(second.tabId).toBe("tab-one");
    expect(second.nextSeq()).toBe(2);
  });

  it("continues the dormant tab sequence when another tab kept the session active", () => {
    let now = START_TIME;
    const cookieDocument = new CookieDocument(() => now);
    const activeStorage = new MemoryStorage();
    const dormantStorage = new MemoryStorage();
    const makeId = sequenceIds(["session-one-000001", "active-tab", "dormant-tab"]);
    const active = new SessionManager({
      projectRef: "project",
      now: () => now,
      storage: activeStorage,
      document: cookieDocument,
      makeId,
    });
    const dormant = new SessionManager({
      projectRef: "project",
      now: () => now,
      storage: dormantStorage,
      document: cookieDocument,
      makeId,
    });

    expect(dormant.nextSeq()).toBe(0);
    expect(dormant.nextSeq()).toBe(1);

    now += SESSION_IDLE_MS - 1_000;
    expect(active.touch()).toBe(false);
    now += 2_000;

    const reloadedDormant = new SessionManager({
      projectRef: "project",
      now: () => now,
      storage: dormantStorage,
      document: cookieDocument,
      makeId,
    });

    expect(reloadedDormant.sessionId).toBe(active.sessionId);
    expect(reloadedDormant.tabId).toBe(dormant.tabId);
    expect(reloadedDormant.nextSeq()).toBe(2);
  });

  it("mints a fresh tab id when another live tab claims the stored id", async () => {
    const storage = new MemoryStorage();
    const cookieDocument = new CookieDocument();
    const ids = ["session-one-000001", "tab-one", "tab-two"];
    const makeId = () => ids.shift() ?? "extra-id";
    const first = new SessionManager({
      projectRef: "project",
      now: () => START_TIME,
      storage,
      document: cookieDocument,
      makeId,
      broadcastChannel: FakeBroadcastChannel as unknown as typeof BroadcastChannel,
      wait: flushMicrotasks,
    });
    const second = new SessionManager({
      projectRef: "project",
      now: () => START_TIME + 100,
      storage,
      document: cookieDocument,
      makeId,
      broadcastChannel: FakeBroadcastChannel as unknown as typeof BroadcastChannel,
      wait: flushMicrotasks,
    });

    await Promise.all([first.ready, second.ready]);

    expect(first.sessionId).toBe("session-one-000001");
    expect(second.sessionId).toBe("session-one-000001");
    expect(first.tabId).toBe("tab-one");
    expect(second.tabId).toBe("tab-two");
    expect(second.nextSeq()).toBe(0);
    first.stop();
    second.stop();
  });

  it("uses random UUID bits when two copied tabs rotate in the same millisecond", async () => {
    const rotateCopiedTab = async (replacementId: string): Promise<string> => {
      const cookieDocument = new CookieDocument();
      cookieDocument.cookie = `${sessionCookieNameForProject("project", "secure")}=session-one-000001; Path=/; SameSite=Lax; Secure`;
      const makeId = () => replacementId;
      const first = new SessionManager({
        projectRef: "project",
        now: () => START_TIME,
        storage: storedSession("session-one-000001", "copied-tab"),
        document: cookieDocument,
        makeId,
        broadcastChannel: FakeBroadcastChannel as unknown as typeof BroadcastChannel,
        wait: flushMicrotasks,
      });
      const second = new SessionManager({
        projectRef: "project",
        now: () => START_TIME,
        storage: storedSession("session-one-000001", "copied-tab"),
        document: cookieDocument,
        makeId,
        broadcastChannel: FakeBroadcastChannel as unknown as typeof BroadcastChannel,
        wait: flushMicrotasks,
      });

      await Promise.all([first.ready, second.ready]);
      const rotatedIds = [first.tabId, second.tabId].filter((tabId) => tabId !== "copied-tab");
      first.stop();
      second.stop();
      FakeBroadcastChannel.reset();
      expect(rotatedIds).toHaveLength(1);
      return rotatedIds[0]!;
    };

    const firstTabId = await rotateCopiedTab("019f6087-7940-7000-8000-111111111111");
    const secondTabId = await rotateCopiedTab("019f6087-7940-7000-8000-222222222222");

    expect(firstTabId).toBe("8000111111111111");
    expect(secondTabId).toBe("8000222222222222");
    expect(firstTabId).not.toBe(secondTabId);
  });

  it("throttles touch persistence and refreshes the session cookie on the same cadence", () => {
    const storage = new MemoryStorage();
    const cookieDocument = new CookieDocument();
    let now = START_TIME;
    const session = new SessionManager({
      projectRef: "project",
      now: () => now,
      storage,
      document: cookieDocument,
      makeId: () => "id",
    });
    const initialStorageWrites = storage.setCount;
    const initialCookieWrites = cookieDocument.writeCount;

    now += 1_000;
    session.touch();
    now += 1_000;
    session.touch();
    now += 1_000;
    session.touch();

    expect(storage.setCount).toBe(initialStorageWrites);
    expect(cookieDocument.writeCount).toBe(initialCookieWrites);

    now += 2_000;
    session.touch();

    expect(storage.setCount).toBe(initialStorageWrites + 1);
    expect(cookieDocument.writeCount).toBe(initialCookieWrites + 1);
  });

  it("keeps one active session id when a new tab opens after more than one idle window", () => {
    let now = START_TIME;
    const cookieDocument = new CookieDocument(() => now);
    const ids = ["session-one-000001", "tab-one", "tab-two"];
    const makeId = () => ids.shift() ?? "extra-id";
    const first = new SessionManager({
      projectRef: "project",
      now: () => now,
      storage: new MemoryStorage(),
      document: cookieDocument,
      makeId,
    });

    now += SESSION_IDLE_MS - 60_000;
    expect(first.touch()).toBe(false);
    now += SESSION_IDLE_MS - 60_000;
    expect(first.touch()).toBe(false);

    const second = new SessionManager({
      projectRef: "project",
      now: () => now,
      storage: new MemoryStorage(),
      document: cookieDocument,
      makeId,
    });

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.tabId).not.toBe(first.tabId);
  });

  it("keeps a dormant tab in the session that another tab kept active", () => {
    let now = START_TIME;
    const cookieDocument = new CookieDocument(() => now);
    const ids = ["session-one-000001", "active-tab", "dormant-tab", "unexpected-session"];
    const makeId = () => ids.shift() ?? "extra-id";
    const active = new SessionManager({
      projectRef: "project",
      now: () => now,
      storage: new MemoryStorage(),
      document: cookieDocument,
      makeId,
    });
    const dormant = new SessionManager({
      projectRef: "project",
      now: () => now,
      storage: new MemoryStorage(),
      document: cookieDocument,
      makeId,
    });

    now += SESSION_IDLE_MS - 1_000;
    expect(active.touch()).toBe(false);
    now += 2_000;

    expect(dormant.touch()).toBe(true);
    expect(dormant.resumeAfterIdle()).toBe(false);
    expect(dormant.sessionId).toBe(active.sessionId);

    const nextTab = new SessionManager({
      projectRef: "project",
      now: () => now,
      storage: new MemoryStorage(),
      document: cookieDocument,
      makeId,
    });
    expect(nextTab.sessionId).toBe(active.sessionId);
  });

  it("lets the idle listener continue a session kept active by another tab", () => {
    let now = START_TIME;
    const cookieDocument = new CookieDocument(() => now);
    const ids = ["session-one-000001", "active-tab", "dormant-tab"];
    const makeId = () => ids.shift() ?? "extra-id";
    const active = new SessionManager({
      projectRef: "project",
      now: () => now,
      storage: new MemoryStorage(),
      document: cookieDocument,
      makeId,
    });
    const dormant = new SessionManager({
      projectRef: "project",
      now: () => now,
      storage: new MemoryStorage(),
      document: cookieDocument,
      makeId,
    });
    const eventTarget = new EventTarget() as Window;
    const actions: boolean[] = [];
    const stop = startSessionTouchListeners(eventTarget, dormant, () => {
      actions.push(dormant.resumeAfterIdle());
    });

    now += SESSION_IDLE_MS - 1_000;
    active.touch();
    now += 2_000;
    eventTarget.dispatchEvent(new Event("click"));

    expect(actions).toEqual([false]);
    expect(dormant.sessionId).toBe(active.sessionId);
    stop();
  });

  it("does not rotate when the clock crosses the idle boundary between reads", () => {
    let readingEvent = false;
    let eventReadCount = 0;
    const session = new SessionManager({
      projectRef: "project",
      now: () => {
        if (!readingEvent) return START_TIME;
        eventReadCount += 1;
        return eventReadCount === 1
          ? START_TIME + SESSION_IDLE_MS - 1
          : START_TIME + SESSION_IDLE_MS;
      },
      storage: new MemoryStorage(),
      document: new CookieDocument(),
      makeId: sequenceIds(["session-one-000001", "tab-one", "unexpected-session"]),
    });
    const eventTarget = new EventTarget() as Window;
    const idleActions: string[] = [];
    const stop = startSessionTouchListeners(eventTarget, session, () => {
      idleActions.push("idle");
    });

    readingEvent = true;
    eventTarget.dispatchEvent(new Event("click"));

    expect(eventReadCount).toBeGreaterThan(1);
    expect(idleActions).toEqual([]);
    expect(session.sessionId).toBe("session-one-000001");
    stop();
  });

  it("resets the persisted sequence when the session rotates", () => {
    const storage = new MemoryStorage();
    const cookieDocument = new CookieDocument();
    const ids = ["session-one-000001", "tab-one", "session-two-000002"];
    const makeId = () => ids.shift() ?? "extra-id";
    const session = new SessionManager({
      projectRef: "project",
      now: () => START_TIME,
      storage,
      document: cookieDocument,
      makeId,
    });

    expect(session.nextSeq()).toBe(0);
    session.rotate();

    expect(session.sessionId).toBe("session-two-000002");
    expect(session.nextSeq()).toBe(0);
  });

  it("starts at sequence 0 when stored sequence is corrupted", () => {
    const storage = new MemoryStorage();
    const keys = sessionStorageKeysForProject("project");
    storage.setItem(keys.session, "session-one-000001");
    storage.setItem(keys.tab, "tab-one");
    storage.setItem(keys.lastActivity, String(START_TIME));
    storage.setItem(keys.seq, "not-a-number");

    const session = new SessionManager({
      projectRef: "project",
      now: () => START_TIME + 100,
      storage,
      document: new CookieDocument(),
      makeId: () => "extra-id",
    });

    expect(session.sessionId).toBe("session-one-000001");
    expect(session.tabId).toBe("tab-one");
    expect(session.nextSeq()).toBe(0);
  });

  it("scopes storage and cookies without writing the public key", () => {
    const storage = new MemoryStorage();
    const cookieDocument = new CookieDocument();
    const first = new SessionManager({
      projectRef: "or_live_first_public_key",
      now: () => START_TIME,
      storage,
      document: cookieDocument,
      makeId: sequenceIds(["session-first-001", "first-tab"]),
    });
    const second = new SessionManager({
      projectRef: "or_live_second_public_key",
      now: () => START_TIME,
      storage,
      document: cookieDocument,
      makeId: sequenceIds(["session-second-01", "second-tab"]),
    });

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(cookieDocument.cookie).not.toContain("or_live_first_public_key");
    expect(cookieDocument.cookie).not.toContain("or_live_second_public_key");
    expect(sessionStorageKeysForProject("or_live_first_public_key")).not.toEqual(
      sessionStorageKeysForProject("or_live_second_public_key"),
    );
  });

  it("writes a host-only secure cookie on HTTPS", () => {
    const cookieDocument = new CookieDocument();
    new SessionManager({
      projectRef: "public-write-key",
      now: () => START_TIME,
      storage: new MemoryStorage(),
      document: cookieDocument,
      cookieMode: "secure",
      makeId: sequenceIds(["session-secure-01", "secure-tab"]),
    });

    expect(cookieDocument.lastWrite).toMatch(/^__Host-or_s_[a-z0-9]{2,14}=/);
    expect(cookieDocument.lastWrite).toContain("; Path=/;");
    expect(cookieDocument.lastWrite).toContain("; SameSite=Lax; Secure");
    expect(cookieDocument.lastWrite).not.toContain("Domain=");
    expect(cookieDocument.lastWrite).not.toContain("public-write-key");
  });

  it("does not read cookies when cookies are disabled", () => {
    const cookieDocument = new CookieDocument();
    cookieDocument.cookie = "undefined=session-from-wrong-cookie; Path=/";
    const session = new SessionManager({
      projectRef: "public-write-key",
      now: () => START_TIME,
      storage: new MemoryStorage(),
      document: cookieDocument,
      cookieMode: "none",
      makeId: sequenceIds(["session-current-01", "current-tab"]),
    });

    expect(session.sessionId).toBe("session-current-01");
    expect(cookieDocument.lastWrite).toBe("undefined=session-from-wrong-cookie; Path=/");
  });

  it("ignores malformed, invalid, and legacy session cookies", () => {
    const projectRef = "project";
    const cookieName = sessionCookieNameForProject(projectRef, "secure")!;
    const cookieDocument = new CookieDocument();
    cookieDocument.cookie = `${cookieName}=%E0%A4%A; Path=/; Secure`;
    cookieDocument.cookie = "or_s=legacy-session-01; Path=/";
    const session = new SessionManager({
      projectRef,
      now: () => START_TIME,
      storage: new MemoryStorage(),
      document: cookieDocument,
      makeId: sequenceIds(["session-current-01", "current-tab"]),
    });

    expect(session.sessionId).toBe("session-current-01");
  });

  it("only writes the shared session cookie over HTTPS", () => {
    expect(sessionCookieModeForLocation({ protocol: "https:", hostname: "example.test" })).toBe(
      "secure",
    );
    expect(sessionCookieModeForLocation({ protocol: "http:", hostname: "localhost" })).toBe("none");
    expect(sessionCookieModeForLocation({ protocol: "http:", hostname: "example.test" })).toBe(
      "none",
    );
  });

  it("does not expose the write key when project config is unavailable", () => {
    const session = new SessionManager({
      projectRef: "or_live_never_put_this_in_a_url",
      now: () => START_TIME,
      storage: new MemoryStorage(),
      document: new CookieDocument(),
      makeId: sequenceIds(["session-private-01", "private-tab"]),
    });

    expect(session.getSessionUrl("https://app.test")).toBe("");
  });

  it("builds a session URL from a base path", () => {
    const session = new SessionManager({
      projectRef: "project-a",
      now: () => START_TIME,
      storage: new MemoryStorage(),
      document: new CookieDocument(),
      makeId: () => "session-a-000001",
    });
    session.setProjectId("project-a");

    expect(session.getSessionUrl("https://app.test/")).toBe(
      "https://app.test/sessions/project-a/session-a-000001",
    );
  });
});

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function sequenceIds(values: string[]): () => string {
  return () => values.shift() ?? "extra-id";
}

function storedSession(sessionId: string, tabId: string): MemoryStorage {
  const storage = new MemoryStorage();
  const keys = sessionStorageKeysForProject("project");
  storage.setItem(keys.session, sessionId);
  storage.setItem(keys.tab, tabId);
  storage.setItem(keys.lastActivity, String(START_TIME));
  storage.setItem(keys.seq, "0");
  return storage;
}
