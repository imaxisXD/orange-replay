export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export function isValidSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value);
}
