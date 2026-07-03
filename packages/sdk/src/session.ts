import { uuidv7 } from "@orange-replay/shared/uuid";

const SESSION_STORAGE_KEY = "or:s";
const TAB_STORAGE_KEY = "or:t";
const LAST_ACTIVITY_STORAGE_KEY = "or:last";
const SESSION_COOKIE = "or_s";

export const SESSION_IDLE_MS = 30 * 60 * 1000;

export interface SessionManagerOptions {
  projectRef: string;
  now: () => number;
  storage?: StorageLike;
  document?: Pick<Document, "cookie">;
  makeId?: () => string;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class SessionManager {
  readonly projectRef: string;
  readonly now: () => number;

  private readonly storage?: StorageLike;
  private readonly document?: Pick<Document, "cookie">;
  private readonly makeId: () => string;
  private currentSessionId: string;
  private currentTabId: string;
  private lastActivity: number;
  private seq = 0;

  constructor(options: SessionManagerOptions) {
    this.projectRef = options.projectRef;
    this.now = options.now;
    this.storage = options.storage ?? safeSessionStorage();
    this.document = options.document ?? safeDocument();
    this.makeId = options.makeId ?? uuidv7;

    const nowMs = this.now();
    const cookieSession = this.readCookieSession();
    const storedSession = safeGet(this.storage, SESSION_STORAGE_KEY);
    const storedLastActivity = parseStoredNumber(safeGet(this.storage, LAST_ACTIVITY_STORAGE_KEY));
    const sessionIsIdle =
      storedLastActivity !== undefined && nowMs - storedLastActivity > SESSION_IDLE_MS;

    this.currentSessionId =
      cookieSession ?? (sessionIsIdle ? this.makeId() : storedSession) ?? this.makeId();
    this.currentTabId = safeGet(this.storage, TAB_STORAGE_KEY) ?? this.makeId().slice(0, 12);
    this.lastActivity = sessionIsIdle ? nowMs : (storedLastActivity ?? nowMs);

    this.persist();
  }

  get sessionId(): string {
    return this.currentSessionId;
  }

  get tabId(): string {
    return this.currentTabId;
  }

  touch(): boolean {
    const nowMs = this.now();
    if (nowMs - this.lastActivity > SESSION_IDLE_MS) {
      this.rotate();
      return true;
    }

    this.lastActivity = nowMs;
    this.persist();
    return false;
  }

  rotate(): void {
    this.currentSessionId = this.makeId();
    this.seq = 0;
    this.lastActivity = this.now();
    this.persist();
  }

  nextSeq(): number {
    const seq = this.seq;
    this.seq += 1;
    return seq;
  }

  getSessionUrl(base: string): string {
    const cleanBase = base.replace(/\/+$/, "");
    return `${cleanBase}/sessions/${encodeURIComponent(this.projectRef)}/${encodeURIComponent(
      this.currentSessionId,
    )}`;
  }

  private persist(): void {
    safeSet(this.storage, SESSION_STORAGE_KEY, this.currentSessionId);
    safeSet(this.storage, TAB_STORAGE_KEY, this.currentTabId);
    safeSet(this.storage, LAST_ACTIVITY_STORAGE_KEY, String(this.lastActivity));
    this.writeCookieSession();
  }

  private readCookieSession(): string | undefined {
    const cookie = this.document?.cookie;
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
    if (this.document === undefined) {
      return;
    }

    const expires = new Date(this.now() + SESSION_IDLE_MS).toUTCString();
    this.document.cookie = `${SESSION_COOKIE}=${encodeURIComponent(
      this.currentSessionId,
    )}; Path=/; Expires=${expires}; SameSite=Lax`;
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
