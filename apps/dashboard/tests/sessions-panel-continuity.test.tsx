// @vitest-environment happy-dom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ShapeProvider } from "../src/lib/shape-context";
import { SessionsPanel } from "../src/routes/sessions/sessions-panel";

const navigate = vi.fn();

// happy-dom does not provide this Web Animations API method. Base UI checks
// it after scroll-area layout, even when the test has already asserted.
Object.defineProperty(Element.prototype, "getAnimations", {
  configurable: true,
  value: () => [],
});

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
  useSearch: () => ({}),
}));

describe("sessions panel continuity", () => {
  afterEach(() => {
    navigate.mockClear();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    document.body.replaceChildren();
  });

  it("keeps a provisional session head visible when the warehouse is unavailable", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);

      if (url.includes("/session-heads")) {
        return jsonResponse({ sessions: [provisionalSessionHead()] });
      }
      if (url.includes("/sessions")) {
        return jsonResponse({ error: "warehouse_unavailable" }, 503);
      }
      if (url.includes("/stats")) {
        return jsonResponse({ breakdowns: { country: [] } });
      }

      throw new Error(`Unexpected dashboard request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    window.localStorage.setItem("or:token", "test-dashboard-token");

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, refetchOnWindowFocus: false },
      },
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ShapeProvider defaultShape="rounded">
            <SessionsPanel isDemo={false} projectId="project-1" />
          </ShapeProvider>
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      await vi.waitFor(() => {
        expect(container.querySelector('[data-session-id="session-head-1"]')).not.toBeNull();
      });
    });

    const sessionCard = container.querySelector<HTMLElement>('[data-session-id="session-head-1"]');
    expect(sessionCard?.textContent).toContain("/checkout");
    expect(sessionCard?.textContent).toContain("Final details pending");
    expect(sessionCard?.textContent).toContain("0:05");
    expect(sessionCard?.textContent).not.toContain("0 clicks");
    expect(sessionCard?.textContent).not.toContain("0 errors");
    expect(sessionCard?.textContent).not.toContain("0 rage");
    expect(sessionCard?.textContent).not.toContain("Metadata only");

    const requestedUrls = fetchMock.mock.calls.map(([input]) => requestUrl(input));
    expect(requestedUrls.some((url) => url.includes("/sessions?"))).toBe(true);
    expect(requestedUrls.some((url) => url.includes("/session-heads?"))).toBe(true);
    const headUrl = new URL(
      requestedUrls.find((url) => url.includes("/session-heads?")) ?? "",
      "https://dashboard.test",
    );
    const openedAt = Number(headUrl.searchParams.get("opened_at"));
    const warehouseTo = Number(headUrl.searchParams.get("warehouse_to"));
    expect(openedAt).toBeGreaterThan(0);
    expect(warehouseTo).toBeGreaterThan(0);
    expect(warehouseTo).toBeLessThanOrEqual(openedAt);

    await act(async () => root.unmount());
    queryClient.clear();
  });
});

function provisionalSessionHead() {
  return {
    session_id: "session-head-1",
    project_id: "project-1",
    org_id: "org-1",
    started_at: Date.now() - 5_000,
    ended_at: Date.now(),
    duration_ms: 5_000,
    country: "US",
    region: null,
    city: "New York",
    device: "desktop",
    browser: "Chrome",
    os: "macOS",
    entry_url: "https://shop.example/checkout",
    url_count: 0,
    page_count: 0,
    analytics_version: 0,
    max_scroll_depth: null,
    quick_backs: null,
    interaction_time_ms: null,
    activity_hist: null,
    clicks: 0,
    errors: 0,
    rages: 0,
    navs: 0,
    bytes: 0,
    segment_count: 0,
    flags: 0,
    manifest_key: "",
    expires_at: Date.now() + 60_000,
    activity: "idle",
    details_state: "provisional",
    replay_source: "live",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
