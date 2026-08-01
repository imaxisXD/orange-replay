import { AnimatePresence, m, useReducedMotion } from "@/lib/motion";
import { EmberField } from "@/components/ember-field";
import { DashboardWorkspaceProvider } from "@/lib/dashboard-workspace";
import { AppShell } from "@/routes/app-shell";
import {
  ACT,
  CAMERA,
  PREVIEW_FRAME,
  SWITCHER_FIELD,
  cameraStop,
  canvasParallaxScale,
} from "./onboarding-motion";
import { useOnboarding } from "./onboarding-context";
import { WebsiteFavicon } from "./website-favicon";

/** The stage the camera moves over. Fixed so the framing is not viewport-bound. */
const STAGE = { width: 1_100, height: 1_080 } as const;

/**
 * The dashboard the visitor is activating, shown beside the form.
 *
 * This renders the real `AppShell` — the same header, project switcher,
 * environment badge, tab row and workspace card the dashboard ships — rather
 * than a hand-built lookalike, so the preview cannot drift from the product.
 * The page body is placeholders and carries no copy at all; see
 * `PendingOverview` for why.
 *
 * One act drives this pane (see the storyboard): while the website is being
 * named the camera pushes in toward the switcher, which takes the system's amber
 * focus ring over a shimmering LED lattice; it rests wide through install and
 * waiting; and on the first event the frame lifts. That lift is deliberately all
 * act 2 does — again, see `PendingOverview`.
 */
export function OnboardingPreview() {
  const reduceMotion = useReducedMotion() === true;
  const { act, faviconUrl, isNamingProject, previewProjectLabel, projectId } = useOnboarding();
  const isNaming = isNamingProject && !reduceMotion;
  const camera = cameraStop(isNaming);
  const isLive = act === ACT.live;
  // A push-in is decisive; a pull-out is a reveal. Playing the same spring
  // backwards made blurring the field read as the camera snapping back.
  const cameraTransition = reduceMotion
    ? { duration: 0 }
    : isNaming
      ? CAMERA.spring
      : CAMERA.releaseSpring;

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
      transition={
        reduceMotion
          ? { duration: 0 }
          : { ...PREVIEW_FRAME.spring, delay: isLive ? PREVIEW_FRAME.liveDelay : 0 }
      }
    >
      {/* The far plane. Same spring as the dashboard so both planes arrive
          together, but only a fraction of the travel, which is what makes the
          move read as the camera entering the room rather than the room
          magnifying. */}
      <m.div
        animate={{ scale: canvasParallaxScale(camera.scale) }}
        className="onboarding-canvas-grid"
        initial={false}
        transition={cameraTransition}
      />

      <m.div
        animate={{ scale: camera.scale, x: camera.x, y: camera.y }}
        className="relative origin-top-left"
        initial={false}
        style={{ height: STAGE.height, width: STAGE.width }}
        transition={cameraTransition}
      >
        {/* Behind the shell, so it sits under the switcher's amber ring and
            bloom rather than over them. Mounted only while naming, so its
            requestAnimationFrame loop does not run for the whole flow; the
            presence wrapper keeps it alive long enough to fade out. */}
        <AnimatePresence>
          {isNaming && (
            <m.div
              animate={{ opacity: 1 }}
              className="onboarding-switcher-field pointer-events-none absolute text-amber"
              exit={{ opacity: 0 }}
              initial={{ opacity: 0 }}
              style={{
                height: SWITCHER_FIELD.height,
                left: SWITCHER_FIELD.x,
                top: SWITCHER_FIELD.y,
                width: SWITCHER_FIELD.width,
              }}
              transition={reduceMotion ? { duration: 0 } : SWITCHER_FIELD.spring}
            >
              <EmberField
                className="inset-0 h-full w-full"
                fadePerRow={SWITCHER_FIELD.fadePerRow}
                intensity={SWITCHER_FIELD.intensity}
                pulse={SWITCHER_FIELD.pulse}
              />
            </m.div>
          )}
        </AnimatePresence>

        <DashboardWorkspaceProvider isDemo={false} projectId={projectId}>
          <AppShell
            navigationPathname={`/projects/${projectId}/overview`}
            projectLabel={previewProjectLabel}
            projectLeadingContent={
              <WebsiteFavicon fallbackLabel={previewProjectLabel} source={faviconUrl} />
            }
            rootClassName="h-full"
          >
            <PendingOverview />
          </AppShell>
        </DashboardWorkspaceProvider>
      </m.div>
    </m.div>
  );
}

