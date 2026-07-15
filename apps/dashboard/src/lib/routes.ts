export function loginSearch(reason?: string, returnTo?: string): Record<string, string> {
  const search: Record<string, string> = {};
  if (reason !== undefined && reason.length > 0) search["reason"] = reason;
  if (returnTo !== undefined && returnTo.length > 0) search["returnTo"] = returnTo;
  return search;
}
