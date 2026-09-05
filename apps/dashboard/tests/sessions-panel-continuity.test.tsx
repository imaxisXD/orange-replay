// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SessionHead } from "../src/lib/api";
import type { ListSessionsResponse } from "@orange-replay/shared";
import type { SessionsViewSearch } from "../src/lib/sessions-view-search";
import { clearDashboardAccess } from "../src/lib/dashboard-access";
import { ShapeProvider } from "../src/lib/shape-context";
import { SessionsPanel } from "../src/routes/sessions/sessions-panel";

const navigate = vi.fn();
let routeSearch: SessionsViewSearch = {};

// Number Flow relies on browser custom-element animation hooks that happy-dom
// does not implement. Keep this integration test focused on session continuity.
vi.mock("@number-flow/react", () => ({
  default: ({
    format,
    suffix,
    value,
  }: {
    format?: Intl.NumberFormatOptions;
    suffix?: string;
    value: number;
  }) => (
    <span>
      {new Intl.NumberFormat(undefined, format).format(value)}
      {suffix}
    </span>
  ),
  NumberFlowGroup: ({ children }: { children: ReactNode }) => children,
}));

// happy-dom does not provide this Web Animations API method. Base UI checks
// it after scroll-area layout, even when the test has already asserted.
Object.defineProperty(Element.prototype, "getAnimations", {
  configurable: true,
  value: () => [],
});

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
  useSearch: () => routeSearch,
}));

