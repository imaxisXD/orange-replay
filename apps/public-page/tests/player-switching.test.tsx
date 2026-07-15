// @vitest-environment happy-dom
import { act, useState } from "react";
import type { PublicPageData, PublicPageRecording } from "@orange-replay/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { PublicPageApp } from "../src/public-page-app.tsx";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
});

describe("public replay switching", () => {
  it("mounts a fresh player when another recording is selected", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(["public-page", "public-one"], pageData());
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    function TestPlayer({ recording }: { recording: PublicPageRecording }) {
      const [position, setPosition] = useState(0);
      return (
        <button type="button" onClick={() => setPosition((value) => value + 1)}>
          {recording.replayId}:{position}
        </button>
      );
    }

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PublicPageApp publicId="public-one" replayPlayer={TestPlayer} />
        </QueryClientProvider>,
      );
    });
    const watchButtons = Array.from(container.querySelectorAll<HTMLButtonElement>(".watch-button"));
    await act(async () => watchButtons[0]?.click());
    const firstPlayer = findButton(container, "replay-one:0");
    await act(async () => firstPlayer.click());
    expect(container.textContent).toContain("replay-one:1");

    await act(async () => watchButtons[1]?.click());
    expect(container.textContent).toContain("replay-two:0");
    expect(container.textContent).not.toContain("replay-two:1");

    await act(async () => root.unmount());
    queryClient.clear();
  });
});

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === text,
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Button ${text} was not rendered.`);
  return button;
}

function pageData(): PublicPageData {
  return {
    version: 1,
    publicId: "public-one",
    publicUrl: "https://public.example/p/public-one",
    projectName: "Store",
    generatedAt: 1,
    analytics: {
      sessions: 2,
      averageDurationMs: 1,
      p50DurationMs: 1,
      clicks: 2,
      pagesPerSession: 1,
      pagesCoveredSessions: 2,
      ragePercent: 0,
      quickBackPercent: 0,
      countries: [],
      devices: [],
      browsers: [],
      operatingSystems: [],
      entryPages: [],
    },
    recordings: [recording("replay-one", "/one"), recording("replay-two", "/two")],
  };
}

function recording(replayId: string, entryPath: string): PublicPageRecording {
  return {
    replayId,
    position: replayId === "replay-one" ? 0 : 1,
    startedAt: 1,
    durationMs: 1,
    entryPath,
    device: "desktop",
    browser: "Chrome",
    country: "US",
    operatingSystem: "macOS",
    clicks: 1,
    errors: 0,
    pages: 1,
    rages: 0,
  };
}
