import { getDomain } from "tldts";

/**
 * Choose the browser cookie domain used to continue one Workspace journey
 * across related HTTPS Websites. Unrelated root domains keep separate cookies.
 */
export function nextWorkspaceCookieDomain(
  currentDomain: string | undefined,
  websiteUrl: URL,
): string | null {
  if (websiteUrl.protocol !== "https:") return currentDomain ?? null;

  const hostname = websiteUrl.hostname.toLowerCase().replace(/\.$/, "");
  const websiteDomain = getDomain(hostname, {
    allowPrivateDomains: true,
    extractHostname: false,
  });
  if (websiteDomain === null) return currentDomain ?? null;
  if (currentDomain === undefined) return websiteDomain;

  const cleanCurrentDomain = currentDomain.toLowerCase().replace(/^\./, "").replace(/\.$/, "");
  if (cleanCurrentDomain === websiteDomain || cleanCurrentDomain.endsWith(`.${websiteDomain}`)) {
    return websiteDomain;
  }
  return cleanCurrentDomain;
}
