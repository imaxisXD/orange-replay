// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { ApiError } from "../src/lib/api";
import { dashboardNavItems } from "../src/lib/dashboard-navigation";
import { decideProjectRoute } from "../src/lib/dashboard-access";
import { isDemoPath } from "../src/lib/demo-mode";
import { DemoUnavailableStateContent } from "../src/lib/demo-unavailable-state";

beforeEach(() => {
  window.history.replaceState({}, "", "/");
  window.localStorage.clear();
});

describe("demo routes", () => {
  it("recognizes only the public demo route tree", () => {
    expect(isDemoPath("/demo")).toBe(true);
    expect(isDemoPath("/demo/sessions/session-1")).toBe(true);
    expect(isDemoPath("/projects/demo/sessions")).toBe(false);
    expect(isDemoPath("/demonstration")).toBe(false);
  });

  it("allows public demo reads without a private account", () => {
    expect(
      decideProjectRoute({
        projectId: "demo-project",
        requirement: "view",
        scope: "demo",
      }),
    ).toEqual({ action: "allow" });
  });

  it("hides settings and install navigation", () => {
    expect(dashboardNavItems(true).map((item) => item.label)).toEqual([
      "Overview",
      "Sessions",
      "Live",
    ]);
    expect(dashboardNavItems(false).map((item) => item.label)).toEqual([
      "Overview",
      "Sessions",
      "Live",
      "Settings",
      "Install",
    ]);
    expect(dashboardNavItems(false, false).map((item) => item.label)).toEqual([
      "Overview",
      "Sessions",
      "Live",
    ]);
  });

  it("renders the unavailable state for a missing demo", () => {
    const markup = renderToStaticMarkup(
      <DemoUnavailableStateContent
        actions={<span>Start free</span>}
        brand={<span>Orange Replay</span>}
        error={new ApiError("not_found", 404, "not_found")}
      />,
    );

    expect(markup).toContain("Demo not available");
    expect(markup).toContain("The live demo is not turned on for this deployment.");
    expect(markup).toContain("Start free");
  });
});
