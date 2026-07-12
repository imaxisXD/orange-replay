import { encodeSessionFilter } from "@orange-replay/shared";
import { describe, expect, it } from "vite-plus/test";
import type { ProjectStats } from "../src/api/stats.ts";
import {
  authHeaders,
  entryPageProjectId,
  getSessions,
  listProjectId,
  presenceRemove,
  sameTimeProjectId,
  setupApiTestWorkers,
  worker,
} from "./api-test-helpers.ts";

setupApiTestWorkers();

describe("dashboard api", () => {
  it("lists sessions newest first and applies filters", async () => {
    const all = await getSessions();
    expect(all.sessions.map((session) => session.session_id)).toEqual([
      "api_new",
      "api_mid",
      "api_old",
    ]);
    // Short page (3 rows < default limit) means the list is exhausted — no cursor.
    expect(all.nextBefore).toBeNull();
    const firstPage = await getSessions("limit=2");
    expect(firstPage.sessions.map((session) => session.session_id)).toEqual(["api_new", "api_mid"]);
    expect(firstPage.nextBefore).toBe("2000:api_mid");
    const secondPage = await getSessions(`limit=2&before=${firstPage.nextBefore}`);
    expect(secondPage.sessions.map((session) => session.session_id)).toEqual(["api_old"]);
    expect(secondPage.nextBefore).toBeNull();
    expect(all.sessions.find((session) => session.session_id === "api_old")?.page_count).toBeNull();
    expect(
      all.sessions.find((session) => session.session_id === "api_old")?.analytics_version,
    ).toBe(0);
    expect(all.sessions.find((session) => session.session_id === "api_new")?.page_count).toBe(1);
    expect(
      all.sessions.find((session) => session.session_id === "api_new")?.analytics_version,
    ).toBe(2);

    const withErrors = await getSessions("has_errors=1");
    expect(withErrors.sessions.map((session) => session.session_id)).toEqual([
      "api_new",
      "api_mid",
    ]);

    const longSessions = await getSessions("min_duration_ms=2000");
    expect(longSessions.sessions.map((session) => session.session_id)).toEqual(["api_new"]);

    const chromeInUs = await getSessions("country=US&browser=Chrome");
    expect(chromeInUs.sessions.map((session) => session.session_id)).toEqual([
      "api_new",
      "api_old",
    ]);

    const noErrors = await getSessions("has_errors=0");
    expect(noErrors.sessions.map((session) => session.session_id)).toEqual(["api_old"]);

    const withRage = await getSessions("has_rage=1");
    expect(withRage.sessions.map((session) => session.session_id)).toEqual(["api_new"]);

    const withQuickBacks = await getSessions("has_quick_back=1");
    expect(withQuickBacks.sessions.map((session) => session.session_id)).toEqual(["api_new"]);

    const withInsights = await getSessions("has_insights=1");
    expect(withInsights.sessions.map((session) => session.session_id)).toEqual([
      "api_new",
      "api_mid",
    ]);

    const withPageCoverage = await getSessions("has_page_coverage=1");
    expect(withPageCoverage.sessions.map((session) => session.session_id)).toEqual([
      "api_new",
      "api_mid",
    ]);

    const checkoutFailure = await getSessions("error_detail=Checkout+failed");
    expect(checkoutFailure.sessions.map((session) => session.session_id)).toEqual([
      "api_new",
      "api_mid",
    ]);

    const exactEntry = await getSessions("entry_url=%2Fpricing");
    expect(exactEntry.sessions.map((session) => session.session_id)).toEqual(["api_mid"]);

    const bounded = await getSessions("from=2000&to=3000");
    expect(bounded.sessions.map((session) => session.session_id)).toEqual(["api_new", "api_mid"]);

    const fullFilter = await getSessions(
      "from=2500&to=3500&country=US&region=NY&device=desktop&browser=Chrome&os=macOS&entry_url_prefix=%2Fcheckout&has_errors=1&min_duration_ms=2000",
    );
    expect(fullFilter.sessions.map((session) => session.session_id)).toEqual(["api_new"]);
  });

  it("sorts and follows the cursor for every sessions sort", async () => {
    const cases = [
      {
        sort: "newest",
        order: ["api_new", "api_mid", "api_old"],
        firstPageCursor: "2000:api_mid",
      },
      {
        sort: "friction",
        order: ["api_mid", "api_new", "api_old"],
        firstPageCursor: "friction:1102:api_new",
      },
      {
        sort: "duration",
        order: ["api_new", "api_old", "api_mid"],
        firstPageCursor: "duration:1500:api_old",
      },
      {
        sort: "clicks",
        order: ["api_old", "api_new", "api_mid"],
        firstPageCursor: "clicks:2:api_new",
      },
      {
        sort: "pages",
        order: ["api_mid", "api_new", "api_old"],
        firstPageCursor: "pages:1:api_new",
      },
    ] as const;

    for (const testCase of cases) {
      const all = await getSessions(`sort=${testCase.sort}`);
      expect(all.sessions.map((session) => session.session_id)).toEqual(testCase.order);
      expect(all.nextBefore).toBeNull();

      const firstPage = await getSessions(`sort=${testCase.sort}&limit=2`);
      expect(firstPage.sessions.map((session) => session.session_id)).toEqual(
        testCase.order.slice(0, 2),
      );
      expect(firstPage.nextBefore).toBe(testCase.firstPageCursor);

      const secondPage = await getSessions(
        `sort=${testCase.sort}&limit=2&before=${encodeURIComponent(testCase.firstPageCursor)}`,
      );
      expect(secondPage.sessions.map((session) => session.session_id)).toEqual(
        testCase.order.slice(2),
      );
      expect(secondPage.nextBefore).toBeNull();
    }
  });

  it("rejects an invalid sort and a cursor from another sort", async () => {
    const invalidSort = await worker.fetch(
      `/api/v1/projects/${listProjectId}/sessions?sort=oldest`,
      { headers: authHeaders() },
    );
    expect(invalidSort.status).toBe(400);
    expect(await invalidSort.json()).toEqual({ error: "invalid_sort" });

    const durationPage = await getSessions("sort=duration&limit=2");
    expect(durationPage.nextBefore).toBe("duration:1500:api_old");
    const mismatch = await worker.fetch(
      `/api/v1/projects/${listProjectId}/sessions?sort=clicks&before=${encodeURIComponent(durationPage.nextBefore ?? "")}`,
      { headers: authHeaders() },
    );
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toEqual({ error: "invalid_before" });
  });

  it("rejects invalid session filters", async () => {
    for (const query of ["from=after", "from=3000&to=2000", "has_errors=yes"]) {
      const res = await worker.fetch(`/api/v1/projects/${listProjectId}/sessions?${query}`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(400);
    }
  });

  it("returns exact finalized aggregates and fresh live presence", async () => {
    const res = await worker.fetch(`/api/v1/projects/${listProjectId}/stats`, {
      headers: authHeaders(),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const stats = (await res.json()) as ProjectStats;
    expect(stats.sessions).toEqual({ value: 3, filter: {} });
    expect(stats.duration.average).toEqual({ value: 1500, filter: {} });
    expect(stats.duration.p50).toEqual({ value: 1500, filter: {} });
    expect(stats.clicks).toEqual({ value: 6, filter: {} });
    expect(stats.pagesPerSession).toEqual({
      value: 1.5,
      filter: { has_page_coverage: true },
      includedSessions: { value: 2, filter: { has_page_coverage: true } },
      totalSessions: { value: 3, filter: {} },
    });
    expect(stats.insights).toEqual({
      ragePercent: { value: 0.5, filter: { has_rage: true } },
      quickBackPercent: { value: 0.5, filter: { has_quick_back: true } },
      averageInteractionTimeMs: { value: 5_000, filter: { has_insights: true } },
      averageMaxScrollDepth: { value: 75, filter: { has_insights: true } },
      includedSessions: { value: 2, filter: { has_insights: true } },
      totalSessions: { value: 3, filter: {} },
    });
    expect(stats.liveNow).toEqual({ value: 1, filter: {} });
    expect(stats.breakdowns.country.map((row) => [row.label, row.count.value])).toEqual([
      ["US", 2],
      ["IN", 1],
    ]);
    expect(
      stats.errors.map((group) => [group.detail, group.count.value, group.affectedSessions.value]),
    ).toEqual([
      ["Checkout failed", 2, 2],
      ["Network timeout", 1, 1],
    ]);
    expect(stats.errors[0]?.filter).toEqual({ error_detail: "Checkout failed" });

    await presenceRemove(listProjectId, "api_stats_live");
    const afterPresenceChange = await worker.fetch(`/api/v1/projects/${listProjectId}/stats`, {
      headers: authHeaders(),
    });
    expect(afterPresenceChange.status).toBe(200);
    const refreshedLive = (await afterPresenceChange.json()) as ProjectStats;
    expect(refreshedLive.sessions.value).toBe(3);
    expect(refreshedLive.liveNow.value).toBe(0);
  });

  it("keeps a breakdown row set-equal with the sessions endpoint", async () => {
    const statsResponse = await worker.fetch(`/api/v1/projects/${listProjectId}/stats`, {
      headers: authHeaders(),
    });
    expect(statsResponse.status).toBe(200);
    const stats = (await statsResponse.json()) as ProjectStats;
    const countryRow = stats.breakdowns.country.find((row) => row.label === "US");
    expect(countryRow).toBeDefined();
    if (countryRow === undefined) return;

    const sessions = await getSessions(encodeSessionFilter(countryRow.filter).toString());
    expect(sessions.sessions).toHaveLength(countryRow.count.value);
    expect(sessions.sessions.every((session) => session.country === "US")).toBe(true);
  });

  it("keeps the rage insight set-equal with the sessions endpoint", async () => {
    const statsResponse = await worker.fetch(`/api/v1/projects/${listProjectId}/stats`, {
      headers: authHeaders(),
    });
    expect(statsResponse.status).toBe(200);
    const stats = (await statsResponse.json()) as ProjectStats;
    const sessions = await getSessions(
      encodeSessionFilter(stats.insights.ragePercent.filter).toString(),
    );

    expect(sessions.sessions).toHaveLength(1);
    expect(sessions.sessions.every((session) => session.rages > 0)).toBe(true);
  });

  it("keeps page coverage and every error group set-equal with the sessions endpoint", async () => {
    const statsResponse = await worker.fetch(`/api/v1/projects/${listProjectId}/stats`, {
      headers: authHeaders(),
    });
    expect(statsResponse.status).toBe(200);
    const stats = (await statsResponse.json()) as ProjectStats;

    const coveredSessions = await getSessions(
      encodeSessionFilter(stats.pagesPerSession.includedSessions.filter).toString(),
    );
    expect(coveredSessions.sessions).toHaveLength(stats.pagesPerSession.includedSessions.value);
    expect(
      coveredSessions.sessions.every(
        (session) => session.analytics_version >= 1 && session.page_count !== null,
      ),
    ).toBe(true);

    for (const errorGroup of stats.errors) {
      const sessions = await getSessions(encodeSessionFilter(errorGroup.filter).toString());
      expect(sessions.sessions).toHaveLength(errorGroup.affectedSessions.value);
    }
  });

  it("keeps exact entry pages separate when one URL prefixes another", async () => {
    const statsResponse = await worker.fetch(`/api/v1/projects/${entryPageProjectId}/stats`, {
      headers: authHeaders(),
    });
    expect(statsResponse.status).toBe(200);
    const stats = (await statsResponse.json()) as ProjectStats;
    expect(stats.breakdowns.entryPage.map((row) => [row.label, row.count.value])).toEqual([
      ["/shop", 1],
      ["/shop/cart", 1],
    ]);
    expect(stats.breakdowns.entryPage.map((row) => row.share.value)).toEqual([0.5, 0.5]);

    for (const row of stats.breakdowns.entryPage) {
      const sessions = await getSessions(
        encodeSessionFilter(row.filter).toString(),
        entryPageProjectId,
      );
      expect(sessions.sessions).toHaveLength(row.count.value);
      expect(sessions.sessions.every((session) => session.entry_url === row.label)).toBe(true);
    }
  });

  it("rejects unknown stats query params", async () => {
    const res = await worker.fetch(`/api/v1/projects/${listProjectId}/stats?limit=5`, {
      headers: authHeaders(),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_limit" });
  });

  it("paginates sessions with the before cursor", async () => {
    const firstPage = await getSessions("limit=1");
    expect(firstPage.sessions.map((session) => session.session_id)).toEqual(["api_new"]);
    expect(firstPage.nextBefore).toBe("3000:api_new");

    const secondPage = await getSessions(`limit=1&before=${firstPage.nextBefore}`);
    expect(secondPage.sessions.map((session) => session.session_id)).toEqual(["api_mid"]);
    expect(secondPage.nextBefore).toBe("2000:api_mid");
  });

  it("paginates sessions that share the active sort value", async () => {
    for (const sort of ["newest", "friction", "duration", "clicks", "pages"] as const) {
      const seen: string[] = [];
      let before = "";

      for (;;) {
        const cursor = before.length === 0 ? "" : `&before=${encodeURIComponent(before)}`;
        const page = await getSessions(`sort=${sort}&limit=1${cursor}`, sameTimeProjectId);
        const session = page.sessions[0];
        if (session === undefined) break;

        seen.push(session.session_id);
        if (page.nextBefore === null || seen.length >= 3) break;
        before = page.nextBefore;
      }

      expect(seen).toEqual(["same_c", "same_b", "same_a"]);
    }
  });
});
