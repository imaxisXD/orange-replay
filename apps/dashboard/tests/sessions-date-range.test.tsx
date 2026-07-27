// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { SessionsViewSearch } from "../src/lib/sessions-view-search";
import { clearDashboardAccess } from "../src/lib/dashboard-access";
import { ShapeProvider } from "../src/lib/shape-context";
import { SessionsPanel } from "../src/routes/sessions/sessions-panel";

const navigate = vi.fn();
let routeSearch: SessionsViewSearch = {};

// Number Flow relies on browser custom-element animation hooks happy-dom lacks.
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

// happy-dom does not provide this Web Animations API method that Base UI calls.
Object.defineProperty(Element.prototype, "getAnimations", {
  configurable: true,
  value: () => [],
});

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
  useSearch: () => routeSearch,
}));

const day = 86_400_000;
const twentyEightDays = 28 * day;

describe("sessions date range and pin lifecycle", () => {
  afterEach(() => {
    navigate.mockClear();
    vi.unstubAllGlobals();
    clearDashboardAccess();
    routeSearch = {};
    window.history.replaceState({}, "", "/");
    document.body.replaceChildren();
  });

  it("shows readable toolbar labels with matching icons", async () => {
    const { container, teardown } = await renderPanel({
      isDemo: false,
      sessions: [finalizedSession("session-a")],
    });

    const filterHeading = container.querySelector<HTMLElement>("#sessions-filter-heading");
    expect(filterHeading?.textContent).toContain("Filters");
    expect(filterHeading?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(filterHeading?.classList).toContain("col-span-2");

    const trigger = container.querySelector<HTMLElement>('[aria-label="Date range"]');
    expect(trigger?.textContent).toContain("Last 24 hours");
    expect(trigger?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(trigger?.classList).toContain("sm:w-40");
    expect(trigger?.classList).toContain("sm:shrink-0");

    const countryTrigger = container.querySelector<HTMLElement>('[aria-label="Country"]');
    expect(countryTrigger?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(countryTrigger?.classList).toContain("sm:w-44");

    const durationTrigger = container.querySelector<HTMLElement>('[aria-label="Minimum duration"]');
    expect(durationTrigger?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(durationTrigger?.classList).toContain("sm:w-44");

    const errorLabel = findSwitchLabel(container, "Errors only");
    const errorIcon = errorLabel?.querySelector<SVGElement>('svg[aria-hidden="true"]');
    expect(errorIcon).not.toBeNull();
    expect(errorIcon?.classList).toContain("text-danger/70");
    expect(errorLabel?.nextElementSibling?.getAttribute("role")).toBe("switch");
    expect(errorLabel?.parentElement?.classList).toContain("sm:ml-auto");

    const rageLabel = findSwitchLabel(container, "Rage clicks only");
    const rageIcon = rageLabel?.querySelector<SVGElement>('svg[aria-hidden="true"]');
    expect(rageIcon).not.toBeNull();
    expect(rageIcon?.classList).toContain("text-amber/70");
    expect(rageLabel?.nextElementSibling?.getAttribute("role")).toBe("switch");

    expect(container.textContent).not.toContain("1 session");
    expect(container.querySelector('[aria-label="Refresh sessions"]')).toBeNull();

    await act(async () => trigger?.click());
    expect(
      [...document.querySelectorAll('[role="option"][data-value]')].map((option) =>
        option.textContent?.trim(),
      ),
    ).toEqual(["Last 24 hours", "Last 3 days", "Last 7 days", "Last 28 days"]);

    await teardown();
  });

  it("preserves the doorway pin on selection but drops it on a lens mutation", async () => {
    const now = Date.now();
    routeSearch = { from: now - day, to: now, warehouse_version: 5, has_errors: true };
    const { container, teardown } = await renderPanel({
      isDemo: false,
      sessions: [finalizedSession("session-a")],
    });

    await act(async () => {
      await vi.waitFor(() => {
        expect(container.querySelector('[data-session-id="session-a"]')).not.toBeNull();
      });
    });

    // Selection is view-only: the exact doorway snapshot must survive it.
    await act(async () => {
      container.querySelector<HTMLElement>('[data-session-id="session-a"]')?.click();
    });
    const selectCall = lastCallWith((search) => search.selected === "session-a");
    expect(selectCall.warehouse_version).toBe(5);
    expect(selectCall.has_errors).toBe(true);

    // A toolbar lens change is a SessionFilter mutation: the pin drops, the
    // window and existing lenses stay.
    await act(async () => {
      clickSwitch(container, "Rage clicks only");
    });
    const mutateCall = lastCallWith((search) => search.has_rage === true);
    expect(mutateCall.warehouse_version).toBeUndefined();
    expect(mutateCall.has_errors).toBe(true);
    expect(mutateCall.from).toBe(now - day);
    expect(mutateCall.to).toBe(now);

    await teardown();
  });

  it("shows the filtered empty state and clears to the date range only", async () => {
    const now = Date.now();
    routeSearch = { from: now - day, to: now, warehouse_version: 5, has_errors: true };
    const { container, teardown } = await renderPanel({ isDemo: false, sessions: [] });

    await act(async () => {
      await vi.waitFor(() => {
        expect(container.textContent).toContain("No sessions match these filters");
      });
    });
    expect(container.textContent).not.toContain("No sessions yet");
    expect(container.textContent).not.toContain("Install the snippet");

    await act(async () => {
      clickButton(container, "Clear filters");
    });
    const clearCall = lastCall();
    expect(clearCall.from).toBe(now - day);
    expect(clearCall.to).toBe(now);
    expect(clearCall.warehouse_version).toBeUndefined();
    expect(clearCall.has_errors).toBeUndefined();

    await teardown();
  });

  it("offers Show last 28 days on a short window and widens on click", async () => {
    routeSearch = {};
    const { container, teardown } = await renderPanel({
      isDemo: false,
      sessions: [],
      heads: [],
    });

    await act(async () => {
      await vi.waitFor(() => {
        expect(container.textContent).toContain("No sessions in this date range");
      });
    });
    expect(container.textContent).not.toContain("No sessions yet");
    expect(container.querySelectorAll('img[src*="date-range-owl"]')).toHaveLength(1);
    expect(container.textContent).not.toContain("The rooster has the reel");
    expect(container.textContent).not.toContain("Nothing to watch yet");
    expect(
      container
        .querySelector("[data-session-workspace]")
        ?.getAttribute("data-session-layout-state"),
    ).toBe("empty");

    // The default rolling window drives the outgoing request even with no URL.
    const listUrl = requestedUrls().find((url) => url.includes("/sessions?"));
    expect(listUrl).toBeDefined();
    const listParams = new URL(listUrl ?? "", "https://dashboard.test").searchParams;
    expect(Number(listParams.get("to")) - Number(listParams.get("from"))).toBe(day);

    await act(async () => {
      clickButton(container, "Show last 28 days");
    });
    const widenCall = lastCall();
    expect(widenCall.warehouse_version).toBeUndefined();
    expect((widenCall.to ?? 0) - (widenCall.from ?? 0)).toBe(twentyEightDays);

    await teardown();
  });

  it("keeps a quiet workspace footprint while the first session request loads", async () => {
    const sessionResponse = deferred<object>();
    const { container, teardown } = await renderPanel({
      isDemo: false,
      sessions: [],
      heads: [],
      sessionsResponder: () => sessionResponse.promise,
    });

    const loadingWorkspace = container.querySelector<HTMLElement>("[data-session-workspace]");
    expect(loadingWorkspace?.dataset.sessionLayoutState).toBe("loading");
    expect(loadingWorkspace?.style.height).toBe("690px");
    expect(loadingWorkspace?.getAttribute("aria-busy")).toBe("true");
    expect(container.querySelectorAll('[data-slot="loading-indicator"]')).toHaveLength(0);
    expect(container.querySelector('img[src*="date-range-owl"]')).toBeNull();
    expect(container.textContent).not.toContain("The rooster has the reel");

    await act(async () => {
      sessionResponse.resolve({
        sessions: [finalizedSession("session-after-loading")],
        nextBefore: null,
      });
      await sessionResponse.promise;
    });
    await waitForCard(container, "session-after-loading");

    const resultsWorkspace = container.querySelector<HTMLElement>("[data-session-workspace]");
    expect(resultsWorkspace).toBe(loadingWorkspace);
    expect(resultsWorkspace?.dataset.sessionLayoutState).toBe("results");
    expect(resultsWorkspace?.style.height).toBe("690px");
    expect(resultsWorkspace?.getAttribute("aria-busy")).toBe("false");
    expect(container.querySelectorAll('[data-slot="loading-indicator"]')).toHaveLength(0);
    expect(container.textContent).toContain("The rooster has the reel");

    await teardown();
  });

  it("omits the widen action on a 28-day window", async () => {
    const now = Date.now();
    routeSearch = { from: now - twentyEightDays, to: now };
    const { container, teardown } = await renderPanel({
      isDemo: false,
      sessions: [],
      heads: [],
    });

    await act(async () => {
      await vi.waitFor(() => {
        expect(container.textContent).toContain("No sessions in this date range");
      });
    });
    expect(hasButton(container, "Show last 28 days")).toBe(false);

    await teardown();
  });

  it("preserves the doorway pin on sort and Unwatched, then drops it on a lens mutation", async () => {
    const now = Date.now();
    routeSearch = { from: now - day, to: now, warehouse_version: 5, country: "US" };
    const { container, teardown } = await renderPanel({
      isDemo: false,
      sessions: [finalizedSession("session-a")],
    });
    await waitForCard(container, "session-a");

    // Toggling Unwatched is view-only: the exact doorway snapshot, window, and
    // lens all survive.
    await act(async () => {
      clickSwitch(container, "Unwatched");
    });
    const unwatchedCall = lastCallWith((search) => search.unwatched === true);
    expect(unwatchedCall.warehouse_version).toBe(5);
    expect(unwatchedCall.country).toBe("US");
    expect(unwatchedCall.from).toBe(now - day);

    // Changing sort is also view-only for the doorway pin.
    await selectOption(container, "Sort sessions", "Most friction");
    const sortCall = lastCallWith((search) => search.sort === "friction");
    expect(sortCall.warehouse_version).toBe(5);
    expect(sortCall.country).toBe("US");
    expect(sortCall.from).toBe(now - day);

    // A following SessionFilter mutation drops the pin but keeps window + lens.
    await act(async () => {
      clickSwitch(container, "Rage clicks only");
    });
    const mutateCall = lastCallWith((search) => search.has_rage === true);
    expect(mutateCall.warehouse_version).toBeUndefined();
    expect(mutateCall.country).toBe("US");
    expect(mutateCall.from).toBe(now - day);

    await teardown();
  });

  it("sends the response-derived version and cursor on later pages, URL stays unpinned", async () => {
    const now = Date.now();
    // Unpinned URL (no warehouse_version); a lens keeps the head overlay off.
    routeSearch = { from: now - day, to: now, has_errors: true };
    const { container, teardown } = await renderPanel({
      isDemo: false,
      sessions: [],
      sessionsResponder: (url) =>
        url.searchParams.get("before") === "cursor-1"
          ? { sessions: [finalizedSession("s-2")], nextBefore: null, warehouseVersion: 15 }
          : { sessions: [finalizedSession("s-1")], nextBefore: "cursor-1", warehouseVersion: 15 },
    });
    await waitForCard(container, "s-1");

    await act(async () => {
      clickButton(container, "Load more");
    });
    await waitForCard(container, "s-2");

    const requests = listRequests();
    const page1 = requests.find((url) => url.searchParams.get("before") === null);
    const page2 = requests.find((url) => url.searchParams.get("before") === "cursor-1");
    expect(page1?.searchParams.has("warehouse_version")).toBe(false);
    expect(page2?.searchParams.get("warehouse_version")).toBe("15");
    expect(page2?.searchParams.get("before")).toBe("cursor-1");
    // Load more never navigates, so URL search never gains warehouse_version.
    expect(navigate.mock.calls.length).toBe(0);

    await teardown();
  });

  it("keeps the exact doorway version on every later page", async () => {
    const now = Date.now();
    routeSearch = { from: now - day, to: now, warehouse_version: 5, has_errors: true };
    const { container, teardown } = await renderPanel({
      isDemo: false,
      sessions: [],
      sessionsResponder: (url) =>
        url.searchParams.get("before") === "cursor-1"
          ? { sessions: [finalizedSession("d-2")], nextBefore: null, warehouseVersion: 5 }
          : { sessions: [finalizedSession("d-1")], nextBefore: "cursor-1", warehouseVersion: 5 },
    });
    await waitForCard(container, "d-1");

    await act(async () => {
      clickButton(container, "Load more");
    });
    await waitForCard(container, "d-2");

    const requests = listRequests();
    const page1 = requests.find((url) => url.searchParams.get("before") === null);
    const page2 = requests.find((url) => url.searchParams.get("before") === "cursor-1");
    expect(page1?.searchParams.get("warehouse_version")).toBe("5");
    expect(page2?.searchParams.get("warehouse_version")).toBe("5");

    await teardown();
  });

  it("requests and renders different rows on the two sides of the 24h/7d boundary", async () => {
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    const recent = finalizedSession("recent", now - 12 * 60 * 60 * 1000);
    const older = finalizedSession("older", now - 3 * day);
    const responder = (url: URL): object => {
      const from = Number(url.searchParams.get("from"));
      return {
        sessions: [recent, older].filter((session) => session.started_at >= from),
        nextBefore: null,
        warehouseVersion: 12,
      };
    };

    routeSearch = { from: now - day, to: now };
    const first = await renderPanel({
      isDemo: false,
      sessions: [],
      heads: [],
      sessionsResponder: responder,
    });
    await waitForCard(first.container, "recent");
    expect(first.container.querySelector('[data-session-id="older"]')).toBeNull();
    const from24 = listRequests()[0]?.searchParams.get("from");
    await first.teardown();

    navigate.mockClear();
    routeSearch = { from: now - 7 * day, to: now };
    const second = await renderPanel({
      isDemo: false,
      sessions: [],
      heads: [],
      sessionsResponder: responder,
    });
    await waitForCard(second.container, "older");
    expect(second.container.querySelector('[data-session-id="recent"]')).not.toBeNull();
    const from7 = listRequests()[0]?.searchParams.get("from");
    await second.teardown();

    expect(Number(from24)).toBe(now - day);
    expect(Number(from7)).toBe(now - 7 * day);
    expect(from24).not.toBe(from7);
  });
});

interface RenderOptions {
  isDemo: boolean;
  sessions: ReturnType<typeof finalizedSession>[];
  heads?: unknown[];
  // Overrides the /sessions list response per request (used for pagination and
  // boundary tests that vary the response by cursor or window).
  sessionsResponder?: (url: URL) => object | Promise<object>;
}

async function renderPanel(
  options: RenderOptions,
): Promise<{ container: HTMLElement; root: Root; teardown: () => Promise<void> }> {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url.includes("/session-heads")) {
      return jsonResponse({ sessions: options.heads ?? [] });
    }
    if (/\/sessions\?/.test(url) || url.endsWith("/sessions")) {
      if (options.sessionsResponder !== undefined) {
        return jsonResponse(
          await options.sessionsResponder(new URL(url, "https://dashboard.test")),
        );
      }
      return jsonResponse({ sessions: options.sessions, nextBefore: null });
    }
    if (url.includes("/stats")) {
      return jsonResponse({ breakdowns: { country: [] } });
    }
    throw new Error(`Unexpected dashboard request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ShapeProvider defaultShape="rounded">
          <SessionsPanel isDemo={options.isDemo} projectId="project-1" />
        </ShapeProvider>
      </QueryClientProvider>,
    );
  });

  return {
    container,
    root,
    teardown: async () => {
      await act(async () => root.unmount());
      queryClient.clear();
    },
  };
}

function lastCall(): SessionsViewSearch {
  const call = navigate.mock.calls.at(-1)?.[0] as { search?: SessionsViewSearch } | undefined;
  return call?.search ?? {};
}

function lastCallWith(match: (search: SessionsViewSearch) => boolean): SessionsViewSearch {
  for (let index = navigate.mock.calls.length - 1; index >= 0; index -= 1) {
    const call = navigate.mock.calls[index]?.[0] as { search?: SessionsViewSearch } | undefined;
    if (call?.search !== undefined && match(call.search)) {
      return call.search;
    }
  }
  throw new Error("No navigate call matched the predicate");
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === text,
  );
}

function hasButton(container: HTMLElement, text: string): boolean {
  return findButton(container, text) !== undefined;
}

function clickButton(container: HTMLElement, text: string): void {
  const button = findButton(container, text);
  if (button === undefined) throw new Error(`Button not found: ${text}`);
  button.click();
}

async function waitForCard(container: HTMLElement, sessionId: string): Promise<void> {
  await act(async () => {
    await vi.waitFor(() => {
      expect(container.querySelector(`[data-session-id="${sessionId}"]`)).not.toBeNull();
    });
  });
}

function listRequests(): URL[] {
  return requestedUrls()
    .filter((url) => /\/sessions\?/.test(url))
    .map((url) => new URL(url, "https://dashboard.test"));
}

async function selectOption(
  container: HTMLElement,
  triggerLabel: string,
  optionText: string,
): Promise<void> {
  const trigger = container.querySelector<HTMLElement>(`[aria-label="${triggerLabel}"]`);
  if (trigger === null) throw new Error(`Select trigger not found: ${triggerLabel}`);
  await act(async () => trigger.click());
  const option = [...document.querySelectorAll('[role="option"]')].find(
    (item) => item.textContent?.trim() === optionText,
  );
  if (option === undefined) throw new Error(`Option not found: ${optionText}`);
  await act(async () => (option as HTMLElement).click());
}

function clickSwitch(container: HTMLElement, label: string): void {
  const labelSpan = findSwitchLabel(container, label);
  const control = labelSpan
    ? container.querySelector<HTMLElement>(`[aria-labelledby="${labelSpan.id}"]`)
    : null;
  if (control === null || control === undefined) throw new Error(`Switch not found: ${label}`);
  control.click();
}

function findSwitchLabel(container: HTMLElement, label: string): HTMLSpanElement | undefined {
  return [...container.querySelectorAll<HTMLSpanElement>("span[id]")].find(
    (span) => span.textContent === label,
  );
}

function finalizedSession(sessionId: string, startedAt?: number) {
  const started = startedAt ?? Date.now() - 50_000;
  const endedAt = started + 45_000;
  return {
    session_id: sessionId,
    project_id: "project-1",
    org_id: "org-1",
    started_at: started,
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
    manifest_key: `p/project-1/${sessionId}/manifest.json`,
    expires_at: endedAt + 86_400_000,
    has_checkpoint: true,
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

function requestedUrls(): string[] {
  const fetchMock = globalThis.fetch as unknown as {
    mock: { calls: [string | URL | Request][] };
  };
  return fetchMock.mock.calls.map(([input]) => requestUrl(input));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}
