import { ApiError } from "@/lib/api";
import type { ProjectKeyAudit } from "@orange-replay/shared";

export function readInstallErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.code ?? error.message;
  if (error instanceof Error) return error.message;
  return "The request failed. Try again in a moment.";
}

export async function matchesActiveProjectWriteKey(
  writeKey: string,
  keys: readonly ProjectKeyAudit[],
): Promise<boolean> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new Error("This browser cannot verify the write key.");
  }

  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(writeKey));
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  return keys.some((key) => key.active && hash.startsWith(key.keyHashPrefix.toLowerCase()));
}
