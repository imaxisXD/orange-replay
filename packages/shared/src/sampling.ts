/**
 * Deterministic session sampling, shared by the SDK and ingest worker.
 * This is an honest-client optimization, not an abuse boundary: session ids
 * are browser-provided, so server-side rate limits, quotas, and caps must
 * enforce cost controls independently of sampleRate.
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
