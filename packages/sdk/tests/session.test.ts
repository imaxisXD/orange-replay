// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vite-plus/test";
import { SESSION_IDLE_MS, SessionManager, type StorageLike } from "../src/session.ts";

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
  writeCount = 0;

  get cookie(): string {
    return Array.from(this.values, ([name, value]) => `${name}=${value}`).join("; ");
  }

  set cookie(value: string) {
    this.writeCount += 1;
    const [pair = ""] = value.split(";", 1);
    const [name = "", rawValue = ""] = pair.split("=", 2);
    if (name.length === 0) {
      return;
    }

    if (value.toLowerCase().includes("expires=thu, 01 jan 1970")) {
      this.values.delete(name);
      return;
    }

    this.values.set(name, rawValue);
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
  it("persists session and tab ids in session storage", () => {
    const storage = new MemoryStorage();
    const cookieDocument = new CookieDocument();
    let idCount = 0;
    const makeId = () => `id-${(idCount += 1)}`;

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
    const ids = ["session-one", "tab-one", "tab-two"];
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

  it("rotates after 30 idle minutes and resets the per-tab sequence", () => {
    const storage = new MemoryStorage();
    const cookieDocument = new CookieDocument();
    let now = START_TIME;
    const ids = ["session-one", "tab-one", "session-two"];
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

    now += SESSION_IDLE_MS + 1;
    expect(session.touch()).toBe(true);

    expect(session.sessionId).toBe("session-two");
    expect(session.nextSeq()).toBe(0);
  });

  it("continues the per-tab sequence after a same-tab re-init", () => {
    const storage = new MemoryStorage();
    const cookieDocument = new CookieDocument();
    const ids = ["session-one", "tab-one"];
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

    expect(second.sessionId).toBe("session-one");
    expect(second.tabId).toBe("tab-one");
    expect(second.nextSeq()).toBe(2);
  });

  it("mints a fresh tab id when another live tab claims the stored id", async () => {
    const storage = new MemoryStorage();
    const cookieDocument = new CookieDocument();
    const ids = ["session-one", "tab-one", "tab-two"];
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

    expect(first.sessionId).toBe("session-one");
    expect(second.sessionId).toBe("session-one");
    expect(first.tabId).toBe("tab-one");
    expect(second.tabId).toBe("tab-two");
    expect(second.nextSeq()).toBe(0);
    first.stop();
    second.stop();
  });

  it("throttles touch persistence and does not rewrite the cookie on every event", () => {
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
    expect(cookieDocument.writeCount).toBe(initialCookieWrites);
  });

  it("resets the persisted sequence when the session rotates", () => {
    const storage = new MemoryStorage();
    const cookieDocument = new CookieDocument();
    const ids = ["session-one", "tab-one", "session-two"];
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

    expect(session.sessionId).toBe("session-two");
    expect(session.nextSeq()).toBe(0);
  });

  it("starts at sequence 0 when stored sequence is corrupted", () => {
    const storage = new MemoryStorage();
    storage.setItem("or:s", "session-one");
    storage.setItem("or:t", "tab-one");
    storage.setItem("or:last", String(START_TIME));
    storage.setItem("or:q", "not-a-number");

    const session = new SessionManager({
      projectRef: "project",
      now: () => START_TIME + 100,
      storage,
      document: new CookieDocument(),
      makeId: () => "extra-id",
    });

    expect(session.sessionId).toBe("session-one");
    expect(session.tabId).toBe("tab-one");
    expect(session.nextSeq()).toBe(0);
  });

  it("builds a session URL from a base path", () => {
    const session = new SessionManager({
      projectRef: "project-a",
      now: () => START_TIME,
      storage: new MemoryStorage(),
      document: new CookieDocument(),
      makeId: () => "session-a",
    });

    expect(session.getSessionUrl("https://app.test/")).toBe(
      "https://app.test/sessions/project-a/session-a",
    );
  });
});

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
