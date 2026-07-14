import { CLOSE_SESSION_AFTER_IDLE_MS, MAX_SEQ } from "@orange-replay/shared/constants";
import { uuidv7 } from "@orange-replay/shared/uuid";

const SESSION_STORAGE_KEY = "or:s";
const TAB_STORAGE_KEY = "or:t";
const LAST_ACTIVITY_STORAGE_KEY = "or:last";
const SEQ_STORAGE_KEY = "or:q";
const SESSION_COOKIE = "or_s";

// Keep the public SDK name, but use the same number as the server. One shared
// value prevents the browser and Durable Object from silently drifting apart.
export const SESSION_IDLE_MS = CLOSE_SESSION_AFTER_IDLE_MS;
export const TAB_CLAIM_GRACE_MS = 50;
export const TOUCH_PERSIST_THROTTLE_MS = 5_000;

export interface SessionManagerOptions {
  projectRef: string;
  now: () => number;
  storage?: StorageLike;
  document?: Pick<Document, "cookie">;
  makeId?: () => string;
  broadcastChannel?: BroadcastChannelCtor;
  wait?: (ms: number) => Promise<void>;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type BroadcastMessage =
  | { k: "claim"; tab: string; nonce: string }
  | { k: "ack"; tab: string; nonce: string };

type BroadcastChannelCtor = new (name: string) => BroadcastChannel;

export class SessionManager {
  readonly ready: Promise<void>;

  readonly #projectRef: string;
  readonly #now: () => number;
  readonly #storage?: StorageLike;
  readonly #document?: Pick<Document, "cookie">;
  private readonly makeId: () => string;
  private readonly broadcastChannel?: BroadcastChannelCtor;
  readonly #wait: (ms: number) => Promise<void>;
  private currentSessionId: string;
  private currentTabId: string;
  private lastActivity: number;
  #seq: number;
  #channel: BroadcastChannel | undefined;
  private lastActivityPersistedAt = 0;

