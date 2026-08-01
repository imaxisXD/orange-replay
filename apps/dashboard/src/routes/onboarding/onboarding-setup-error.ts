import { ApiError } from "@/lib/api";
import { readDashboardAccessError } from "@/lib/dashboard-access";

const DEFAULT_SETUP_ERROR = "Could not prepare the installation script. Try again.";

/** Maps internal installation failures to calm Website language for onboarding. */
export function readWebsiteSetupError(
  error: unknown,
  fallback: string = DEFAULT_SETUP_ERROR,
): string {
  if (error instanceof ApiError) {
    if (error.code === "active_key_limit_reached") {
      return "This Workspace has reached its Website limit. Contact support before adding another website.";
    }
    if (error.code === "key_history_limit_reached") {
      return "This Workspace cannot create another Website installation right now. Try again later.";
    }
    if (error.code === "rate_limited") {
      return "Too many setup attempts. Wait a minute, then try again.";
    }
    if (error.code === "key_cache_unavailable") {
      return "Website setup is temporarily unavailable. Try again.";
    }
    if (error.code === "website_already_exists") {
      return "That Website is already part of this Workspace.";
    }
    if (error.code === "website_not_editable") {
      return "This Website connected while you were editing it. Go to the dashboard or add another website.";
    }
    if (error.code === "website_changed") {
      return "This Website changed in another tab. Reload and try again.";
    }
    if (error.code === "website_not_found") {
      return "This Website is no longer available. Go back and choose another one.";
    }
    if (error.code === "not_found") return "This Workspace is no longer available.";
    if (error.code !== "network_error") return fallback;
  }

  const message = readDashboardAccessError(error, fallback);
  return /recorder[-_ ]?key/i.test(message) || /^[a-z][a-z\d_]+$/i.test(message)
    ? fallback
    : message;
}
