import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createRootRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { ReplayWorkspace } from "../../../apps/dashboard/src/routes/session-detail/replay-playback";
import { AnalyticsStatusNotice } from "../../../apps/dashboard/src/components/analytics-stale-alert";
import { OverviewSummary } from "../../../apps/dashboard/src/routes/overview/overview-content";
import { ShapeProvider } from "../../../apps/dashboard/src/lib/shape-context";
import { MotionProvider } from "../../../apps/dashboard/src/lib/motion-provider";
import { MaskingCard } from "../src/routes/settings/settings-cards";
import type { DraftMaskRule } from "../src/lib/project-settings";
import { validProjectStatsResponse } from "../../../packages/shared/tests/response-contract-fixtures";
import { PublicPageApp } from "../../../apps/public-page/src/public-page-app";
import ReplayPlayer from "../../../apps/public-page/src/replay-player";
import { makePublicPageQueryClient } from "../../../apps/public-page/src/query";
import type { PublicPageData, SessionManifest } from "../../../packages/shared/src/types";

export async function mountArchitectureProof(
  surface: string,
  manifest: SessionManifest,
  pageData: PublicPageData,
) {
  document.documentElement.classList.add("dark");
  if (surface === "public") await import("../../../apps/public-page/src/styles.css");
  else await import("../../../apps/dashboard/src/index.css");
  const queryClient = makePublicPageQueryClient();
  queryClient.setQueryData(["public-page", pageData.publicId], pageData);
  const App = () => {
    const [pinned, setPinned] = useState(true);
    if (surface === "public")
      return (
        <QueryClientProvider client={queryClient}>
          <PublicPageApp publicId={pageData.publicId} replayPlayer={ReplayPlayer} />
        </QueryClientProvider>
      );
    return (
      <ShapeProvider>
        <main className="mx-auto max-w-7xl p-4">
          {surface === "analytics" ? (
            <>
              <AnalyticsStatusNotice
                analyticsState="fresh"
                analyticsView={pinned ? "pinned" : "latest"}
                analyticsDelivery={{
                  state: "pending",
                  pendingExports: 2,
                  oldestPendingAt: 1000,
                  checkedAt: 601000,
                }}
                onShowLatest={() => setPinned(false)}
              />
              <OverviewSummary
                filter={{}}
                isDemo
                projectId="project"
                stats={{
                  ...validProjectStatsResponse,
                  liveNow: { value: null, filter: validProjectStatsResponse.filter },
                  liveNowState: "unavailable",
                }}
              />
            </>
          ) : surface === "settings" ? (
            <MaskingProof />
          ) : (
            <div className="flex flex-col gap-3">
              <ReplayWorkspace
                manifest={manifest}
                isDemo={surface === "demo"}
                mode="recorded"
                projectId="project"
                sessionId="session"
              />
            </div>
          )}
        </main>
      </ShapeProvider>
    );
  };
  const route = createRootRoute({ component: App });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  const container = document.createElement("div");
  document.body.append(container);
  createRoot(container).render(
    <MotionProvider>
      <RouterProvider router={router} />
    </MotionProvider>,
  );
}

function MaskingProof() {
  const [rules, setRules] = useState<DraftMaskRule[]>([]);
  return (
    <MaskingCard
      error={null}
      maskPolicyVersion={2}
      rules={rules}
      onAddRule={() => setRules([...rules, { uiId: "rule", selector: ".private", action: "mask" }])}
      onRemoveRule={(index) => setRules(rules.filter((_, position) => position !== index))}
      onSetSelector={(index, selector) =>
        setRules(rules.map((rule, position) => (position === index ? { ...rule, selector } : rule)))
      }
      onSetAction={(index, action) =>
        setRules(rules.map((rule, position) => (position === index ? { ...rule, action } : rule)))
      }
    />
  );
}
