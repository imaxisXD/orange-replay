import type { SessionFilter } from "@orange-replay/shared";
import { describe, expect, it } from "vite-plus/test";
import { filterChips, removeFilterKey } from "../src/lib/filter-chips";

const now = 1_783_600_000_000;
const day = 86_400_000;

describe("filter chips", () => {
  it("renders one chip per active key with readable labels", () => {
    const filter: SessionFilter = {
      country: "US",
      has_errors: true,
      min_duration_ms: 30_000,
    };
    const labels = filterChips(filter, now).map((chip) => chip.label);
    expect(labels).toContain("Country US");
    expect(labels).toContain("Has errors");
    expect(labels).toContain("≥ 0:30");
    expect(labels).toHaveLength(3);
  });

  it("collapses from/to into a single range chip", () => {
    const filter: SessionFilter = { from: now - day, to: now, country: "DE" };
    const chips = filterChips(filter, now);
    expect(chips.map((chip) => chip.label)).toEqual(["Last 24h", "Country DE"]);
    expect(chips[0]?.key).toBe("from");
  });

  it("falls back to key=value for unknown keys", () => {
    const filter = { mystery_key: "abc" } as unknown as SessionFilter;
    expect(filterChips(filter, now)[0]?.label).toBe("mystery_key=abc");
  });

  it("skips undefined values", () => {
    const filter: SessionFilter = { country: undefined, has_errors: true };
    expect(filterChips(filter, now)).toHaveLength(1);
  });
});

describe("removeFilterKey", () => {
  it("removes a single key", () => {
    const filter: SessionFilter = { country: "US", has_errors: true };
    expect(removeFilterKey(filter, "country")).toEqual({ has_errors: true });
  });

  it("removes to alongside from", () => {
    const filter: SessionFilter = { from: now - day, to: now, country: "US" };
    expect(removeFilterKey(filter, "from")).toEqual({ country: "US" });
  });

  it("does not mutate the input", () => {
    const filter: SessionFilter = { country: "US" };
    removeFilterKey(filter, "country");
    expect(filter.country).toBe("US");
  });
});
