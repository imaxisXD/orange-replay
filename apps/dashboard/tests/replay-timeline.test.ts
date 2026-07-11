// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";
import {
  buildJourneyBreadcrumbs,
  getPlayerKeyAction,
  mapTimelineSidebarRows,
  timelineXToTime,
} from "../src/lib/replay-timeline";

describe("timeline seek math", () => {
  it("maps x to time and clamps to the session duration", () => {
    expect(timelineXToTime(50, 10_000, 200)).toBe(2_500);
    expect(timelineXToTime(-50, 10_000, 200)).toBe(0);
    expect(timelineXToTime(250, 10_000, 200)).toBe(10_000);
  });
});

describe("event sidebar rows", () => {
  it("maps displayable events and filters noisy types", () => {
    const rows = mapTimelineSidebarRows(
      [
        { t: 1_000, k: "scroll" },
        { t: 2_000, k: "click", d: "main > button.buy-now", m: { text: "Buy now" } },
        { t: 3_000, k: "error", d: "Checkout failed", m: { source: "console" } },
        { t: 4_000, k: "rage", m: { selector: ".quantity-stepper" } },
        { t: 5_000, k: "nav", d: "https://example.com/pricing?plan=pro" },
      ],
      { startedAt: 1_000, durationMs: 8_000 },
    );

    expect(rows).toEqual([
      {
        id: "click-2000-0",
        type: "click",
        dot: "blue",
        label: "Clicked “Buy now”",
        detail: "button.buy-now",
        offsetMs: 1_000,
        offsetLabel: "0:01",
      },
      {
        id: "error-3000-1",
        type: "error",
        dot: "danger",
        label: "Checkout failed",
        detail: "console",
        offsetMs: 2_000,
        offsetLabel: "0:02",
      },
      {
        id: "rage-4000-2",
        type: "rage",
        dot: "amber",
        label: "Rage click",
        detail: ".quantity-stepper",
        offsetMs: 3_000,
        offsetLabel: "0:03",
      },
      {
        id: "nav-5000-3",
        type: "nav",
        dot: "teal",
        label: "→ /pricing?plan=pro",
        offsetMs: 4_000,
        offsetLabel: "0:04",
      },
    ]);
  });

  it("relabels detected dead clicks without duplicating the click row", () => {
    const rows = mapTimelineSidebarRows(
      [{ t: 2_000, k: "click", d: "button.save" }],
      { startedAt: 1_000, durationMs: 8_000 },
      [{ t: 2_000, detail: "main > button.save" }],
    );

    expect(rows).toEqual([
      {
        id: "dead-click-2000-0",
        type: "dead-click",
        dot: "hollow",
        label: "Dead click",
        detail: "button.save",
        offsetMs: 1_000,
        offsetLabel: "0:01",
      },
    ]);
  });
});

describe("journey breadcrumbs", () => {
  it("starts with the entry page and maps navigation times", () => {
    expect(
      buildJourneyBreadcrumbs(
        "https://example.com/start?plan=pro",
        [
          { t: 5_000, k: "click" },
          { t: 3_000, k: "nav", d: "https://example.com/checkout" },
          { t: 7_000, k: "nav", m: { url: "/complete" } },
        ],
        { startedAt: 1_000, durationMs: 10_000 },
      ),
    ).toEqual([
      { id: "entry", path: "/start?plan=pro", offsetMs: 0 },
      { id: "nav-3000-0", path: "/checkout", offsetMs: 2_000 },
      { id: "nav-7000-1", path: "/complete", offsetMs: 6_000 },
    ]);
  });
});

describe("keyboard controls", () => {
  it("maps playback keys to player actions", () => {
    expect(getPlayerKeyAction({ key: " ", target: document.body })).toEqual({
      type: "toggle-play",
    });
    expect(getPlayerKeyAction({ key: "ArrowLeft", target: document.body })).toEqual({
      type: "seek",
      deltaMs: -5000,
    });
    expect(getPlayerKeyAction({ key: "ArrowRight", target: document.body })).toEqual({
      type: "seek",
      deltaMs: 5000,
    });
    expect(getPlayerKeyAction({ key: "Escape", target: document.body })).toBeNull();
  });

  it("ignores player keys while typing", () => {
    const input = document.createElement("input");
    const editable = document.createElement("div");
    editable.contentEditable = "true";

    expect(getPlayerKeyAction({ key: " ", target: input })).toBeNull();
    expect(getPlayerKeyAction({ key: "ArrowRight", target: editable })).toBeNull();
  });

  it("does not double-handle keys owned by focused controls", () => {
    const button = document.createElement("button");
    const link = document.createElement("a");
    const slider = document.createElement("div");
    slider.setAttribute("role", "slider");

    expect(getPlayerKeyAction({ key: " ", target: button })).toBeNull();
    expect(getPlayerKeyAction({ key: " ", target: link })).toBeNull();
    expect(getPlayerKeyAction({ key: "ArrowRight", target: slider })).toBeNull();
  });
});
