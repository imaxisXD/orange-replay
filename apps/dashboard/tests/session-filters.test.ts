import { describe, expect, it } from "vite-plus/test";
import {
  canonicalSessionFilter,
  dateRangeFilter,
  dateRangeSnapshotFilter,
  selectedDateRange,
  validateSessionSearch,
  withDefaultDateRange,
} from "../src/lib/session-filters";

describe("dashboard session filters", () => {
  it("reads the complete shared filter from URL search", () => {
    expect(
      validateSessionSearch({
        from: "1000",
        to: "2000",
        country: "US",
        region: "CA",
        city: "San Francisco",
        device: "desktop",
        browser: "Chrome",
        os: "macOS",
        entry_url: "/checkout/complete",
        entry_url_prefix: "/checkout",
        has_errors: "1",
        error_detail: "Checkout failed",
        has_page_coverage: "1",
        has_rage: "1",
        has_quick_back: "1",
        has_insights: "1",
        min_duration_ms: "500",
      }),
    ).toEqual({
      from: 1000,
      to: 2000,
      country: "US",
      region: "CA",
      city: "San Francisco",
      device: "desktop",
      browser: "Chrome",
      os: "macOS",
      entry_url: "/checkout/complete",
      entry_url_prefix: "/checkout",
      has_errors: true,
      error_detail: "Checkout failed",
      has_page_coverage: true,
      has_rage: true,
      has_quick_back: true,
      has_insights: true,
      min_duration_ms: 500,
    });
  });

  it("uses a stable last-24-hour default and switches ranges", () => {
    expect(withDefaultDateRange({}, 100_000_000)).toEqual({
      from: 13_560_000,
      to: 99_960_000,
    });
    const sevenDays = dateRangeFilter({ country: "US" }, "7d", 700_000_000);
    expect(sevenDays).toEqual({ country: "US", from: 95_160_000, to: 699_960_000 });
    expect(selectedDateRange(sevenDays)).toBe("7d");
    expect(withDefaultDateRange({}, 100_001_000)).toEqual(withDefaultDateRange({}, 100_019_999));
  });

  it("keeps only the date range and warehouse snapshot for supporting stats", () => {
    expect(
      dateRangeSnapshotFilter({
        from: 1_000,
        to: 2_000,
        country: "US",
        has_errors: true,
        warehouse_version: 12,
      }),
    ).toEqual({ from: 1_000, to: 2_000, warehouse_version: 12 });
  });

  it("drops only invalid URL search keys", () => {
    expect(validateSessionSearch({ country: "US", from: "not-a-time", has_errors: "1" })).toEqual({
      country: "US",
      has_errors: true,
    });
    expect(validateSessionSearch({ from: "2000", to: "1000", browser: "Chrome" })).toEqual({
      from: 2000,
      browser: "Chrome",
    });
  });

  it("keeps doorway filters canonical", () => {
    const filter = {
      from: 1000,
      country: "US",
      device: "desktop",
      has_errors: true,
      error_detail: "Checkout failed",
      has_page_coverage: true,
      has_rage: true,
      has_quick_back: true,
      has_insights: true,
    };
    expect(canonicalSessionFilter(filter)).toBe(
      "from=1000&country=US&device=desktop&has_errors=1&error_detail=Checkout+failed&has_page_coverage=1&has_rage=1&has_quick_back=1&has_insights=1",
    );
  });
});
