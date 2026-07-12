// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { markSessionWatched, unmarkSessionWatched, watchedSessionIds } from "../src/lib/watched";

describe("watched session store", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("starts empty and records watched sessions per project", () => {
    expect(watchedSessionIds("p1").size).toBe(0);
    markSessionWatched("p1", "s1");
    markSessionWatched("p1", "s2");
    expect([...watchedSessionIds("p1")]).toEqual(["s1", "s2"]);
    expect(watchedSessionIds("p2").size).toBe(0);
  });

  it("deduplicates re-watches", () => {
    markSessionWatched("p1", "s1");
    markSessionWatched("p1", "s1");
    expect([...watchedSessionIds("p1")]).toEqual(["s1"]);
  });

  it("removes a watched session without touching the rest", () => {
    markSessionWatched("p1", "s1");
    markSessionWatched("p1", "s2");
    unmarkSessionWatched("p1", "s1");
    expect([...watchedSessionIds("p1")]).toEqual(["s2"]);
  });

  it("survives corrupted storage", () => {
    localStorage.setItem("or:watched:p1", "{not json");
    expect(watchedSessionIds("p1").size).toBe(0);
    markSessionWatched("p1", "s1");
    expect(watchedSessionIds("p1").has("s1")).toBe(true);
  });
});
