import { redirect } from "@tanstack/react-router";
import { getApiToken } from "./api";
import { isDemoPath } from "./demo-mode";
import { loginSearch } from "./routes";

interface RouteLocation {
  href: string;
  pathname: string;
}

export function requireProjectToken(location: RouteLocation): void {
  if (isDemoPath(location.pathname) || getApiToken() !== null) return;
  throw redirect({
    to: "/login",
    search: loginSearch(undefined, location.href),
    replace: true,
  });
}
