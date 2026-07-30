import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";

/**
 * Every client-routed screen must be reachable by URL, not only by an in-app
 * navigation. That takes four separate lists agreeing, in three languages:
 * the Worker's `isDashboardAppRoute`, the deployed Worker's `run_worker_first`,
 * the self-host template's copy of it, and the integrated dev server's copy.
 *
 * Adding `/onboarding` (2026-07-30) updated the router and none of the four.
 * The flow worked for the whole session because every visit arrived through a
 * client-side redirect; the first refresh or shared link would have 404'd, and
 * that is the first URL a new account ever sees. This test derives the routes
 * from the router so the next route cannot ship half-wired.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(path.join(repoRoot, relativePath), "utf8");

const routerSource = read("apps/dashboard/src/router.tsx");
const appShellSource = read("apps/worker/src/app-shell.ts");

/**
 * Routes registered directly under the router's root, which is exactly the set
 * that has to survive a cold HTTP request. A route only needs the wildcard form
 * in the allowlists when the router actually nests children under it, which the
 * router itself tells us.
 */
function rootRoutes() {
  const pattern =
    /const (\w+) = createRoute\(\{\s*\n\s*getParentRoute:\s*\(\)\s*=>\s*rootRoute,\s*\n\s*path:\s*"([^"]+)"/g;
  return [...routerSource.matchAll(pattern)].map(([, constName, routePath]) => ({
    constName,
    routePath,
    hasChildren: routerSource.includes(`getParentRoute: () => ${constName}`),
  }));
}

/** The leading segment a route allowlist has to name, e.g. "/onboarding". */
function topSegment(routePath) {
  const segment = routePath.split("/").filter((part) => part.length > 0)[0];
  return segment === undefined ? "/" : `/${segment}`;
}

// `/` redirects to /projects, and /local-labs is development-only: its route
// guard throws notFound() in production, so it must NOT be served in prod.
const EXCLUDED = new Set(["/", "/local-labs"]);

/** segment -> whether any route under it nests children. */
const requiredSegments = new Map();
for (const route of rootRoutes()) {
  const segment = topSegment(route.routePath);
  if (EXCLUDED.has(segment)) continue;
  const nested = route.hasChildren || route.routePath.split("/").filter(Boolean).length > 1;
  requiredSegments.set(segment, (requiredSegments.get(segment) ?? false) || nested);
}

describe("dashboard SPA routes are reachable by URL", () => {
  it("finds the router's root-level routes", () => {
    // A parse failure here would make every assertion below vacuous.
    expect(requiredSegments.size).toBeGreaterThanOrEqual(4);
    expect(requiredSegments.get("/projects")).toBe(true);
    expect(requiredSegments.get("/onboarding")).toBe(true);
    expect(requiredSegments.get("/login")).toBe(false);
  });

  for (const [label, relativePath] of [
    ["the deployed Worker", "apps/worker/wrangler.jsonc"],
    ["the self-host template", "infra/template/wrangler.jsonc"],
    ["the integrated dev server", "apps/dashboard/vite.config.ts"],
  ]) {
    it(`routes every SPA path to the Worker in ${label}`, () => {
      const source = read(relativePath);
      for (const [segment, nested] of requiredSegments) {
        expect(source, `${relativePath} is missing "${segment}"`).toContain(`"${segment}"`);
        if (nested) {
          expect(source, `${relativePath} is missing "${segment}/*"`).toContain(`"${segment}/*"`);
        }
      }
    });
  }

  it("serves the app shell for every SPA path in the Worker", () => {
    for (const [segment, nested] of requiredSegments) {
      expect(appShellSource, `isDashboardAppRoute is missing "${segment}"`).toContain(
        `pathname === "${segment}"`,
      );
      if (nested) {
        expect(appShellSource, `isDashboardAppRoute is missing "${segment}/"`).toContain(
          `pathname.startsWith("${segment}/")`,
        );
      }
    }
  });

  it("keeps the development-only labs out of production routing", () => {
    for (const relativePath of [
      "apps/worker/wrangler.jsonc",
      "infra/template/wrangler.jsonc",
      "apps/worker/src/app-shell.ts",
    ]) {
      expect(read(relativePath), relativePath).not.toContain("local-labs");
    }
  });
});
