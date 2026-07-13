export const D1_FALLBACK_TAG_PREFIX = "orange-replay-d1-fallback-";
export const PRODUCTION_WORKER_NAME = "orange-replay";

const versionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function makeD1FallbackTag(now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("The D1 fallback time must be a positive whole number.");
  }
  return `${D1_FALLBACK_TAG_PREFIX}${now}`;
}

export function readNewestD1FallbackVersion(output) {
  let versions;
  try {
    versions = JSON.parse(output);
  } catch {
    throw new Error("Cloudflare returned an unreadable Worker version list.");
  }
  if (!Array.isArray(versions)) {
    throw new Error("Cloudflare returned an unreadable Worker version list.");
  }

  const matches = versions.flatMap((version) => {
    if (version === null || typeof version !== "object") return [];
    const id = version.id;
    const tag = version.annotations?.["workers/tag"];
    const createdOn = version.metadata?.created_on ?? version.created_on;
    if (
      typeof id !== "string" ||
      !versionIdPattern.test(id) ||
      typeof tag !== "string" ||
      !tag.startsWith(D1_FALLBACK_TAG_PREFIX) ||
      typeof createdOn !== "string" ||
      !Number.isFinite(Date.parse(createdOn))
    ) {
      return [];
    }
    return [{ createdAt: Date.parse(createdOn), id, tag }];
  });

  matches.sort((left, right) => right.createdAt - left.createdAt);
  const newest = matches[0];
  if (newest === undefined) {
    throw new Error(
      "No prepared D1 fallback version was found among Cloudflare's 10 newest Worker versions.",
    );
  }
  return newest;
}
