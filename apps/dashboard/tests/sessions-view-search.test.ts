import { describe, expect, it } from "vite-plus/test";
import { sessionFilterOf, validateSessionsViewSearch } from "../src/lib/sessions-view-search";

describe("sessions view search", () => {
  it("keeps selected and sort alongside the filter", () => {
    const view = validateSessionsViewSearch({
      country: "US",
      selected: "0198c1c2-abc_DEF",
      sort: "duration",
    });
    expect(view).toEqual({ country: "US", selected: "0198c1c2-abc_DEF", sort: "duration" });
  });

  it("drops invalid selected and unknown sort values", () => {
    expect(validateSessionsViewSearch({ selected: "bad id with spaces" }).selected).toBeUndefined();
    expect(validateSessionsViewSearch({ selected: 42 }).selected).toBeUndefined();
    expect(validateSessionsViewSearch({ sort: "oldest" }).sort).toBeUndefined();
    expect(validateSessionsViewSearch({ sort: "newest" }).sort).toBeUndefined();
  });

  it("keeps the unwatched lens and drops junk values", () => {
    expect(validateSessionsViewSearch({ unwatched: "1" }).unwatched).toBe(true);
    expect(validateSessionsViewSearch({ unwatched: true }).unwatched).toBe(true);
    expect(validateSessionsViewSearch({ unwatched: "0" }).unwatched).toBeUndefined();
    expect(validateSessionsViewSearch({ unwatched: "yes" }).unwatched).toBeUndefined();
  });

  it("strips view-only keys from the API filter", () => {
    const view = validateSessionsViewSearch({
      has_errors: "1",
      selected: "abc",
      sort: "clicks",
      unwatched: "1",
    });
    expect(sessionFilterOf(view)).toEqual({ has_errors: true });
  });
});
