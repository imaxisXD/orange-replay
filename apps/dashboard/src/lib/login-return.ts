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
  // Activation is a signed-in destination too, so a visitor who was bounced to
  // login from a step comes back to that step instead of restarting the flow.
  const isOnboardingPath =
    url.pathname === "/onboarding" || url.pathname.startsWith("/onboarding/");
  if (!isProjectPath && !isAdminPath && !isOnboardingPath) return defaultReturnTo;
  return `${url.pathname}${url.search}${url.hash}`;
}
