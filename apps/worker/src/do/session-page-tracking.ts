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

interface RebuiltPageAnalytics {
  entryUrl?: string;
  urlCount: number;
  pageCount: number;
  quickBacks: number;
  pageTabs: PageTabState[];
}

/**
 * Rebuilds finalized URL metrics from batches already ordered by tab and
 * sequence. The scratch state stays bounded by MAX_TRACKED_PAGE_TABS and is
 * only committed after every visited batch is known to use the covered format.
 */
export function rebuildFinalPageAnalytics(
  state: {
    entryUrl?: string;
    urlCount: number;
    pageCount: number;
    pageTabs: PageTabState[];
    quickBacks?: number;
  },
  batches: Iterable<StoredPageBatch>,
): void {
  const rebuilt: RebuiltPageAnalytics = {
    urlCount: 0,
    pageCount: 0,
    quickBacks: 0,
    pageTabs: [],
  };
  let hasBatches = false;
  let entryBatch: Pick<StoredPageBatch, "tab" | "seq" | "t0" | "url"> | undefined;
  let previousTab: string | undefined;
  let previousSeq = -1;

  for (const batch of batches) {
    hasBatches = true;
    if (
      previousTab !== undefined &&
      (batch.tab < previousTab || (batch.tab === previousTab && batch.seq <= previousSeq))
    ) {
      throw new Error("Stored page batches are not ordered by tab and sequence.");
    }
    previousTab = batch.tab;
    previousSeq = batch.seq;

    // Older batches did not preserve enough information for an exact rebuild.
    // Leave the stored state untouched rather than mixing coverage levels.
    if (batch.pageAnalyticsVersion !== 1) return;

    const currentUrl = nonEmptyUrl(batch.url);
    if (
      currentUrl !== undefined &&
      (entryBatch === undefined ||
        batch.t0 < entryBatch.t0 ||
        (batch.t0 === entryBatch.t0 &&
          (batch.tab < entryBatch.tab ||
            (batch.tab === entryBatch.tab && batch.seq < entryBatch.seq))))
    ) {
      entryBatch = { tab: batch.tab, seq: batch.seq, t0: batch.t0, url: currentUrl };
    }

    if (currentUrl !== undefined) {
      const lastTabUrl = rebuilt.pageTabs.find((pageTab) => pageTab.tab === batch.tab)?.url;
      if (lastTabUrl !== currentUrl) rebuilt.urlCount += 1;
    }
    updatePageTrackingWithBatch(rebuilt, batch.tab, {
      u: currentUrl,
      t0: batch.t0,
      t1: batch.t1,
      e: batch.events,
    });
  }

  if (!hasBatches) return;
  delete state.entryUrl;
  const entryUrl = nonEmptyUrl(entryBatch?.url);
  if (entryUrl !== undefined) state.entryUrl = entryUrl;
  state.urlCount = rebuilt.urlCount;
  state.pageCount = rebuilt.pageCount;
  state.quickBacks = rebuilt.quickBacks;
  state.pageTabs = rebuilt.pageTabs;
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
