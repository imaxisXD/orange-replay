/**
 * Deterministic session sampling, shared by the SDK (client-side decision)
 * and the ingest worker (server-side abuse re-check, ARCHITECTURE §2). Both
 * sides MUST agree, so this is the single implementation: FNV-1a over the
 * session id mapped to [0, 1).
 */
export function shouldSampleSession(sessionId: string, sampleRate: number): boolean {
  if (sampleRate <= 0) {
    return false;
  }

  if (sampleRate >= 1) {
    return true;
  }

  return hashToUnit(sessionId) < sampleRate;
}

export function hashToUnit(value: string): number {
  let hash = 0x811c9dc5;

  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0) / 0x1_0000_0000;
}
