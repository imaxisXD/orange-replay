import { QUICK_BACK_MAX_DWELL_MS } from "@orange-replay/shared";
import type { BatchIndex } from "@orange-replay/shared";

export interface PageTabState {
  tab: string;
  url: string;
  previousUrl?: string;
  enteredAt?: number;
}

export interface StoredPageBatch {
  tab: string;
  seq: number;
  t0: number;
  t1: number;
  url?: string;
  events: BatchIndex["e"];
  pageAnalyticsVersion: 0 | 1;
}

export const MAX_TRACKED_PAGE_TABS = 16;

/** Rebuilds finalized URL metrics in durable per-tab sequence order. */
export function rebuildFinalPageAnalytics(
  state: {
    entryUrl?: string;
    urlCount: number;
    pageCount: number;
    pageTabs: PageTabState[];
    quickBacks?: number;
  },
  batches: readonly StoredPageBatch[],
): void {
  delete state.entryUrl;
  state.urlCount = 0;
  state.pageCount = 0;
  state.quickBacks = 0;
  state.pageTabs = [];

  const entryBatch = batches
    .filter((batch) => nonEmptyUrl(batch.url) !== undefined)
    .toSorted(
      (left, right) =>
        left.t0 - right.t0 || left.tab.localeCompare(right.tab) || left.seq - right.seq,
    )[0];
  state.entryUrl = nonEmptyUrl(entryBatch?.url);

  for (const batch of batches.toSorted(
    (left, right) => left.tab.localeCompare(right.tab) || left.seq - right.seq,
  )) {
    const currentUrl = nonEmptyUrl(batch.url);
    if (currentUrl !== undefined) {
      const lastTabUrl = state.pageTabs.find((pageTab) => pageTab.tab === batch.tab)?.url;
      if (lastTabUrl !== currentUrl) state.urlCount += 1;
    }
    updatePageTrackingWithBatch(state, batch.tab, {
      u: currentUrl,
      t0: batch.t0,
      t1: batch.t1,
      e: batch.events,
    });
  }
}

export function updatePageTrackingWithBatch(
  state: { pageCount: number; pageTabs: PageTabState[]; quickBacks?: number },
  tab: string,
  index: Pick<BatchIndex, "u" | "e"> & Partial<Pick<BatchIndex, "t0" | "t1">>,
): void {
  const trackedTabIndex = state.pageTabs.findIndex((tracked) => tracked.tab === tab);
  let trackedTab = trackedTabIndex < 0 ? undefined : state.pageTabs[trackedTabIndex];
  let lastUrl = trackedTab?.url;
  const currentUrl = nonEmptyUrl(index.u);

  for (const [eventIndex, event] of index.e.entries()) {
    if (event.k === "vital" && event.d === "navigation") {
      state.pageCount += 1;
      const hasLaterNavigation = index.e
        .slice(eventIndex + 1)
        .some((laterEvent) => laterEvent.k === "nav" && nonEmptyUrl(laterEvent.d) !== undefined);
      lastUrl = hasLaterNavigation
        ? fullLoadPageMarker(event.t, state.pageCount)
        : (currentUrl ?? lastUrl);
      if (lastUrl !== undefined) {
        trackedTab = trackPageVisit(state, tab, trackedTab, lastUrl, event.t);
      }
      continue;
    }

    if (event.k !== "nav") {
      continue;
    }

    const nextUrl = nonEmptyUrl(event.d);
    if (nextUrl === undefined) {
      continue;
    }

    if (lastUrl === undefined || nextUrl !== lastUrl) {
      state.pageCount += 1;
      trackedTab = trackPageVisit(state, tab, trackedTab, nextUrl, event.t);
    }
    lastUrl = nextUrl;
  }

  if (currentUrl !== undefined && currentUrl !== lastUrl) {
    state.pageCount += 1;
    lastUrl = currentUrl;
    trackedTab = trackPageVisit(state, tab, trackedTab, currentUrl, index.t1 ?? index.t0);
  }

  if (lastUrl === undefined) {
    return;
  }

  if (trackedTabIndex >= 0) {
    state.pageTabs.splice(trackedTabIndex, 1);
  }
  state.pageTabs.push(trackedTab ?? { tab, url: lastUrl });
  if (state.pageTabs.length > MAX_TRACKED_PAGE_TABS) {
    state.pageTabs.splice(0, state.pageTabs.length - MAX_TRACKED_PAGE_TABS);
  }
}

export function normalizeSessionAnalyticsVersion(
  analyticsVersion: unknown,
  storedPageCount: unknown,
): number {
  if (
    typeof analyticsVersion === "number" &&
    Number.isSafeInteger(analyticsVersion) &&
    analyticsVersion >= 0
  ) {
    return analyticsVersion;
  }
  return typeof storedPageCount === "number" &&
    Number.isSafeInteger(storedPageCount) &&
    storedPageCount >= 0
    ? 2
    : 0;
}

export function normalizePageTabs(value: unknown): PageTabState[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const pageTabs: PageTabState[] = [];
  for (const item of value) {
    if (
      typeof item === "object" &&
      item !== null &&
      typeof item.tab === "string" &&
      item.tab.length > 0 &&
      typeof item.url === "string" &&
      item.url.length > 0
    ) {
      const previousUrl =
        typeof item.previousUrl === "string" && item.previousUrl.length > 0
          ? item.previousUrl
          : undefined;
      const enteredAt =
        typeof item.enteredAt === "number" && Number.isFinite(item.enteredAt)
          ? item.enteredAt
          : undefined;
      pageTabs.push({
        tab: item.tab,
        url: item.url,
        ...(previousUrl === undefined ? {} : { previousUrl }),
        ...(enteredAt === undefined ? {} : { enteredAt }),
      });
    }
  }

  return pageTabs.slice(-MAX_TRACKED_PAGE_TABS);
}

function trackPageVisit(
  state: { quickBacks?: number },
  tab: string,
  trackedTab: PageTabState | undefined,
  nextUrl: string,
  enteredAt: number | undefined,
): PageTabState {
  const safeEnteredAt =
    typeof enteredAt === "number" && Number.isFinite(enteredAt) ? enteredAt : undefined;
  if (trackedTab === undefined) {
    return safeEnteredAt === undefined
      ? { tab, url: nextUrl }
      : { tab, url: nextUrl, enteredAt: safeEnteredAt };
  }

  if (nextUrl === trackedTab.url) {
    return safeEnteredAt === undefined ? trackedTab : { ...trackedTab, enteredAt: safeEnteredAt };
  }

  if (
    safeEnteredAt !== undefined &&
    trackedTab.enteredAt !== undefined &&
    trackedTab.previousUrl === nextUrl
  ) {
    const dwellMs = safeEnteredAt - trackedTab.enteredAt;
    if (dwellMs >= 0 && dwellMs < QUICK_BACK_MAX_DWELL_MS) {
      state.quickBacks = (state.quickBacks ?? 0) + 1;
    }
  }

  return {
    tab,
    url: nextUrl,
    previousUrl: trackedTab.url,
    ...(safeEnteredAt === undefined ? {} : { enteredAt: safeEnteredAt }),
  };
}

function nonEmptyUrl(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

function fullLoadPageMarker(time: number, pageCount: number): string {
  return `\u0000full-load:${time}:${pageCount}`;
}
