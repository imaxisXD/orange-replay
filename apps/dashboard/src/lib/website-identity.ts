import { FAVICON_API_VERSION } from "@orange-replay/shared";

/** Same-origin image endpoint shared by every Website identity surface. */
export function websiteFaviconUrl(url: URL): string {
  return `/api/v1/favicon?website=${encodeURIComponent(url.origin)}&v=${FAVICON_API_VERSION}`;
}