/**
 * The Overview page's shape with no copy in it.
 *
 * The tab row keeps its real labels because those name where the visitor is
 * about to go, and the header keeps the switcher because that is the camera's
 * subject. Everything below is placeholders. Rendering the real metric labels
 * meant policing them against the product forever, and inventing friendlier ones
 * promised things it does not ship; showing none claims nothing.
 *
 * The widths still echo the real labels they stand in for, so the page keeps the
 * rhythm of the dashboard rather than looking like uniform grey bars.
 */
function PendingOverview() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <Bar className="w-24" height={14} />
          <Bar className="w-62" height={10} />
        </div>
        <div className="flex h-8.5 w-40 shrink-0 items-center rounded-lg border border-border bg-card px-3">
          <Bar className="w-20" height={10} />
        </div>
      </div>

      <section className="lit overview-lit grid overflow-hidden rounded-lg sm:grid-cols-2 lg:grid-cols-4">
        {KEY_METRICS.map((metric) => (
          <PendingMetric detail={metric.detail} key={metric.key} label={metric.label} />
        ))}
      </section>

      <section className="lit overview-lit overflow-hidden rounded-lg">
        <PendingCardHeading detail={186} title={112} />
        <div className="grid sm:grid-cols-2 lg:grid-cols-4">
          {BEHAVIOR_METRICS.map((metric) => (
            <PendingMetric detail={metric.detail} key={metric.key} label={metric.label} />
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {BREAKDOWNS.map((breakdown) => (
          <section className="lit overview-lit overflow-hidden rounded-lg" key={breakdown.key}>
            <PendingCardHeading detail={breakdown.detail} title={breakdown.title} />
            <div className="px-4">
              {[0, 1, 2].map((row) => (
                <div
                  className="flex h-13.5 items-center gap-2.5 border-b border-border/55 last:border-b-0"
                  key={row}
                >
                  <Bar className="size-5.5 shrink-0 rounded-md" />
                  <Bar className="w-30" height={10} />
                  <Bar className="ms-auto w-9.5" height={10} />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function PendingCardHeading({ detail, title }: { detail: number; title: number }) {
  return (
    <div className="flex flex-col gap-2 border-b border-dashed border-dash px-4 py-3.5">
      <Bar height={11} width={title} />
      <Bar height={10} width={detail} />
    </div>
  );
}

function PendingMetric({ detail, label }: { detail: number; label: number }) {
  return (
    <div className="border-b border-dashed border-dash px-4.5 py-4 sm:border-r lg:border-b-0 lg:last:border-r-0">
      <Bar height={10} width={label} />
      <Bar className="mt-2.5 w-16" height={22} />
      <Bar className="mt-2.5" height={10} width={detail} />
    </div>
  );
}

function Bar({
  className,
  height,
  width,
}: {
  className?: string;
  height?: number;
  width?: number;
}) {
  return (
    <span
      className={`onboarding-skeleton ${className ?? ""}`}
      style={{
        ...(height === undefined ? {} : { height }),
        ...(width === undefined ? {} : { maxWidth: "100%", width }),
      }}
    />
  );
}

/* Placeholder geometry, in px, standing in for the Overview page's own labels.
 * `key` names which metric each row replaces so the layout stays traceable, and
 * is never rendered. The widths are proportional to the real strings, which is
 * what keeps the band from reading as four identical grey bars. */
const KEY_METRICS = [
  { key: "sessions", label: 52, detail: 132 },
  { key: "average-session-length", label: 128, detail: 118 },
  { key: "pages-per-session", label: 104, detail: 104 },
  { key: "live-now", label: 48, detail: 122 },
] as const;

const BEHAVIOR_METRICS = [
  { key: "rage-clicks", label: 64, detail: 168 },
  { key: "quick-returns", label: 78, detail: 176 },
  { key: "interaction-time", label: 92, detail: 172 },
  { key: "scroll-depth", label: 70, detail: 148 },
] as const;

const BREAKDOWNS = [
  { key: "locations", title: 62, detail: 168 },
  { key: "devices", title: 50, detail: 174 },
  { key: "entry-pages", title: 74, detail: 142 },
  { key: "browser-errors", title: 88, detail: 190 },
] as const;
