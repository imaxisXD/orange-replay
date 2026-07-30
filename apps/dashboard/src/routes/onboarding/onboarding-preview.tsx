import { m, useReducedMotion } from "@/lib/motion";
import { DashboardWorkspaceProvider } from "@/lib/dashboard-workspace";
import { AppShell } from "@/routes/app-shell";
import { ACT, CAMERA, PREVIEW_FRAME, cameraStop } from "./onboarding-motion";
import { useOnboarding } from "./onboarding-context";

/** The stage the camera moves over. Fixed so the framing is not viewport-bound. */
const STAGE = { width: 1_100, height: 1_080 } as const;

/**
 * The dashboard the visitor is activating, shown beside the form.
 *
 * This renders the real `AppShell` — the same header, project switcher,
 * environment badge, tab row and workspace card the dashboard ships — rather
 * than a hand-built lookalike, so the preview cannot drift from the product.
 * Only the page body is stand-in content: the project has no data yet, so
 * every metric keeps its real label and shows a pending value.
 *
 * One act drives this pane (see the storyboard): the camera pushes in on the
 * switcher while the website is being named, rests wide through install and
 * waiting, and on the first event the frame lifts. The lift is deliberately the
 * only thing act 2 does — see `PendingOverview` for why nothing here can fill
 * in.
 */
export function OnboardingPreview() {
  const reduceMotion = useReducedMotion() === true;
  const { act, isNamingProject, previewProjectLabel, projectId } = useOnboarding();
  const camera = cameraStop(isNamingProject && !reduceMotion);
  const isLive = act === ACT.live;

  return (
    <m.div
      animate={{ y: isLive ? PREVIEW_FRAME.liveY : PREVIEW_FRAME.restY }}
      aria-hidden="true"
      className="onboarding-canvas pointer-events-none absolute top-[17.6svh] left-[7%] h-[82.4svh] w-[93%] overflow-hidden rounded-tl-[18px]"
      data-camera={isNamingProject ? "project" : "overview"}
      data-live={isLive ? "true" : "false"}
      initial={false}
      // Keeps the preview's real links, switcher and buttons out of the tab
      // order: it is a picture of the dashboard, not a second copy of it.
      inert
      transition={reduceMotion ? { duration: 0 } : PREVIEW_FRAME.spring}
    >
      <m.div
        animate={{ scale: camera.scale, x: camera.x, y: camera.y }}
        className="origin-top-left"
        initial={false}
        style={{ height: STAGE.height, width: STAGE.width }}
        transition={reduceMotion ? { duration: 0 } : CAMERA.spring}
      >
        <DashboardWorkspaceProvider isDemo={false} projectId={projectId}>
          <AppShell
            navigationPathname={`/projects/${projectId}/overview`}
            projectLabel={previewProjectLabel}
            rootClassName="h-full"
          >
            <PendingOverview />
          </AppShell>
        </DashboardWorkspaceProvider>
      </m.div>
    </m.div>
  );
}

/** The Overview page's real shape with every value still pending. */
function PendingOverview() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[18px] font-semibold leading-[1.1] tracking-[-0.015em]">Overview</h1>
          <p className="mt-1 text-[12px] leading-normal text-muted-foreground">
            See completed sessions and how people used your product.
          </p>
        </div>
        <div className="flex h-8.5 w-40 shrink-0 items-center rounded-lg border border-border bg-card px-3">
          <Bar className="w-20" height={8} />
        </div>
      </div>

      <section className="lit overview-lit grid overflow-hidden rounded-lg sm:grid-cols-2 lg:grid-cols-4">
        {KEY_METRICS.map((metric) => (
          <PendingMetric detail={metric.detail} key={metric.label} label={metric.label} />
        ))}
      </section>

      <section className="lit overview-lit overflow-hidden rounded-lg">
        <div className="border-b border-dashed border-dash px-4 py-3.5">
          <h2 className="text-[13px] font-semibold leading-tight text-foreground">
            Session behavior
          </h2>
          <p className="mt-0.5 text-[11.5px] text-muted-foreground">{BEHAVIOR_COVERAGE}</p>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4">
          {BEHAVIOR_METRICS.map((metric) => (
            <PendingMetric detail={metric.detail} key={metric.label} label={metric.label} />
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {BREAKDOWNS.map((breakdown) => (
          <section className="lit overview-lit overflow-hidden rounded-lg" key={breakdown.title}>
            <div className="border-b border-dashed border-dash px-4 py-3.5">
              <h2 className="text-[13px] font-semibold leading-tight text-foreground">
                {breakdown.title}
              </h2>
              <p className="mt-0.5 text-[11.5px] text-muted-foreground">{breakdown.description}</p>
            </div>
            <div className="px-4">
              {[0, 1, 2].map((row) => (
                <div
                  className="flex h-13.5 items-center gap-2.5 border-b border-border/55 last:border-b-0"
                  key={row}
                >
                  <Bar className="size-5.5 shrink-0 rounded-md" />
                  <Bar className="w-30" height={8} />
                  <Bar className="ms-auto w-9.5" height={8} />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function PendingMetric({ detail, label }: { detail: string; label: string }) {
  return (
    <div className="border-b border-dashed border-dash px-4.5 py-4 sm:border-r lg:border-b-0 lg:last:border-r-0">
      <span className="block text-[11.5px] text-muted-foreground">{label}</span>
      <Bar className="mt-1.5 w-16 rounded-[5px]" height={22} />
      <span className="mt-1.5 block text-[11.5px] text-muted-foreground">{detail}</span>
    </div>
  );
}

function Bar({ className, height }: { className?: string; height?: number }) {
  return (
    <span
      className={`onboarding-skeleton ${className ?? ""}`}
      style={height === undefined ? undefined : { height }}
    />
  );
}

/* The Overview page's own labels, copied verbatim from `overview-content.tsx`
 * and `overview-breakdowns.tsx`, including the wording those files use while a
 * metric has no data yet. The preview's whole claim is that it is the dashboard
 * the visitor is about to get, so inventing friendlier copy here would promise
 * something the product does not ship. `onboarding-preview-copy.test.ts` fails
 * if any string below stops matching the real page. */
const KEY_METRICS = [
  { label: "Sessions", detail: "Completed in this time range" },
  { label: "Average session length", detail: "Waiting for session data" },
  { label: "Pages per session", detail: "Waiting for page data" },
  { label: "Live now", detail: "Active in the last minute" },
] as const;

const BEHAVIOR_METRICS = [
  { label: "Rage clicks", detail: "Sessions with repeated clicks in one spot" },
  { label: "Quick returns", detail: "Returned to the previous page within 10 seconds" },
  { label: "Interaction time", detail: "Estimated time spent clicking, typing, or scrolling" },
  { label: "Scroll depth", detail: "Average furthest point reached" },
] as const;

const BEHAVIOR_COVERAGE = "Waiting for behavior data";

const BREAKDOWNS = [
  { title: "Locations", description: "Where people used your product" },
  { title: "Devices", description: "What people used your product on" },
  { title: "Entry pages", description: "Where people landed first" },
  { title: "Browser errors", description: "What broke while people were there" },
] as const;
