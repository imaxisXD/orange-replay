// @vitest-environment happy-dom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import type { TimelineSidebarRow } from "../src/lib/replay-timeline";
import { TimelineSidebar } from "../src/routes/session-detail/replay-playback/timeline-sidebar";

describe("timeline sidebar rendering", () => {
  it("does not rebuild rows when only the parent playback state changes", () => {
    let rowReads = 0;
    const row = {
      get id() {
        rowReads += 1;
        return "click-1";
      },
      type: "click",
      dot: "blue",
      label: "Click",
      offsetMs: 1_000,
      offsetLabel: "0:01",
    } as TimelineSidebarRow;
    const rows = [row];
    const onSeek = vi.fn();
    const container = document.createElement("div");
    const root = createRoot(container);

    flushSync(() => root.render(<TimelineSidebar disabled={false} onSeek={onSeek} rows={rows} />));
    const rowElement = container.querySelector<HTMLElement>('[data-slot="timeline-event-row"]');
    const scrollViewport = rowElement?.parentElement;

    expect(rowElement?.className).toContain("px-4");
    expect(rowElement?.className).not.toContain("rounded-md");
    expect(scrollViewport?.className).not.toContain("px-1");
    const readsAfterFirstRender = rowReads;

    flushSync(() => root.render(<TimelineSidebar disabled={false} onSeek={onSeek} rows={rows} />));
    expect(rowReads).toBe(readsAfterFirstRender);

    flushSync(() =>
      root.render(<TimelineSidebar disabled={false} onSeek={onSeek} rows={[...rows]} />),
    );
    expect(rowReads).toBeGreaterThan(readsAfterFirstRender);

    root.unmount();
  });
});
