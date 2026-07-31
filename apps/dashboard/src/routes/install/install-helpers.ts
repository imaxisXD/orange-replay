import { ApiError } from "@/lib/api";
import type { ProjectKeyAudit } from "@orange-replay/shared";

export function readInstallErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.code === "network_error") {
    return "Could not reach Orange Replay. Check your connection and try again.";
  }
  if (error.status === 429) return "Too many requests. Wait a moment and try again.";
  if (error.code === "invalid_response") {
    return "Orange Replay returned unexpected data. Refresh the page and try again.";
  }
  return fallback;
}

export async function matchesActiveProjectRecorderKey(
  recorderKey: string,
  keys: readonly ProjectKeyAudit[],
): Promise<boolean> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new Error("This browser cannot verify the recorder key.");
  }

  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(recorderKey));
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  return keys.some((key) => key.active && hash.startsWith(key.keyHashPrefix.toLowerCase()));
}
