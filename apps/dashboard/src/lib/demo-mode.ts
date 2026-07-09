export interface DemoWorkspaceResponse {
  projectId: string;
  writeKey: string;
}

export function isDemoPath(pathname = currentPathname()): boolean {
  return pathname === "/demo" || pathname.startsWith("/demo/");
}

function currentPathname(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname;
}