  constructor(options: SessionManagerOptions) {
    this.#projectRef = options.projectRef;
    this.#now = options.now;
    this.#storage = options.storage ?? safeSessionStorage();
    this.#document = options.document ?? safeDocument();
    this.makeId = options.makeId ?? uuidv7;
    this.broadcastChannel = options.broadcastChannel ?? safeBroadcastChannel();
    this.#wait = options.wait ?? defaultWait;

    const nowMs = this.#now();
    const cookieSession = this.readCookieSession();
    const storedSession = safeGet(this.#storage, SESSION_STORAGE_KEY);
    const storedLastActivity = parseStoredNumber(safeGet(this.#storage, LAST_ACTIVITY_STORAGE_KEY));
    const sessionIsIdle =
      storedLastActivity !== undefined && nowMs - storedLastActivity >= SESSION_IDLE_MS;

    this.currentSessionId =
      cookieSession ?? (sessionIsIdle ? this.makeId() : storedSession) ?? this.makeId();
    this.currentTabId = safeGet(this.#storage, TAB_STORAGE_KEY) ?? this.makeTabId();
    this.lastActivity = sessionIsIdle ? nowMs : (storedLastActivity ?? nowMs);
    this.#seq =
      storedSession === this.currentSessionId
        ? (parseStoredSeq(safeGet(this.#storage, SEQ_STORAGE_KEY)) ?? 0)
        : 0;

    this.persist();
    this.ready = this.claimTabOwnership();
  }

  get sessionId(): string {
    return this.currentSessionId;
  }

  get tabId(): string {
    return this.currentTabId;
  }

  touch(): boolean {
    const nowMs = this.#now();
    if (nowMs - this.lastActivity >= SESSION_IDLE_MS) {
      // The caller must reconcile the shared cookie before changing ids. A
      // different tab may still be keeping this browser session alive.
      return true;
    }

    this.lastActivity = nowMs;
    if (nowMs - this.lastActivityPersistedAt >= TOUCH_PERSIST_THROTTLE_MS) {
      this.persist(true);
    }
    return false;
  }

  /**
   * Resolve an idle tab against the shared first-party cookie. Another tab may
   * still be active even when this tab has been quiet for 30 minutes.
   */
  resumeAfterIdle(): boolean {
    const nowMs = this.#now();
    const activeSessionId = this.readCookieSession();

    if (activeSessionId === undefined) {
      this.rotate();
      return true;
    }

    this.lastActivity = nowMs;
    if (activeSessionId === this.currentSessionId) {
      this.persist(true);
      return false;
    }

    this.currentSessionId = activeSessionId;
    this.#seq = 0;
    this.persist();
    void this.reclaimForCurrentSession();
    return true;
  }

  rotate(): void {
    this.currentSessionId = this.makeId();
    this.#seq = 0;
    this.lastActivity = this.#now();
    this.persist();
    void this.reclaimForCurrentSession();
  }

  nextSeq(): number {
    const seq = this.#seq;
    this.#seq += 1;
    this.persistSeq();
    return seq;
  }

  getSessionUrl(base: string): string {
    const cleanBase = base.replace(/\/+$/, "");
    return `${cleanBase}/sessions/${encodeURIComponent(this.#projectRef)}/${encodeURIComponent(
      this.currentSessionId,
    )}`;
  }

  stop(): void {
    this.#channel?.close();
    this.#channel = undefined;
  }

  private async claimTabOwnership(): Promise<void> {
    const Channel = this.broadcastChannel;
    if (Channel === undefined) {
      return;
    }

    await this.openClaimChannel(Channel);
  }

  private async reclaimForCurrentSession(): Promise<void> {
    const Channel = this.broadcastChannel;
    if (Channel === undefined) {
      return;
    }

    this.#channel?.close();
    this.#channel = undefined;
    await this.openClaimChannel(Channel);
  }

  private async openClaimChannel(Channel: BroadcastChannelCtor): Promise<void> {
    let channel: BroadcastChannel;
    try {
      channel = new Channel(`orange-replay:${this.#projectRef}:${this.currentSessionId}`);
    } catch {
      return;
    }

    this.#channel = channel;
    let nonce = makeNonce();
    let claimed = false;
    const onMessage = (event: MessageEvent<unknown>) => {
      const message = cleanBroadcastMessage(event.data);
      if (message === undefined) {
        return;
      }

      if (message.k === "claim" && message.tab === this.currentTabId && message.nonce !== nonce) {
        try {
          channel.postMessage({ k: "ack", tab: message.tab, nonce: message.nonce });
        } catch {
          /* BroadcastChannel can be disabled while the page is unloading */
        }
        return;
      }

      if (message.k === "ack" && message.tab === this.currentTabId && message.nonce === nonce) {
        claimed = true;
      }
    };

    channel.addEventListener("message", onMessage);
    this.postTabClaim(channel, nonce);
    await this.#wait(TAB_CLAIM_GRACE_MS);

    if (claimed) {
      this.currentTabId = this.makeTabId();
      this.#seq = 0;
      this.persist();
      nonce = makeNonce();
      this.postTabClaim(channel, nonce);
    }
  }

  private postTabClaim(channel: BroadcastChannel, nonce: string): void {
    try {
      channel.postMessage({ k: "claim", tab: this.currentTabId, nonce });
    } catch {
      /* BroadcastChannel can be unavailable in privacy-restricted browsers */
    }
  }

  private makeTabId(): string {
    const createdId = this.makeId();
    const randomPart = createdId.replaceAll("-", "");
    // UUIDv7 starts with its timestamp. Taking the first characters lets two
    // tabs opened in the same millisecond choose the same tab id. Keep the
    // random end instead; short custom ids used by tests stay readable.
    return randomPart.length > 16 ? randomPart.slice(-16) : createdId.slice(0, 16);
  }

  private persist(lastActivityOnly = false): void {
    if (!lastActivityOnly) {
      safeSet(this.#storage, SESSION_STORAGE_KEY, this.currentSessionId);
      safeSet(this.#storage, TAB_STORAGE_KEY, this.currentTabId);
      this.persistSeq();
    }

    safeSet(this.#storage, LAST_ACTIVITY_STORAGE_KEY, String(this.lastActivity));
    this.lastActivityPersistedAt = this.#now();
    this.writeCookieSession();
  }

  private persistSeq(): void {
    safeSet(this.#storage, SEQ_STORAGE_KEY, String(this.#seq));
  }

  private readCookieSession(): string | undefined {
    const cookie = this.#document?.cookie;
    if (cookie === undefined || cookie.length === 0) {
      return undefined;
    }

    for (const part of cookie.split(";")) {
      const [rawName, ...rawValue] = part.trim().split("=");
      if (rawName === SESSION_COOKIE) {
        const value = rawValue.join("=");
        return value.length > 0 ? decodeURIComponent(value) : undefined;
      }
    }

    return undefined;
  }

  private writeCookieSession(): void {
    if (this.#document === undefined) {
      return;
    }

    this.#document.cookie = `${SESSION_COOKIE}=${encodeURIComponent(
      this.currentSessionId,
    )}; Path=/; Max-Age=${SESSION_IDLE_MS / 1_000}; SameSite=Lax`;
  }
}

function safeSessionStorage(): StorageLike | undefined {
  try {
    if (typeof window !== "undefined") {
      return window.sessionStorage;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function safeDocument(): Pick<Document, "cookie"> | undefined {
  if (typeof document === "undefined") {
    return undefined;
  }

  return document;
}

function safeBroadcastChannel(): BroadcastChannelCtor | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  return typeof window.BroadcastChannel === "function" ? window.BroadcastChannel : undefined;
}

function safeGet(storage: StorageLike | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeSet(storage: StorageLike | undefined, key: string, value: string): void {
  try {
    storage?.setItem(key, value);
  } catch {
    /* storage can be blocked by browser privacy settings */
  }
}

function parseStoredNumber(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseStoredSeq(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_SEQ) {
    return undefined;
  }

  return parsed;
}

function cleanBroadcastMessage(value: unknown): BroadcastMessage | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const message = value as Partial<BroadcastMessage>;
  if (
    (message.k === "claim" || message.k === "ack") &&
    typeof message.tab === "string" &&
    typeof message.nonce === "string"
  ) {
    return message as BroadcastMessage;
  }

  return undefined;
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function makeNonce(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* ignore blocked crypto APIs */
  }

  return `${Date.now()}-${Math.random()}`;
}
