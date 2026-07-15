export const defaultReturnTo = "/projects";

export function loginReasonMessage(
  reason: string | undefined,
  _authMode: "github" | "unavailable" | undefined,
): string {
  if (reason !== "unauthorized") return "";
  return "GitHub sign-in was not completed. Try again.";
}

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
  const isProjectPath = url.pathname === "/projects" || url.pathname.startsWith("/projects/");
  const isAdminPath = url.pathname === "/_admin";
  if (!isProjectPath && !isAdminPath) return defaultReturnTo;
  return `${url.pathname}${url.search}${url.hash}`;
}
