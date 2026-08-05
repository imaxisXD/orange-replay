import { generatedRecorderKeySchema } from "@orange-replay/shared";

const ONBOARDING_RECORDER_KEY_PREFIX = "orange-replay:onboarding-recorder-key:";

/**
 * A recorder key is a public browser credential, not a dashboard secret. Keep
 * the once-readable value only in this tab so a refresh does not strand an
 * unfinished onboarding flow or create another key. The value disappears when
 * the tab closes and is removed as soon as the recorder connects.
 */
export function readOnboardingRecorderKey(projectId: string, websiteId: string): string | null {
  try {
    const key = storageKey(projectId, websiteId);
    const storedValue = window.sessionStorage.getItem(key);
    if (storedValue === null) return null;
    const parsed = generatedRecorderKeySchema.safeParse(storedValue);
    if (parsed.success) return parsed.data;
    window.sessionStorage.removeItem(key);
    return null;
  } catch {
    return null;
  }
}

export function saveOnboardingRecorderKey(
  projectId: string,
  websiteId: string,
  recorderKey: string,
): void {
  try {
    const key = storageKey(projectId, websiteId);
    const parsed = generatedRecorderKeySchema.safeParse(recorderKey);
    if (!parsed.success) {
      window.sessionStorage.removeItem(key);
      return;
    }
    window.sessionStorage.setItem(key, parsed.data);
  } catch {
    // In-memory context still carries the key when storage is unavailable.
  }
}

export function clearOnboardingRecorderKey(projectId: string, websiteId: string): void {
  try {
    window.sessionStorage.removeItem(storageKey(projectId, websiteId));
  } catch {
    // There is nothing else to clear when tab storage is unavailable.
  }
}

function storageKey(projectId: string, websiteId: string): string {
  return `${ONBOARDING_RECORDER_KEY_PREFIX}${projectId}:${websiteId}`;
}
