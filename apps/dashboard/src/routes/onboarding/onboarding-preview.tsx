import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { AnimatePresence, m, useReducedMotion } from "@/lib/motion";
import { EmberField } from "@/components/ember-field";
import { DashboardWorkspaceProvider } from "@/lib/dashboard-workspace";
import { AppShell } from "@/routes/app-shell";
import liveSignalWatchSrc from "@/assets/empty-states/signal-watch-winged-receiver.webp";
import { LiveBadge, LiveDot } from "@/components/live-badge";
import { Badge } from "@/components/ui/badge";
import { LoadingIndicator } from "@/components/ui/loading-indicator";
import {
  ACT,
  CAMERA,
  PREVIEW_BODY,
  PREVIEW_EXIT,
  PREVIEW_FRAME,
  PREVIEW_LIVE,
  PREVIEW_PAGE,
  SWITCHER_FIELD,
  TIMING,
  WATCH_FIELD,
  cameraStop,
  canvasParallaxScale,
  previewPage,
} from "./onboarding-motion";
import {
  buildInstallPreviewSummary,
  findInstallTarget,
  type InstallTargetId,
} from "./install-targets";
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
 * Two values drive this pane (see the storyboard). The camera: while the website
 * is being named it pushes in toward the switcher, which takes the system's
 * amber focus ring over a shimmering LED lattice, and it rests wide for the rest
 * of the flow. And the page: Overview while the website is being named, Install
 * for the whole of step two — where the product's own verify card carries the
 * wait — and Live the moment an event lands.
 *
 * Changing page is what act 1 has instead of a camera move, and it is what lets
 * this pane say something new on each step without inventing anything. The two
 * exceptions to the no-copy rule below are both of that kind: the Install page's
 * "Waiting for the first event…" and Live's "Live now" badge are the product's
 * own words for states that are true at the moment they are shown.
 */