describe("sessions panel continuity", () => {
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_030_000);
  });
  afterEach(() => {
    navigate.mockClear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearDashboardAccess();
    routeSearch = {};
    window.history.replaceState({}, "", "/");
    document.body.replaceChildren();
  });

  it("shows delivery waiting beside healthy session rows", async () => {
    const panel = await renderCountedPanel([finalizedSession()], {
      analyticsState: "fresh",
      analyticsView: "latest",
      analyticsDelivery: {
        state: "pending",
        pendingExports: 2,
        oldestPendingAt: Date.now() - 600_000,
        checkedAt: Date.now(),
      },
    });
    try {
      expect(panel.container.textContent).toContain("Recent analytics are still arriving");
      expect(panel.container.textContent).toContain("2 analytics updates waiting to appear");
      expect(panel.container.querySelector("[data-session-id='session-final-1']")).not.toBeNull();
    } finally {
      await panel.close();
    }
  });

  it("keeps a metric snapshot pinned until Show latest results is pressed", async () => {
    routeSearch = { warehouse_version: 12, country: "US" };
    const panel = await renderCountedPanel([finalizedSession()], {
      analyticsState: "fresh",
      analyticsView: "pinned",
      analyticsDelivery: { state: "pending", pendingExports: 2, oldestPendingAt: 1, checkedAt: 2 },
    });
    try {
      expect(panel.sessionRequests[0]?.searchParams.get("warehouse_version")).toBe("12");
      expect(panel.container.textContent).toContain("Fixed analytics snapshot");
      expect(panel.container.textContent).not.toContain("waiting to appear");
      expect(navigate).not.toHaveBeenCalled();
      const button = Array.from(panel.container.querySelectorAll("button")).find((candidate) =>
        candidate.textContent?.includes("Show latest results"),
      );
      expect(button).toBeDefined();
      await act(async () => button?.click());
      expect(navigate).toHaveBeenLastCalledWith({
        to: "/projects/$projectId/sessions",
        params: { projectId: "project-1" },
        replace: true,
        search: expect.objectContaining({ country: "US", warehouse_version: undefined }),
      });
    } finally {
      await panel.close();
    }
  });

  it("keeps three loaded pages without refetching when an exact head is already present", async () => {
    const session = finalizedSession();
    const panel = await renderCountedPanel([session]);
    try {
      await panel.loadThreePages();
      panel.setHeads([exactSessionHead(session)]);
      const requestsBeforePoll = panel.sessionRequests.length;

      await panel.pollHeads();
      await panel.pollHeads();
      await panel.pollHeads();

      expect(panel.sessionRequests).toHaveLength(requestsBeforePoll);
      expect(panel.container.querySelectorAll("[data-session-id]")).toHaveLength(3);
      expect(
        panel.container.querySelector(`[data-session-id="${session.session_id}"]`),
      ).not.toBeNull();
    } finally {
      await panel.close();
    }
  });

  it("refreshes a missing exact head once, then stops when warehouse rows include it", async () => {
    const session = finalizedSession();
    const panel = await renderCountedPanel([]);
    try {
      panel.setWarehouseSessions([session]);
      panel.setWarehouseVersion(13);
      panel.setHeads([exactSessionHead(session)]);
      const requestsBeforePoll = panel.sessionRequests.length;

      await panel.pollHeads();
      expect(panel.sessionRequests).toHaveLength(requestsBeforePoll + 1);
      expect(
        panel.container.querySelector(`[data-session-id="${session.session_id}"]`),
      ).not.toBeNull();
      await panel.pollHeads();
      await panel.pollHeads();
      expect(panel.sessionRequests).toHaveLength(requestsBeforePoll + 1);
      expect(panel.headRequests.at(-1)?.searchParams.getAll("tracked_session_id")).toEqual([]);
      expect(panel.headRequests.at(-1)?.searchParams.get("warehouse_version")).toBe("13");
    } finally {
      await panel.close();
    }
  });

  it("lets a slow warehouse refresh finish across repeated head polls", async () => {
    const session = finalizedSession();
    const panel = await renderCountedPanel([]);
    const release = panel.holdNextWarehouseResponse();
    try {
      panel.setWarehouseSessions([session]);
      panel.setHeads([exactSessionHead(session)]);
      const requestsBeforePoll = panel.sessionRequests.length;

      await panel.pollHeads(false);
      expect(panel.sessionRequests).toHaveLength(requestsBeforePoll + 1);
      await panel.pollHeads(false);
      expect(panel.sessionRequests).toHaveLength(requestsBeforePoll + 1);
      expect(panel.cancelledRequests).toHaveLength(0);
      await release();
      expect(
        panel.container.querySelector(`[data-session-id="${session.session_id}"]`),
      ).not.toBeNull();
    } finally {
      await release();
      await panel.close();
    }
  });

  it("keeps a newer exact head visible without refetching a date snapshot that cannot contain it", async () => {
    const panel = await renderCountedPanel([]);
    try {
      const warehouseTo = Number(panel.sessionRequests[0]?.searchParams.get("to"));
      const session = { ...finalizedSession(), started_at: warehouseTo + 1 };
      panel.setHeads([exactSessionHead(session)]);
      const requestsBeforePoll = panel.sessionRequests.length;

      await panel.pollHeads();
      await panel.pollHeads();

      expect(panel.sessionRequests).toHaveLength(requestsBeforePoll);
      expect(
        panel.container.querySelector(`[data-session-id="${session.session_id}"]`),
      ).not.toBeNull();
      expect(panel.headRequests.at(-1)?.searchParams.getAll("tracked_session_id")).toEqual([
        session.session_id,
      ]);
      panel.setHeads([]);
      await panel.pollHeads();
      expect(panel.container.querySelector(`[data-session-id="${session.session_id}"]`)).toBeNull();
    } finally {
      await panel.close();
    }
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

  it("shows only finalized recordings in the customer demo", async () => {
    window.history.replaceState({}, "", "/demo/sessions");
    routeSearch = { selected: "session-head-1" };
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = requestUrl(input);

      if (url.includes("/session-heads")) {
        return jsonResponse({ sessions: [provisionalSessionHead()] });
      }
      if (url.includes("/sessions")) {
        return jsonResponse({ sessions: [finalizedSession()], nextBefore: null });
      }
      if (url.includes("/stats")) {
        return jsonResponse({ breakdowns: { country: [] } });
      }

      throw new Error(`Unexpected dashboard request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

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
            <SessionsPanel isDemo projectId="project-1" />
          </ShapeProvider>
        </QueryClientProvider>,
      );
    });

    await act(async () => {
      await vi.waitFor(() => {
        expect(container.querySelector('[data-session-id="session-final-1"]')).not.toBeNull();
      });
    });

    const finalizedCard = container.querySelector<HTMLElement>(
      '[data-session-id="session-final-1"]',
    );
    expect(finalizedCard?.closest("section")?.classList.contains("hidden")).toBe(false);
    expect(container.querySelector('[data-session-id="session-head-1"]')).toBeNull();
    expect(container.textContent).not.toContain("Final details pending");

    const requestedUrls = fetchMock.mock.calls.map(([input]) => requestUrl(input));
    expect(requestedUrls.some((url) => url.includes("/sessions?"))).toBe(true);
    expect(requestedUrls.some((url) => url.includes("/session-heads?"))).toBe(false);
    expect(requestedUrls.some((url) => url.includes("/sessions/session-head-1/state"))).toBe(false);

    await act(async () => root.unmount());
    queryClient.clear();
  });
});

function exactSessionHead(session = finalizedSession()) {
  return {
    ...session,
    activity: "complete",
    details_state: "exact",
    replay_source: "recorded",
  } satisfies SessionHead;
}

async function renderCountedPanel(
  initialSessions: ReturnType<typeof finalizedSession>[],
  analyticsMetadata: Pick<
    ListSessionsResponse,
    "analyticsDelivery" | "analyticsView" | "analyticsState"
  > = {},
) {
  let warehouseSessions = initialSessions;
  let pageCount = 1;
  let warehouseVersion = 12;
  let heldResponse: Promise<void> | undefined;
  let heads: ReturnType<typeof exactSessionHead>[] = [];
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const sessionRequests: URL[] = [];
  const headRequests: URL[] = [];
  const cancelledRequests: URL[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      const url = new URL(requestUrl(input), "https://dashboard.test");
      if (url.pathname.endsWith("/session-heads")) {
        headRequests.push(url);
        return jsonResponse({ sessions: heads });
      }
      if (url.pathname.endsWith("/sessions")) {
        sessionRequests.push(url);
        options?.signal?.addEventListener("abort", () => cancelledRequests.push(url), {
          once: true,
        });
        const wait = heldResponse;
        heldResponse = undefined;
        if (wait !== undefined) await wait;
        const cursor = url.searchParams.get("before");
        const page = cursor === "page-3" ? 2 : cursor === "page-2" ? 1 : 0;
        return jsonResponse({
          sessions:
            page === 0
              ? warehouseSessions
              : [{ ...warehouseSessions[0]!, session_id: `session-final-${page + 1}` }],
          nextBefore: page + 1 < pageCount ? `page-${page + 2}` : null,
          warehouseVersion,
          ...analyticsMetadata,
        });
      }
      if (url.pathname.endsWith("/stats")) return jsonResponse({ breakdowns: { country: [] } });
      throw new Error(`Unexpected dashboard request: ${url.pathname}`);
    }),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await vi.waitFor(() => expect(queryClient.isFetching()).toBe(0));
    });
  };
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <ShapeProvider defaultShape="rounded">
          <SessionsPanel isDemo={false} projectId="project-1" />
        </ShapeProvider>
      </QueryClientProvider>,
    ),
  );
  await settle();

  return {
    container,
    sessionRequests,
    headRequests,
    cancelledRequests,
    setHeads(next: typeof heads) {
      heads = next;
    },
    setWarehouseSessions(next: typeof warehouseSessions) {
      warehouseSessions = next;
    },
    setWarehouseVersion(next: number) {
      warehouseVersion = next;
    },
    holdNextWarehouseResponse() {
      let resolve = () => {};
      heldResponse = new Promise<void>((done) => {
        resolve = done;
      });
      return async () => {
        await act(async () => resolve());
        await settle();
      };
    },
    async loadThreePages() {
      pageCount = 3;
      const query = queryClient.getQueryCache().find({ queryKey: ["sessions"], exact: false });
      expect(query).toBeDefined();
      const first = initialSessions[0]!;
      await act(async () =>
        queryClient.setQueryData(query!.queryKey, {
          pages: [
            { sessions: [first], nextBefore: "page-2", warehouseVersion: 12 },
            {
              sessions: [{ ...first, session_id: "session-final-2" }],
              nextBefore: "page-3",
              warehouseVersion: 12,
            },
            {
              sessions: [{ ...first, session_id: "session-final-3" }],
              nextBefore: null,
              warehouseVersion: 12,
            },
          ],
          pageParams: [
            { before: null },
            { before: "page-2", warehouseVersion: 12 },
            { before: "page-3", warehouseVersion: 12 },
          ],
        }),
      );
      await settle();
    },
    async pollHeads(waitForWarehouse = true) {
      now += 5_000;
      await act(async () => queryClient.refetchQueries({ queryKey: ["session-heads"] }));
      if (waitForWarehouse) await settle();
      else
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
    },
    async close() {
      await act(async () => root.unmount());
      queryClient.clear();
    },
  };
}

function finalizedSession() {
  const endedAt = Date.now() - 5_000;
  return {
    session_id: "session-final-1",
    project_id: "project-1",
    org_id: "org-1",
    started_at: endedAt - 45_000,
    ended_at: endedAt,
    duration_ms: 45_000,
    country: "US",
    region: null,
    city: "New York",
    device: "desktop",
    browser: "Chrome",
    os: "macOS",
    entry_url: "https://shop.example/pricing",
    url_count: 2,
    page_count: 2,
    analytics_version: 1,
    max_scroll_depth: 0.8,
    quick_backs: 0,
    interaction_time_ms: 30_000,
    activity_hist: null,
    clicks: 3,
    errors: 0,
    rages: 0,
    navs: 1,
    bytes: 10_000,
    segment_count: 1,
    flags: 0,
    manifest_key: "p/project-1/session-final-1/manifest.json",
    expires_at: endedAt + 86_400_000,
    has_checkpoint: true,
  };
}

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
    manifest_key: "p/project-1/session-head-1/manifest.json",
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
