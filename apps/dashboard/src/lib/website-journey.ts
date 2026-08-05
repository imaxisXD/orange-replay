/**
 * Decide whether a new Website belongs to the current visitor journey. Exact
 * repeats stay put, related HTTPS subdomains stay inside the safe journey
 * domain supplied by the Worker, and a public HTTP or unrelated domain gets
 * its own recordings. Local development does not force a split.
 */
export function continuesVisitorJourney(
  url: URL,
  existingOrigins: readonly string[],
  journeyDomain?: string | null,
): boolean {
  if (existingOrigins.length === 0 || existingOrigins.includes(url.origin)) return true;
  if (isLocalHostname(url.hostname)) return true;
  if (url.protocol !== "https:") return false;
  if (journeyDomain === undefined || journeyDomain === null) {
    return existingOrigins.every(isLocalOrigin);
  }

  const hostname = cleanHostname(url.hostname);
  const boundary = cleanHostname(journeyDomain);
  return hostname === boundary || hostname.endsWith(`.${boundary}`);
}

/** True once the Worker has supplied the boundary needed for a safe decision. */
export function canDecideVisitorJourney(
  existingOrigins: readonly string[],
  journeyDomain?: string | null,
): boolean {
  return journeyDomain !== undefined || existingOrigins.every(isLocalOrigin);
}

/** Reuse one known-empty project after a failed or interrupted separate Website setup. */
export function findReusableEmptyProjectId(
  currentProjectId: string,
  projects: readonly { id: string; websiteOrigin?: string | null }[],
): string | null {
  return (
    projects.find((project) => project.id !== currentProjectId && project.websiteOrigin === null)
      ?.id ?? null
  );
}

function isLocalOrigin(origin: string): boolean {
  try {
    return isLocalHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function isLocalHostname(hostname: string): boolean {
  const clean = cleanHostname(hostname);
  return (
    clean === "localhost" ||
    clean.endsWith(".localhost") ||
    clean.startsWith("[") ||
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(clean)
  );
}

function cleanHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\./, "").replace(/\.$/, "");
}
