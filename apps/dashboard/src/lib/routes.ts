const projectIdPattern = /^[A-Za-z0-9_-]{1,64}$/;
const devProjectId = "project_demo";

export const defaultProjectId = readDefaultProjectId();

export function loginSearch(reason?: string, returnTo?: string): Record<string, string> {
  const search: Record<string, string> = {};
  if (reason !== undefined && reason.length > 0) search["reason"] = reason;
  if (returnTo !== undefined && returnTo.length > 0) search["returnTo"] = returnTo;
  return search;
}

export function projectIdFromProjectPath(value: string): string {
  const match = /^\/projects\/([^/?#]+)/.exec(value);
  if (match === null) return defaultProjectId;

  try {
    const decoded = decodeURIComponent(match[1] ?? "");
    return projectIdPattern.test(decoded) ? decoded : defaultProjectId;
  } catch {
    return defaultProjectId;
  }
}

export function localTokenReturnPath(value: string): string {
  return /^\/projects\/[^/?#]+/.test(value) ? value : `/projects/${defaultProjectId}/overview`;
}

function readDefaultProjectId(): string {
  const configured = import.meta.env.VITE_DEFAULT_PROJECT_ID;
  if (typeof configured === "string" && projectIdPattern.test(configured)) {
    return configured;
  }
  if (import.meta.env.DEV || import.meta.env.MODE === "test") {
    return devProjectId;
  }
  throw new Error("VITE_DEFAULT_PROJECT_ID must be set before building the dashboard.");
}
