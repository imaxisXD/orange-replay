import { defaultProjectId } from "./routes";

const defaultReturnTo = `/projects/${defaultProjectId}/sessions`;

export function safeReturnPath(value: string | undefined): string {
  if (value === undefined || value.length === 0) return defaultReturnTo;
  if (value.includes("\\") || /%5c/i.test(value)) return defaultReturnTo;

  let url: URL;
  try {
    url = new URL(value, window.location.origin);
  } catch {
    return defaultReturnTo;
  }

  if (url.origin !== window.location.origin) return defaultReturnTo;
  if (!url.pathname.startsWith("/projects/")) return defaultReturnTo;
  return `${url.pathname}${url.search}${url.hash}`;
}
