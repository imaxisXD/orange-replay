// @vitest-environment happy-dom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import { AnalyticsStatusNotice } from "../src/components/analytics-stale-alert";
import { ShapeProvider } from "../src/lib/shape-context";

const waitingDelivery = {
  state: "pending" as const,
  pendingExports: 2,
  oldestPendingAt: 1_000,
  checkedAt: 601_000,
};

describe("analytics status copy", () => {
  it("shows waiting updates even when a cached read is fresh", () => {
    const view = renderNotice({ analyticsState: "fresh", analyticsDelivery: waitingDelivery });
    try {
      expect(view.container.textContent).toContain("Recent analytics are still arriving");
      expect(view.container.textContent).toContain("2 analytics updates waiting to appear");
      expect(view.container.textContent).toContain("10 minutes");
      expect(view.container.textContent).not.toContain("service is temporarily unavailable");
    } finally {
      view.close();
    }
  });

  it("keeps old response delivery unknown and marks cached query failure separately", () => {
    const unknown = renderNotice({ analyticsState: "fresh" });
    const stale = renderNotice({ analyticsState: "stale", analyticsDelivery: waitingDelivery });
    try {
      expect(unknown.container.textContent).toContain("Analytics delivery status unavailable");
      expect(stale.container.textContent).toContain("last saved results");
      expect(stale.container.textContent).toContain("2 analytics updates waiting to appear");
    } finally {
      unknown.close();
      stale.close();
    }
  });

  it("explains an intentional snapshot and offers a separate action to leave it", () => {
    const onShowLatest = vi.fn();
    const view = renderNotice({
      analyticsState: "fresh",
      analyticsView: "pinned",
      analyticsDelivery: waitingDelivery,
      onShowLatest,
    });
    try {
      expect(view.container.textContent).toContain("Fixed analytics snapshot");
      expect(view.container.textContent).toContain("Newer sessions are excluded");
      expect(view.container.textContent).not.toContain("waiting to appear");
      expect(onShowLatest).not.toHaveBeenCalled();
      const button = view.container.querySelector("button");
      expect(button?.textContent).toContain("Show latest results");
      button?.click();
      expect(onShowLatest).toHaveBeenCalledOnce();
    } finally {
      view.close();
    }
  });
});

function renderNotice(props: Parameters<typeof AnalyticsStatusNotice>[0]) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() =>
    root.render(
      <ShapeProvider>
        <AnalyticsStatusNotice {...props} />
      </ShapeProvider>,
    ),
  );
  return {
    container,
    close() {
      root.unmount();
      container.remove();
    },
  };
}
