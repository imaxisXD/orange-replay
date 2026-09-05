import { fetchReplayAssetBytes, loadReplayAssetMap } from "./api.ts";
import { sanitizeReplayCss, type ReplayCssUrlRewriter } from "./css.ts";
import type { PlayerApiInput, ReplayAssetMapEntry, SessionRequest } from "./types.ts";

const MAX_PLAYER_ASSET_BYTES = 20 * 1024 * 1024;
const MAX_STYLESHEET_DEPTH = 8;
const MAX_ASSET_WAIT_MS = 5_000;

export class ReplayAssetStore {
  private readonly api: PlayerApiInput;
  private readonly request: SessionRequest;
  private readonly signal: AbortSignal;
  private readonly objectUrls = new Set<string>();
  private readonly rootUrls = new Map<string, string>();
  private loadAbort: AbortController | undefined;
  private destroyed = false;

  constructor(api: PlayerApiInput, request: SessionRequest, signal: AbortSignal) {
    this.api = api;
    this.request = request;
    this.signal = signal;
  }

  readonly rewriteUrl: ReplayCssUrlRewriter = (url) => this.rootUrls.get(url);

  async load(): Promise<void> {
    if (this.destroyed || this.signal.aborted) return;
    const controller = new AbortController();
    this.loadAbort = controller;
    const abort = () => controller.abort();
    this.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, MAX_ASSET_WAIT_MS);
    try {
      await this.loadUntilDeadline(controller.signal);
    } finally {
      clearTimeout(timeout);
      this.signal.removeEventListener("abort", abort);
      this.loadAbort = undefined;
    }
  }

  private async loadUntilDeadline(signal: AbortSignal): Promise<void> {
    let map;
    try {
      map = await stopWaitingOnAbort(
        loadReplayAssetMap(this.api, { ...this.request, signal }),
        signal,
      );
    } catch {
      return;
    }
    if (map == null || this.destroyed || this.signal.aborted) return;

    const unique = new Map<string, ReplayAssetMapEntry>();
    let totalBytes = 0;
    for (const entry of map.entries) {
      if (unique.has(entry.assetHash)) continue;
      totalBytes += entry.bytes;
      if (totalBytes > MAX_PLAYER_ASSET_BYTES) break;
      unique.set(entry.assetHash, entry);
    }

    const bytesByHash = new Map<string, Uint8Array>();
    const downloads = runWithConcurrency([...unique.values()], 6, async (entry) => {
      if (signal.aborted) return;
      try {
        const bytes = await fetchReplayAssetBytes(this.api, {
          ...this.request,
          assetHash: entry.assetHash,
          bytes: entry.bytes,
          signal,
        });
        if (!signal.aborted) bytesByHash.set(entry.assetHash, bytes);
      } catch {
        /* one missing public asset must not stop the replay */
      }
    });
    await stopWaitingOnAbort(downloads, signal);
    if (this.destroyed || this.signal.aborted) return;

    const urlByHash = new Map<string, string>();
    for (const entry of unique.values()) {
      if (entry.kind === "stylesheet") continue;
      const bytes = bytesByHash.get(entry.assetHash);
      if (bytes === undefined) continue;
      urlByHash.set(entry.assetHash, this.createObjectUrl(bytes, entry.contentType));
    }

    const dependencies = dependencyMaps(map.entries);
    const building = new Set<string>();
    const buildStylesheet = (assetHash: string, depth = 0): string | undefined => {
      if (depth > MAX_STYLESHEET_DEPTH) return undefined;
      const existing = urlByHash.get(assetHash);
      if (existing !== undefined) return existing;
      if (building.has(assetHash)) return undefined;
      const entry = unique.get(assetHash);
      const bytes = bytesByHash.get(assetHash);
      if (entry?.kind !== "stylesheet" || bytes === undefined) return undefined;
      building.add(assetHash);
      const dependencyUrls = new Map<string, string>();
      for (const [sourceUrl, dependencyHash] of dependencies.get(assetHash) ?? []) {
        const dependencyUrl =
          buildStylesheet(dependencyHash, depth + 1) ?? urlByHash.get(dependencyHash);
        if (dependencyUrl !== undefined) dependencyUrls.set(sourceUrl, dependencyUrl);
      }
      let css: string;
      try {
        css = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        building.delete(assetHash);
        return undefined;
      }
      const sanitized = sanitizeReplayCss(css, "stylesheet", (url) => dependencyUrls.get(url));
      const objectUrl = this.createObjectUrl(new TextEncoder().encode(sanitized), "text/css");
      urlByHash.set(assetHash, objectUrl);
      building.delete(assetHash);
      return objectUrl;
    };

    for (const entry of unique.values()) {
      if (entry.kind === "stylesheet") buildStylesheet(entry.assetHash);
    }
    for (const entry of map.entries) {
      if (entry.parentHash !== "") continue;
      const objectUrl = urlByHash.get(entry.assetHash);
      if (objectUrl !== undefined) this.rootUrls.set(entry.sourceUrl, objectUrl);
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.loadAbort?.abort();
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls.clear();
    this.rootUrls.clear();
  }

  private createObjectUrl(bytes: Uint8Array, contentType: string): string {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: contentType }));
    this.objectUrls.add(url);
    return url;
  }
}

function stopWaitingOnAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      resolve(undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function dependencyMaps(entries: readonly ReplayAssetMapEntry[]): Map<string, Map<string, string>> {
  const output = new Map<string, Map<string, string>>();
  for (const entry of entries) {
    if (entry.parentHash === "") continue;
    const values = output.get(entry.parentHash) ?? new Map<string, string>();
    values.set(entry.sourceUrl, entry.assetHash);
    output.set(entry.parentHash, values);
  }
  return output;
}

async function runWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  work: (value: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const worker = async () => {
    for (;;) {
      const current = index++;
      const value = values[current];
      if (value === undefined) return;
      await work(value);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
}