export function OnboardingPreview() {
  const reduceMotion = useReducedMotion() === true;
  const {
    act,
    faviconUrl,
    isLeaving,
    isLiveConfirmed,
    isNamingProject,
    isRecording,
    installTargetId,
    previewProjectLabel,
    projectId,
    stepIndex,
  } = useOnboarding();
  const isNaming = isNamingProject && !reduceMotion;
  const camera = cameraStop(isNaming);
  const isLive = act === ACT.live;
  // One held value: the tab row answers the step it entered, one beat behind it.
  // Live arrives in its real watching state. It fills only after the verify
  // step confirms that this Website's exact first session is present there.
  const targetPage = previewPage(stepIndex, isRecording);
  // The arrival is staged, so the walk to Live is held longer than an ordinary
  // step change: the card being watched answers first, then the frame lifts,
  // then the page changes. See `TIMING.arrival*`.
  const page = useHeld(
    targetPage,
    targetPage === PREVIEW_PAGE.live && isRecording ? TIMING.arrivalLive : TIMING.previewPage,
    reduceMotion,
  );
  const frameRef = useRef<HTMLDivElement>(null);
  const exit = usePreviewCut(frameRef, isLeaving && !reduceMotion);
  // A push-in is decisive; a pull-out is a reveal. Playing the same spring
  // backwards made blurring the field read as the camera snapping back.
  const cameraTransition = reduceMotion
    ? { duration: 0 }
    : isNaming
      ? CAMERA.spring
      : CAMERA.releaseSpring;

  return (
    <m.div
      animate={
        exit === null
          ? { scale: 1, x: 0, y: isLive ? PREVIEW_FRAME.liveY : PREVIEW_FRAME.restY }
          : { scale: exit.scale, x: exit.x, y: exit.y }
      }
      aria-hidden="true"
      className="onboarding-canvas pointer-events-none absolute top-[17.6svh] left-[7%] h-[82.4svh] w-[93%] overflow-hidden rounded-tl-[18px]"
      data-camera={isNamingProject ? "project" : "overview"}
      data-live={isLive ? "true" : "false"}
      initial={false}
      // Keeps the preview's real links, switcher and buttons out of the tab
      // order: it is a picture of the dashboard, not a second copy of it.
      inert
      ref={frameRef}
      // Top-left, and it matters: the cut is measured from this corner, and the
      // stage inside already scales from the same one, so both planes grow
      // about one point instead of pulling apart.
      style={{ transformOrigin: "0 0" }}
      transition={
        reduceMotion
          ? { duration: 0 }
          : exit === null
            ? { ...PREVIEW_FRAME.spring, delay: isLive ? PREVIEW_FRAME.liveDelay : 0 }
            : { duration: PREVIEW_EXIT.duration / 1_000, ease: PREVIEW_EXIT.ease }
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
            navigationPathname={`/projects/${projectId}/${page}`}
            projectLabel={previewProjectLabel}
            projectLeadingContent={
              <WebsiteFavicon fallbackLabel={previewProjectLabel} source={faviconUrl} />
            }
            rootClassName="h-full"
          >
            {/* All pages stay mounted in one grid cell rather than swapping
                through `AnimatePresence`. They are placeholders, so keeping the
                layout costs little, and the cell then holds the tallest page's
                height: an exiting body cannot collapse the column under the
                arriving one mid-cross-fade. Expensive effects still receive
                `isShown` so a hidden page cannot keep drawing. */}
            <div className="grid">
              <PreviewPage isShown={page === PREVIEW_PAGE.overview} reduceMotion={reduceMotion}>
                <PendingOverview />
              </PreviewPage>
              <PreviewPage isShown={page === PREVIEW_PAGE.install} reduceMotion={reduceMotion}>
                <PendingInstall
                  isInstalled={isLive}
                  isShown={page === PREVIEW_PAGE.install}
                  targetId={installTargetId}
                />
              </PreviewPage>
              <PreviewPage isShown={page === PREVIEW_PAGE.live} reduceMotion={reduceMotion}>
                {/* Filled by the confirmed session, not by the act: the event
                    lands seconds before the session surfaces on Live, and the
                    card claiming "Live now" in that gap would promise a page
                    the visitor could reach before it was true. */}
                <PendingLive isFilled={isLiveConfirmed} reduceMotion={reduceMotion} />
              </PreviewPage>
            </div>
          </AppShell>
        </DashboardWorkspaceProvider>
      </m.div>
    </m.div>
  );
}

/**
 * The exit, as a transform measured at the moment it starts.
 *
 * The frame is sized in svh and percentages against a pane that is a fraction of
 * the grid, so there is no arithmetic that yields this: the only honest source is
 * the frame's own box against the window. Measured once, on the frame that is
 * about to move, and then left alone — re-measuring mid-flight would read its own
 * animation back in.
 *
 * `scale` covers the viewport on both axes, and the offset puts the frame's
 * top-left corner on the window's. Both are applied about `transform-origin: 0 0`,
 * so the translate lands the corner and the scale grows away from it.
 */
function usePreviewCut(
  frameRef: RefObject<HTMLDivElement | null>,
  isCutting: boolean,
): { scale: number; x: number; y: number } | null {
  const [cut, setCut] = useState<{ scale: number; x: number; y: number } | null>(null);

  useEffect(() => {
    if (!isCutting) {
      setCut(null);
      return;
    }
    const frame = frameRef.current;
    if (frame === null) return;
    const box = frame.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    setCut({
      scale: Math.max(window.innerWidth / box.width, window.innerHeight / box.height),
      x: -box.left,
      // The box is measured while the frame is already lifted, so its top is
      // 10px above where the layout puts it. Animating to `-box.top` would land
      // the corner 10px low — the lift has to be added back to reach zero.
      y: -(box.top - PREVIEW_FRAME.liveY),
    });
  }, [frameRef, isCutting]);

  return cut;
}

/**
 * What the preview is *showing*, which trails what it is *heading to*.
 *
 * The delay is the beat itself, not a loading allowance: the right pane is
 * answering something the left one just said, and answers that arrive at the
 * same time as the question read as a coincidence. Holding the value here rather
 * than delaying each animation keeps the tab notch, the body and the Live card
 * travelling together, and leaves `AppShell`'s own spring exactly as the product
 * ships it.
 *
 * The first value is adopted with no delay: a refresh or a shared link straight
 * to a later step has no travel to show, so the preview simply starts parked on
 * the page that step is about.
 */
function useHeld<T>(target: T, delay: number, reduceMotion: boolean): T {
  const [shown, setShown] = useState(target);

  useEffect(() => {
    if (shown === target) return;
    if (reduceMotion) {
      setShown(target);
      return;
    }
    const timeout = window.setTimeout(() => setShown(target), delay);
    return () => window.clearTimeout(timeout);
  }, [delay, reduceMotion, shown, target]);

  return shown;
}

/**
 * One page inside the preview's body. Cross-fades and rises; see `PREVIEW_BODY`
 * for why it does not also clear a blur.
 */
function PreviewPage({
  children,
  isShown,
  reduceMotion,
}: {
  children: ReactNode;
  isShown: boolean;
  reduceMotion: boolean;
}) {
  return (
    <m.div
      animate={{ opacity: isShown ? 1 : 0, y: isShown ? 0 : PREVIEW_BODY.riseY }}
      className="[grid-area:1/1]"
      initial={false}
      transition={reduceMotion ? { duration: 0 } : PREVIEW_BODY.spring}
    >
      {children}
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

/**
 * The Install page, in the state step two is actually in: waiting.
 *
 * The real page pairs a snippet card with a **Live verify** card that polls for
 * the first event, so the waiting state this step needs is already the product's
 * own — spinner and words included. Those two sentences are the only copy in
 * this body, and they are the real page's, not a rewrite; `preview-install-copy`
 * in `onboarding-preview-copy.test.ts` fails if `install-status.tsx` changes
 * them. Everything else is placeholder geometry, as on every other page here.
 *
 * The two cards are stacked rather than side by side. The real page uses that
 * arrangement below `lg` and the two-column grid above it, but the preview frame
 * crops at about 78% of the stage, which puts a second column — the card this
 * whole step is waiting on — mostly outside the frame. Borrowing the product's
 * own narrow arrangement keeps it in view without inventing a layout.
 */
function PendingInstall({
  isInstalled,
  isShown,
  targetId,
}: {
  isInstalled: boolean;
  isShown: boolean;
  targetId: InstallTargetId;
}) {
  const target = findInstallTarget(targetId);
  const script = buildInstallPreviewSummary(targetId, readPreviewOrigin());
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Bar className="w-13" height={14} />
        <Bar className="w-54" height={10} />
      </div>

      <section className="lit overview-lit rounded-lg p-5">
        <Bar className="w-27" height={12} />
        <Bar className="mt-2.5 w-full max-w-89" height={10} />

        {/* The left field answers the picker. Everything else on this page is
            placeholder geometry, but the stack is the one thing the visitor is
            actively choosing, and a pane that does not move while they click
            through five tabs reads as a screenshot. */}
        <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="flex flex-col gap-2">
            <Bar height={9} width={PENDING_INSTALL_FIELDS[0].label} />
            <div className="flex h-8.5 items-center gap-2 rounded-lg border border-border bg-card px-3">
              <target.mark aria-hidden size={14} strokeWidth={1.6} />
              <span className="text-[12px] text-foreground">{target.label}</span>
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Bar height={9} width={PENDING_INSTALL_FIELDS[1].label} />
            <div className="flex h-8.5 items-center rounded-lg border border-border bg-card px-3">
              <Bar height={9} width={PENDING_INSTALL_FIELDS[1].value} />
            </div>
          </div>
        </div>

        {/* And the code below it is that stack's collapsed summary — the same
            shape-and-byte-count line step two's own card shows, not the full
            loader. The two panes now state the same thing, and switching tabs
            still visibly rewrites it: Next.js goes to `next/script`, the rest
            stay a script tag. See `buildInstallPreviewSummary`. */}
        <div className="relative mt-4 overflow-hidden rounded-lg border border-border bg-secondary p-4 pr-12">
          <pre className="font-mono text-[9px] leading-[15px] break-words whitespace-pre-wrap text-muted-foreground">
            <code>{script}</code>
          </pre>
          <span className="absolute top-3 right-3 size-7 rounded-md border border-border bg-card" />
        </div>
      </section>

      {/* The verify card, and the whole reason this page is the one on screen.
          While it waits it takes act 1's highlight: the switcher's amber glow,
          deeper, and the same shimmering lattice — as a frame reaching past
          every edge of the card, behind it in the stack so the opaque card and
          the mask keep the dots outside. The card being watched is the one
          that glows, and the held signal reads as "watching" where the old
          per-poll ripple read as a burst of events that had not happened. */}
      <div className="relative">
        {isShown && !isInstalled && (
          <span
            aria-hidden
            className="onboarding-watch-field text-amber"
            style={
              {
                "--watch-reach": `${WATCH_FIELD.reach}px`,
                "--watch-reach-bottom": `${WATCH_FIELD.reachBottom}px`,
              } as CSSProperties
            }
          >
            <EmberField
              className="inset-0 h-full w-full"
              fadePerRow={WATCH_FIELD.fadePerRow}
              intensity={WATCH_FIELD.intensity}
              pulse={WATCH_FIELD.pulse}
            />
          </span>
        )}
        <section
          className={`lit overview-lit rounded-lg p-5 ${isInstalled ? "" : "onboarding-watch-card"}`}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-2">
              <Bar className="w-18" height={12} />
              <Bar className="w-33" height={10} />
            </div>
            <Bar className="mt-0.5 w-11" height={9} />
          </div>
          <div className="relative mt-5 flex min-h-15 items-start gap-3">
            {isInstalled ? (
              /* The first beat of the arrival, on the card already being watched.
               `Badge` and the word are the Install page's own, and both are true
               the instant the event lands. */
              <div className="flex flex-col items-start gap-3">
                <Badge color="green" size="sm" variant="dot">
                  Installed
                </Badge>
                <Bar height={10} width={168} />
              </div>
            ) : (
              <>
                <LoadingIndicator className="mt-0.5" label={INSTALL_WAITING.title} />
                <div>
                  <div className="text-[13px] text-foreground">{INSTALL_WAITING.title}</div>
                  <div className="mt-1 text-[11.5px] text-muted-foreground">
                    {INSTALL_WAITING.detail}
                  </div>
                </div>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * The Install page's waiting copy, verbatim from `install-status.tsx`.
 *
 * Copied rather than imported because the real strings are inline JSX in a
 * component that fetches, polls and renders alerts — mounting it here would put
 * a live query inside a picture. The test named above is what keeps the two in
 * step; if it fails, the product changed its words and this has to follow.
 */
const INSTALL_WAITING = {
  title: "Waiting for the first event…",
  detail: "Open a page with the snippet installed. This updates the moment data arrives.",
} as const;

/* Label and value widths in px for the Install page's two fields. The first
 * value slot is filled by the chosen stack rather than a bar. */
const PENDING_INSTALL_FIELDS = [
  { key: "stack", label: 62, value: 86 },
  { key: "ingest-url", label: 88, value: 124 },
] as const;

function readPreviewOrigin(): string {
  return typeof window === "undefined" ? "" : window.location.origin;
}

/**
 * The Live page, waiting and then filled. This is where the flow's whole wait is
 * shown — the form column says what to do, this pane says what it is watching
 * for — and it is act 2's payoff when the wait ends.
 *
 * Waiting is the product's real empty state for this page, down to the collage
 * and its three dotted rings pulsing on a 3.2s cycle around the beacon. It is
 * kept because it is already the right picture. Its title and description are
 * placeholder bars: the real ones repeat the left column in more words.
 *
 * Filled is the one place the preview shows real product copy other than the tab
 * row, and it is deliberate. `LiveBadge` is the product's own component and
 * "Live now" appears only after the Live query contains the exact first session
 * stored for this Website. The row still invents nothing: the path, place and
 * elapsed time stay placeholder bars.
 *
 * The card carries both states at fixed heights and tweens between them on the
 * shared card-resize recipe; see `PREVIEW_LIVE`.
 */
function PendingLive({ isFilled, reduceMotion }: { isFilled: boolean; reduceMotion: boolean }) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Bar className="w-8" height={14} />
        <Bar className="w-44" height={10} />
      </div>

      <section
        className="lit overview-lit t-resize grid overflow-hidden rounded-lg px-4.5 py-4"
        style={{ height: isFilled ? PREVIEW_LIVE.filledHeight : PREVIEW_LIVE.watchHeight }}
      >
        <m.div
          animate={{ opacity: isFilled ? 0 : 1 }}
          className="flex flex-col items-center justify-center gap-2.5 [grid-area:1/1]"
          initial={false}
          transition={reduceMotion ? { duration: 0 } : PREVIEW_LIVE.spring}
        >
          {/* The collage and its overlay exactly as the Live page builds them,
              inside a plain box standing in for `EmptyMedia`: `signal-watch__art`
              positions itself absolutely against that box, so it needs one.
              What is dropped is the parallax field the real page floats this in
              — five more layers of scenery for a full page, none of it legible
              at this size. */}
          <div className="relative h-52 w-40 shrink-0">
            <div className="signal-watch__art">
              <img alt="" draggable={false} src={liveSignalWatchSrc} />
              <div className="signal-watch__overlay">
                <span className="signal-watch__ring signal-watch__ring--inner" />
                <span className="signal-watch__ring signal-watch__ring--middle" />
                <span className="signal-watch__ring signal-watch__ring--outer" />
                <span className="signal-watch__beacon" />
              </div>
            </div>
          </div>
          <Bar height={11} width={148} />
          <Bar height={9} width={228} />
          <span className="mt-1 h-7 w-26 rounded-lg border border-border bg-card" />
        </m.div>

        <m.div
          animate={{ opacity: isFilled ? 1 : 0, y: isFilled ? 0 : PREVIEW_LIVE.rowRiseY }}
          className="[grid-area:1/1]"
          initial={false}
          transition={reduceMotion ? { duration: 0 } : PREVIEW_LIVE.spring}
        >
          <div className="mb-3.5 flex items-baseline justify-between">
            <LiveBadge />
            <Bar className="w-20" height={9} />
          </div>
          <div className="flex items-center gap-2.5 border-b border-dashed border-dash py-2.25 last:border-b-0">
            <LiveDot size="sm" />
            <div className="flex flex-col gap-2">
              <Bar height={10} width={104} />
              <Bar height={9} width={72} />
            </div>
            <Bar className="ms-auto w-9" height={9} />
          </div>
        </m.div>
      </section>
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
