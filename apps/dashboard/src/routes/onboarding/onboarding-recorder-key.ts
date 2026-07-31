const ONBOARDING_RECORDER_KEY_PREFIX = "orange-replay:onboarding-recorder-key:";

/**
 * A recorder key is a public browser credential, not a dashboard secret. Keep
 * the once-readable value only in this tab so a refresh does not strand an
 * unfinished onboarding flow or create another key. The value disappears when
 * the tab closes and is removed as soon as the recorder connects.
 */
export function readOnboardingRecorderKey(projectId: string, websiteId: string): string | null {
  try {
    return window.sessionStorage.getItem(storageKey(projectId, websiteId));
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
    window.sessionStorage.setItem(storageKey(projectId, websiteId), recorderKey);
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
