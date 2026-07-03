import { SDK_FLUSH_DEFAULT_MS } from "@orange-replay/shared/constants";

export interface InitOptions {
  key: string;
  ingestUrl: string;
  transport?: "worker" | "inline";
  sampleRate?: number;
  maskTextSelector?: string;
  blockSelector?: string;
  ignoreSelector?: string;
  allowUrlParams?: string[];
  flushMs?: number;
}

export interface RecorderConfig {
  key: string;
  ingestUrl: string;
  projectRef: string;
  transport?: "worker" | "inline";
  sampleRate: number;
  maskTextSelector?: string;
  blockSelector?: string;
  ignoreSelector?: string;
  allowUrlParams: string[];
  flushMs: number;
}

export interface OrangeReplayHandle {
  stop(): Promise<void>;
  addCustomEvent(name: string, meta?: Record<string, unknown>): void;
  getSessionUrl(base?: string): string;
}

export function resolveInitOptions(options: InitOptions): RecorderConfig {
  return {
    key: options.key,
    ingestUrl: trimTrailingSlash(options.ingestUrl),
    projectRef: options.key,
    transport: options.transport === "inline" ? "inline" : "worker",
    sampleRate: clampSampleRate(options.sampleRate ?? 1),
    maskTextSelector: cleanOptionalString(options.maskTextSelector),
    blockSelector: cleanOptionalString(options.blockSelector),
    ignoreSelector: cleanOptionalString(options.ignoreSelector),
    allowUrlParams: cleanAllowParams(options.allowUrlParams),
    flushMs: cleanFlushMs(options.flushMs),
  };
}

function clampSampleRate(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }

  if (value < 0) {
    return 0;
  }

  if (value > 1) {
    return 1;
  }

  return value;
}

function cleanOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function cleanAllowParams(params: string[] | undefined): string[] {
  if (params === undefined) {
    return [];
  }

  const seen = new Set<string>();
  const output: string[] = [];

  for (const param of params) {
    const clean = param.trim();
    if (clean.length > 0 && !seen.has(clean)) {
      seen.add(clean);
      output.push(clean);
    }
  }

  return output;
}

function cleanFlushMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return SDK_FLUSH_DEFAULT_MS;
  }

  return Math.floor(value);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
