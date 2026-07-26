import type { SessionFilter } from "@orange-replay/shared";
import { describe, expect, it } from "vite-plus/test";
import { filterChips, pageLocalLensCount, removeFilterKey } from "../src/lib/filter-chips";

const now = 1_783_600_000_000;
const day = 86_400_000;

describe("filter chips", () => {
  it("renders one chip per active key with readable labels", () => {
    const filter: SessionFilter = {
      country: "US",
      city: "San Francisco",
      has_errors: true,
      min_duration_ms: 30_000,
    };
    const labels = filterChips(filter).map((chip) => chip.label);
    expect(labels).toContain("Country US");
    expect(labels).toContain("City San Francisco");
    expect(labels).toContain("Errors only");
    expect(labels).toContain("≥ 0:30");
    expect(labels).toHaveLength(4);
  });

  it("never renders the date window as a chip — the range selector owns it", () => {
    const filter: SessionFilter = { from: now - day, to: now, country: "DE" };
    expect(filterChips(filter).map((chip) => chip.label)).toEqual(["Country DE"]);
  });

  it("describes behavior filters in plain language", () => {
    expect(filterChips({ has_errors: true, has_rage: true }).map((chip) => chip.label)).toEqual([
      "Errors only",
      "Rage clicks only",
    ]);
    expect(filterChips({ has_errors: false, has_rage: false }).map((chip) => chip.label)).toEqual([
      "No errors",
      "No rage clicks",
    ]);
  });

  it("falls back to key=value for unknown keys", () => {
    const filter = { mystery_key: "abc" } as unknown as SessionFilter;
    expect(filterChips(filter)[0]?.label).toBe("mystery_key=abc");
  });

  it("skips undefined values", () => {
    const filter: SessionFilter = { country: undefined, has_errors: true };
    expect(filterChips(filter)).toHaveLength(1);
  });
});

describe("pageLocalLensCount", () => {
  it("counts page-local lenses, never the date window or warehouse pin", () => {
    expect(
      pageLocalLensCount({
        from: now - day,
        to: now,
        warehouse_version: 7,
        country: "US",
        has_errors: true,
      }),
    ).toBe(2);
  });

  it("is zero for a pure date range with a doorway pin and skips undefined", () => {
    expect(pageLocalLensCount({ from: now - day, to: now, warehouse_version: 7 })).toBe(0);
    expect(pageLocalLensCount({ country: undefined, has_errors: true })).toBe(1);
  });
});

describe("removeFilterKey", () => {
  it("removes a single key", () => {
    const filter: SessionFilter = { country: "US", has_errors: true };
    expect(removeFilterKey(filter, "country")).toEqual({ has_errors: true });
  });

  it("does not mutate the input", () => {
    const filter: SessionFilter = { country: "US" };
    removeFilterKey(filter, "country");
    expect(filter.country).toBe("US");
  });
});
