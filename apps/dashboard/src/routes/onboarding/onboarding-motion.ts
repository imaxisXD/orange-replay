/* ─────────────────────────────────────────────────────────
 * ONBOARDING ACTIVATION STORYBOARD
 *
 * Read top-to-bottom. Each value is ms after its own trigger.
 * Every number in the onboarding routes comes from this file.
 *
 * ── THE STORY ────────────────────────────────────────────
 *
 * The right pane is the same dashboard for all three screens,
 * so the flow reads as one continuous shot on one subject.
 * `ACT` below is the single integer that drives it. The steps
 * are routes and cannot see each other, so without one named
 * act the camera ends up steered by whichever boolean happens
 * to be in scope, and this script silently stops describing
 * the code.
 *
 *   ACT 0  IDENTITY   the project takes your site's name.
 *                     Typing pushes the camera in on the
 *                     switcher; blurring releases it.
 *   ACT 1  PROMISE    the camera pulls back to the whole
 *                     dashboard: empty, and yours to fill.
 *                     Held across install and waiting. The
 *                     camera stops moving; the preview changes
 *                     page instead. On step two the tab row goes
 *                     to Install and the page under it carries
 *                     the product's own waiting state — the
 *                     verify card that page really ships, spinner
 *                     and all. That is where the wait is shown,
 *                     and the only place it is: step two has no
 *                     Continue to press, because there is nothing
 *                     to confirm.
 *   ACT 2  LIVE       the first event lands and step two hands
 *                     over to step three by itself. The camera
 *                     holds while the preview walks to Live in
 *                     its real signal-watch state. The frame
 *                     lifts, then the left pane waits on something
 *                     stricter than "any live row": the Live query
 *                     must return the exact session id stored when
 *                     this Website first connected. Only then does
 *                     the watch give way to "Live now" and one row.
 *                     That payoff is held before the cut. If the
 *                     session stays slow, the cut still runs at the
 *                     cap and the real Live page continues with an
 *                     explicit connecting state.
 *
 * ── BEATS ────────────────────────────────────────────────
 *
 * FIRST PAINT — once per visit
 *      0ms   canvas, rail and dashboard preview hold at rest
 *     60ms   the rail fills up to the opened step: each part's
 *            amber lattice is revealed left to right over 420ms,
 *            the parts running 90ms apart. It is the rail's only
 *            motion — nothing on it loops
 *     60ms   heading rises 12px, blur 3px → 0
 *    120ms   supporting line follows
 *    180ms   field / code card / status card follows
 *    220ms   primary action follows
 *
 * STEP CHANGE — every navigation between steps
 *      0ms   the leaving step is replaced (each step is its own
 *            route, so nothing lingers behind to fade out)
 *      0ms   entering step slides 8px in along the direction of
 *            travel and clears a 3px blur; Back travels the
 *            other way, so the flow reads as a position
 *      0ms   chunks re-stagger in reading order
 *    420ms   the part just reached has finished filling, left to
 *            right; the one behind it settles to its done tone
 *    300ms   the persistent form frame finishes tweening to the
 *            new step's height
 *
 * ACT 0 → IDENTITY — typing on step 1
 *      0ms   first character pushes the camera in toward the
 *            project switcher (scale 0.78 → 1.18, biased 24px
 *            left). Bounded by the brand mark, which must stay
 *            inside the frame
 *      0ms   the switcher takes the system's amber focus ring and
 *            bloom — the same ring the website field the visitor
 *            is typing into is wearing right then
 *      0ms   the dotted canvas travels at 0.35 of that rate, so
 *            the planes separate and the camera reads as moving
 *            into the room rather than the room magnifying
 *      0ms   the switcher lifts onto its own surface
 *    520ms   push has landed
 *   blur     release takes 760ms, not 520: a pull-out is a reveal
 *            and gets more time than the push that preceded it
 *   1000ms   an invalid non-empty address has stayed unchanged long
 *            enough to be deliberate; reveal its error and shake once
 *   blur     camera releases back to the whole dashboard
 *  invalid   field shakes 6px → -6px → 4px and settles
 *
 * WEBSITE FAVICON — once a valid origin settles
 *      0ms   stage 0 holds no slot and no gap before a source
 *      0ms   stage 1 grows the slot left → right, travels 6px,
 *            and clears a 2px blur while the skeleton pulses
 *    250ms   the 16px slot has settled in both identity surfaces
 *    loaded  stage 2 cross-fades skeleton → website icon
 *    400ms   the icon has cleared its final 2px reveal blur
 *
 * ACT 1 → PROMISE — the snippet, and the wait
 *      0ms   camera rests wide and flush. It does not move again
 *            until the flow ends: the push-in belongs to act 0,
 *            and spending it twice would make neither land
 *      0ms   step 2's heading lands in the left column
 *    180ms   the preview answers it: the tab row travels
 *            Overview → Install on the product's own notch spring
 *            and the body cross-fades in, rising 6px. Under the
 *            snippet card sits that page's real verify card, in
 *            its real waiting state — the spinner and the words
 *            the Install page itself uses. The form column says
 *            what to do, this pane says what it is watching for
 *
 * THE WAIT — step 2, and it can last minutes
 *  every 3s  the verify card rings once: a soft amber ripple
 *            leaves the spinner and reaches 132px. It is fired by
 *            the poll itself, not by a loop, so it means "I just
 *            checked". The stillness between rings is the point —
 *            a spinner that never stops stops being read
 *
 * ACT 2 → LIVE — the first event arrives, one subject per beat
 *      0ms   step 2 hands over to step 3 on its own: the poll
 *            that was running under the snippet saw the event, so
 *            there is nothing left to confirm
 *      0ms   the card already being watched answers first — the
 *            verify card takes the Install page's real Installed
 *            state, green dot and all. No page change, no camera
 *            move, nothing to hunt for
 *      0ms   on the left, the signal turns green and the check
 *            strokes itself in
 *    260ms   the frame lifts 10px and its shadow deepens
 *    420ms   the tab row travels Install → Live and the page
 *            arrives in its signal-watch state
 *    500ms   check finishes drawing
 *  session   Live opens the moment the live query returns the
 *            exact session id stored by the Website activation
 *            write. The preview fills, holds for 900ms, then the
 *            frame grows over 560ms while the form column leaves
 *            in 320ms. The route changes behind the full frame
 *   4000ms   the cap. A slow or failing query must not strand
 *            anyone on a finished screen, so the handoff goes
 *            ahead and the real Live page says it is connecting.
 *            The CTA is enabled throughout. Reduced motion keeps
 *            the same exact-session-or-cap truth gate but skips
 *            the payoff hold and cut delays
 * ───────────────────────────────────────────────────────── */

/**
 * The flow's three acts. One integer drives the right pane, so the script above
 * and the code cannot drift apart.
 */
export const ACT = { identity: 0, promise: 1, live: 2 } as const;

export type OnboardingAct = (typeof ACT)[keyof typeof ACT];

/**
 * Which act the flow is in. Reaching the first event outranks the step, because
 * "the recorder is live" is true no matter which screen is open, and a visitor
 * who steps Back after connecting should not lose the payoff.
 */
export function onboardingAct(stepIndex: number, isRecording: boolean): OnboardingAct {
  if (isRecording) return ACT.live;
  return stepIndex === 0 ? ACT.identity : ACT.promise;
}

/** Every stage delay, in ms after its trigger. The only place timing lives. */
export const TIMING = {
  firstPaint: 60, // rail and heading lead the first paint together
  support: 120, // supporting line follows the heading
  body: 180, // field / code card / status card follows
  action: 220, // primary action lands last
  frame: 300, // form frame settles at the new step's height
  previewPage: 180, // preview's tab row answers the step it just entered
  arrivalInstalled: 0, // the card being watched flips to Installed, first
  arrivalLift: 260, // then the frame lifts under it
  arrivalLive: 420, // then the tab row travels to Live in its watching state
  check: 500, // success check finishes drawing
  shake: 280, // transitions.dev error-state shake, matches onboarding.css
  websiteValidation: 1_000, // quiet window before an invalid typed URL is reported
} as const;

/**
 * Which dashboard page the preview is parked on. The camera holds still through
 * acts 1 and 2, so this — not a camera stop — is what the right pane says on
 * steps two and three.
 */
export const PREVIEW_PAGE = { install: "install", live: "live", overview: "overview" } as const;

export type OnboardingPreviewPage = (typeof PREVIEW_PAGE)[keyof typeof PREVIEW_PAGE];

/**
 * The page the preview is heading to. One value drives both the tab row and the
 * body, for the same reason `ACT` is one integer: the steps are routes and
 * cannot see each other, so anything derived per-step drifts.
 *
 * Step two is the Install page, and that page is where the waiting is shown —
 * not because the snippet lives there, but because the real Install page's own
 * verify card is already the product's "waiting for the first event" state. The
 * event is what moves the preview to Live, and nothing else does.
 */
export function previewPage(stepIndex: number, isRecording: boolean): OnboardingPreviewPage {
  if (isRecording || stepIndex >= 2) return PREVIEW_PAGE.live;
  return stepIndex === 1 ? PREVIEW_PAGE.install : PREVIEW_PAGE.overview;
}

/* The preview's page change: the travelling tab notch, and the body under it.
 *
 * The notch itself has no spring here on purpose. It is the product's own
 * `top-nav-notch` layout animation in `AppShell`, so the preview inherits
 * whatever the real dashboard does; giving onboarding a second spring for the
 * same control is how the preview would start drifting from the product.
 *
 * The body only cross-fades and rises. It does not clear a blur the way the
 * left column's chunks do: those are text being read, this is a picture of a
 * page, and blurring it reads as the camera losing focus. */
export const PREVIEW_BODY = {
  riseY: 6, // px the arriving page rises from
  spring: { type: "spring" as const, duration: 0.38, bounce: 0 },
} as const;

/* The Live page filling, which is act 2's payoff inside the preview.
 *
 * The card carries two known heights — the signal watch, then the badge and one
 * row — so it tweens on the same card-resize recipe step two's code card uses,
 * for the same reason: framer-motion's `layout="size"` fakes the size with a
 * transform and would squash whichever content is inside it mid-flight.
 *
 * Nothing here invents a visitor. The row appears only after the exact first
 * session is present in Live, while its path, place and elapsed time remain
 * placeholder bars. */
export const PREVIEW_LIVE = {
  watchHeight: 344, // px, the collage over its title, description and action
  filledHeight: 108, // px, the "Live now" badge above one session row
  rowRiseY: 8, // px the badge and row rise from as the watch leaves
  spring: { type: "spring" as const, duration: 0.42, bounce: 0 },
} as const;

/* ── THE EXIT ─────────────────────────────────────────────
 *
 * The frame grows to fill the screen while the form column falls away, so the
 * picture becomes the thing. The route changes behind a frame that already
 * covers the viewport, which turns the swap from a page change into an arrival.
 *
 * The alternative that was built and compared against it — a line saying
 * "Getting your dashboard ready" over an unmoved frame, then a plain route
 * change — is gone. It was the safer of the two and it read as a caption on a
 * picture you were about to leave, which is the opposite of what the last beat
 * of this flow is for.
 */

/* The exit: the frame grows from its inset to cover the viewport.
 *
 * Scale and offset are measured at the moment it starts rather than derived
 * from the stage's own numbers — the frame is sized in svh and percentages, so
 * the only honest source is its own bounding box against the window.
 *
 * It runs long. A cut this size is the flow's last gesture and the thing it
 * hands over to has to be ready underneath, so the route change waits for it. */
export const PREVIEW_EXIT = {
  /** ms the grow runs before the route changes under it. */
  duration: 560,
  /** The form column leaves first and faster: it is being handed over from. */
  columnDuration: 320,
  columnX: -16, // px it slides as it goes
  ease: [0.22, 1, 0.36, 1] as const,
} as const;

/* The verify card's listening ripple during the wait, on the Install page.
 *
 * One ring per poll, fired by the request itself rather than by a loop. A
 * spinner says "something is happening" for as long as it spins and means
 * nothing after the first second; a ring every three seconds says "I just
 * checked, and I will check again" — and the stillness between rings is what
 * makes each one land. The duration is in `onboarding.css` with the keyframes;
 * there is no JS timer to keep it in step with. */
/** One integer drives the favicon's empty, loading, and revealed sequence. */
export const FAVICON_STAGE = { empty: 0, loading: 1, revealed: 2 } as const;

/** Favicon entrance shared by the field and preview switcher. */
export const FAVICON_SLOT = {
  size: 16, // px, matches the real switcher's compact identity mark
  parentGap: 8, // px, cancelled while empty so no phantom gap is reserved
  enterX: 6, // px, clipped by the growing slot for a left-to-right entrance
  enterBlur: 2, // px, the brief loading blur before the slot settles
  enterDuration: 250, // ms, quick enough to follow the input's quiet window
  enterEase: "cubic-bezier(0.22, 1, 0.36, 1)",
} as const;

/* Progress rail above the form column. One part per step, each drawn in the
   divider's own two-row lattice; the parts fill in CSS (see onboarding.css, THE
   STEP RAIL), so the only value the component needs from here is the height. */
export const RAIL = {
  /* 5px: two 2px lattice rows and the 1px between them, the same rule the
     divider on step two draws. */
  height: 5,
  /* Geometry and timing the twinkle canvas has to agree with, because it draws
     into the same lattice the CSS does and must not light a cell the fill has
     not reached. All four are restated in onboarding.css under THE STEP RAIL;
     change one and the other has to follow. */
  pitch: 3, // px between cells
  cell: 2, // px of one cell
  speed: 900, // ms for the light to cross the whole rail
  delay: 60, // ms before it starts, the heading's own lead
} as const;

/* The step rail's fill, as percentages of `--amber` and one blur radius. These
   are what onboarding.css falls back to (THE STEP RAIL) and what
   `/local-labs/step-rail` starts its dials at — the stylesheet cannot read a TS
   constant, so the two are restated and have to be changed together. */
export const STEP_RAIL_FILL = {
  near: 100, // % amber on the near row
  far: 58, // % amber on the far row
  glowTight: 100, // % amber in the tight ring
  glowWide: 37, // % amber in the wide falloff
  glowRadius: 9, // px of the wide falloff
} as const;

/* Step forms entering the 394px column.
 * transitions.dev "page side-by-side": 8px travel, 3px cross-blur and the
 * reference's exact 250ms smooth-out curve. */
export const STEP = {
  travelX: 8, // px the step slides along the direction of travel
  blur: 3, // px blur it clears on the way in
  transition: { duration: 0.25, ease: [0.22, 1, 0.36, 1] as const },
} as const;

/* Heading, supporting line, body and action inside one step.
 * transitions.dev "texts reveal": a 12px rise with a cross-blur, staggered in
 * reading order. Tightened from the reference 40ms so the primary action is
 * already legible by the time the pointer arrives. */
export const REVEAL = {
  riseY: 12, // px each chunk rises from
  blur: 3, // px blur it clears on the way up
  spring: { type: "spring" as const, duration: 0.42, bounce: 0 },
  /** Delay per chunk, in seconds, in reading order. */
  delays: {
    heading: 0,
    support: (TIMING.support - TIMING.firstPaint) / 1_000,
    body: (TIMING.body - TIMING.firstPaint) / 1_000,
    action: (TIMING.action - TIMING.firstPaint) / 1_000,
  },
  /** Extra lead-in applied only on the first paint of a visit. */
  firstPaintDelay: TIMING.firstPaint / 1_000,
} as const;

/* The form frame, which persists across step changes and owns the height
 * tween. transitions.dev "card resize": tween the height, smooth-out. */
export const FRAME = {
  spring: { type: "spring" as const, duration: TIMING.frame / 1_000, bounce: 0 },
} as const;

/* The dashboard preview camera in the right pane.
 *
 * This is a camera pushing in on a subject, not a box being scaled up. The
 * stage's transform origin is its top-left corner, so scaling alone sends every
 * element away from that corner: the switcher used to travel 169px right and
 * 136px down while growing, which reads as the nav bar re-laying itself out
 * rather than as the camera moving closer. Anchoring the subject's on-screen
 * position across the scale change is what makes it read as a dolly-in.
 */
export const CAMERA = {
  /**
   * The subject, in unscaled stage coordinates: the project switcher's centre.
   * Measured against the real AppShell inside the 1100x1080 stage; the
   * `onboarding-camera` test fails if the header's layout moves it.
   */
  target: { x: 264, y: 25 },
  /**
   * The brand mark's left edge in stage coordinates. The hard constraint on how
   * far the camera can bias toward the switcher: the mark must stay inside the
   * frame, because cropping the logo is what sank an earlier framing.
   */
  brandX: 30,
  overview: {
    scale: 0.78, // the whole dashboard at rest, flush to the frame's top-left
    x: 0,
    y: 0,
  },
  projectFocus: {
    /**
     * 1.01 came from measuring a reference framing and was the right correction
     * to 1.42, which was so deep the dashboard stopped reading as a dashboard.
     * 1.18 pushes further toward the switcher while still showing the metric
     * band and the behaviour card: about 60% of the dashboard's width against
     * 76% at 1.01 and only 46% at 1.42.
     */
    scale: 1.18,
    /**
     * A small leftward bias so the push reads as going *toward* the switcher
     * rather than merely enlarging everything from the corner. It cannot go much
     * further: the subject sits 264px into the stage and the brand only 30px, so
     * biasing enough to hold the switcher's column would put the brand outside
     * the frame. At this offset the mark still clears the edge by ~11px.
     */
    x: -24,
    /**
     * Zero, and it stays zero. `y: 120` once shoved the header into mid-frame
     * behind a band of empty canvas, which read as the nav bar re-laying itself
     * out rather than as a camera move.
     */
    y: 0,
  },
  /**
   * How much of the stage's scale change each depth plane takes, as a fraction
   * of the nominal delta. This is what separates a dolly from a zoom: a zoom
   * changes focal length and every plane magnifies together, while a camera that
   * physically moves makes near planes travel further than far ones.
   *
   * The dotted canvas is painted by the frame, which does not scale, so it used
   * to sit at 0 while the dashboard grew 29% over it — a background that ignores
   * the camera entirely, which reads as content sliding on glass rather than as
   * a room the camera is moving through.
   */
  parallax: {
    /** The dotted grid behind everything. The dashboard itself is the nominal 1. */
    canvas: 0.35,
  },
  /* No rack focus here, and it is not an omission. Depth of field needs
   * distance, and this frame has none to spend: the only plane genuinely far
   * enough to defocus is the dotted canvas, which is 1px dots at 5% opacity
   * showing across about 5% of the frame, so blurring it erases something that
   * was never visible. The header and the workspace card are separated by a few
   * pixels of shadow, so defocusing one and not the other would invent depth —
   * the same reason the nav row does not get its own parallax coefficient.
   * A 1px blur shipped here briefly and was reverted for being invisible. */
  /**
   * A push-in is decisive and a pull-out is a reveal, so they are not the same
   * move played backwards. Film convention gives the pull-out more time; equal
   * timings made blurring the field feel like the camera snapped back.
   */
  spring: { type: "spring" as const, duration: 0.52, bounce: 0.12 },
  releaseSpring: { type: "spring" as const, duration: 0.76, bounce: 0 },
} as const;

/**
 * The grid plane's own scale for a given camera scale. Expressed as
 * magnification relative to the resting stop, so the grid is untouched at rest
 * (1) and takes only its share of the push (about 1.10 at focus).
 *
 * This drives a transform on a dedicated grid layer rather than the frame's
 * `background-size`: background-size is not GPU-composited, so animating it
 * would repaint a full-frame image on every frame of the spring.
 */
export function canvasParallaxScale(cameraScale: number): number {
  const magnification = cameraScale / CAMERA.overview.scale;
  return 1 + (magnification - 1) * CAMERA.parallax.canvas;
}

/**
 * The amber LED lattice behind the highlighted switcher, in unscaled stage
 * coordinates. It rides inside the stage, so the camera scales it along with the
 * dashboard and it needs no measurement of its own.
 *
 * `EmberField` is brightest along its bottom edge and fades upward, so the box
 * ends just below the switcher: the bright row sits under the chip and the field
 * thins out around and above it, which reads as light spilling from the control
 * rather than a panel behind it. The box starts at the stage's top edge because
 * the switcher is only 10px down from it and anything taller would be clipped.
 */
export const SWITCHER_FIELD = {
  x: 132, // centred on the switcher's 264px centre
  y: 0,
  width: 264, // wider than the 132px switcher so the lattice reads around it
  height: 56, // bottom edge lands ~16px below the switcher
  fadePerRow: 0.1, // ~11 lattice rows in 56px, faded out by the top
  /**
   * Well above the toast's 1. `EmberField` gives 93% of its cells an alpha of
   * about `0.03 + 0.15 * random²`, which lands near 0.08 — invisible as amber on
   * this canvas, and swinging by 0.03 during the shimmer, so at the default the
   * field read as a few scattered static dots rather than a lattice. At 2.2 the
   * quiet majority sits near 0.18 and the bright 7% saturate, which is what
   * makes it a surface instead of speckle.
   */
  intensity: 2.2,
  /**
   * Scales shimmer depth and speed together. 1.6 pins the depth at its 0.48 cap
   * and doubles the rate, so cells visibly travel between about half and full
   * brightness instead of wobbling within a range too narrow to notice.
   */
  pulse: 1.6,
  /** Fades in with the highlight rather than snapping on mid-keystroke. */
  spring: { type: "spring" as const, duration: 0.32, bounce: 0 },
} as const;

/**
 * The lattice around the verify card while step two waits — act 1's highlight
 * vocabulary (see `SWITCHER_FIELD`, whose tuning notes explain `intensity` and
 * `pulse`; those are shared so the two moments read as one signal). The
 * geometry differs: this field is a frame, reaching `reach` px past every card
 * edge with the card's own footprint masked out, so the dots surround the card
 * instead of lying under its copy. `fadePerRow` is a fifth of the switcher's:
 * the fade has to survive the full card height to reach the top edge, not just
 * a 56px halo, and the slight bottom-heavy falloff it keeps reads as the card
 * being lit from below.
 */
export const WATCH_FIELD = {
  reach: 22,
  /**
   * Deeper below the card than beside it: the bottom band carries the fade
   * that dissolves the frame into the canvas, and at the shared 22px the
   * dissolve consumed the band — the dots under the card were gone before
   * they read as lit. The fade begins at the card's bottom edge and spends
   * exactly this reach.
   */
  reachBottom: 52,
  fadePerRow: 0.02,
  /**
   * Half again the switcher's 2.2. That value was tuned for a lattice sitting
   * directly under an amber-ringed control; this one carries the highlight
   * alone — no glow — and loses its lower rows to the bottom-fade mask, so at
   * 2.2 it read as background texture rather than a signal.
   */
  intensity: 3.4,
  pulse: SWITCHER_FIELD.pulse,
} as const;

/* The preview frame itself. Act 2's only move: a lift, because the frame is the
 * one thing on the right that can change without asserting something untrue.
 *
 * The deepening shadow that goes with the lift lives in `onboarding.css` under
 * `[data-live="true"]`, not here. That shadow also carries the frame's inset
 * hairlines, and animating `boxShadow` from JS would replace the whole property
 * and drop them, leaving the frame edgeless at the exact moment it lifts. */
export const PREVIEW_FRAME = {
  restY: 0, // px, the frame sits where its inset puts it
  liveY: -10, // px, lifted once the recorder is connected
  /**
   * s. Second beat of the staged arrival, not the first. The card the visitor is
   * already watching answers before anything moves — see `TIMING.arrival*` — and
   * only then does the frame respond. Three facts (it worked, you are live,
   * taking you there) used to land in one frame, which meant none of them was
   * read.
   */
  liveDelay: TIMING.arrivalLift / 1_000,
  spring: { type: "spring" as const, duration: 0.62, bounce: 0 },
} as const;

/**
 * Where the stage sits. The push scales about the frame's corner and biases
 * slightly toward the switcher, so it reads as going somewhere rather than just
 * getting bigger. The bias is bounded by `brandX`: the logo must stay inside the
 * frame.
 *
 * Naming is a transient override rather than a rung on the act ladder: the shell
 * only reports it on step 1, and gating it on `ACT.identity` as well would take
 * the push-in away from someone who stepped Back to change their website after
 * the recorder connected. Acts 1 and 2 otherwise share the wide resting stop on
 * purpose: the pull-back out of naming is the reveal, and holding it afterwards
 * is what makes the left pane read as the thing to attend to.
 */
export function cameraStop(isNaming: boolean): { scale: number; x: number; y: number } {
  const stop = isNaming ? CAMERA.projectFocus : CAMERA.overview;
  return { scale: stop.scale, x: stop.x, y: stop.y };
}

/* Verification signal and success check on step 3. */
export const VERIFY = {
  checkBlur: 8, // px the check clears as it appears
  checkSpring: { type: "spring" as const, duration: TIMING.check / 1_000, bounce: 0 },
  /**
   * ms before the handoff goes ahead regardless. This replaced a flat 900ms
   * hold, which was a number chosen to feel right and nothing more.
   *
   * The screen now waits on something real: the live query returning the session
   * the first event started, so the Live page it opens has that session on it
   * rather than an empty list a second before the poll catches up. This is only
   * the ceiling on that wait — a slow, empty or failing query must not strand
   * anyone on a screen that has finished saying what it had to say.
   */
  handoffCap: 4_000,
  /**
   * ms between live-query attempts while waiting for that session to surface.
   * Faster than the page's own 5s poll, because this is a handoff someone is
   * watching, not a background refresh.
   */
  handoffPoll: 700,
  /**
   * ms the preview's filled Live card is held before the cut starts. The card
   * flipping to "Live now" is the flow's payoff, and it lands at an unplanned
   * moment — whenever the poll returns — so without a floor the cut could start
   * on the same frame and the one thing the whole wait was for would never be
   * read. The button skips this along with everything else.
   */
  payoffHold: 900,
  strokeSpring: { type: "spring" as const, duration: 0.42, bounce: 0 },
} as const;

/** Seconds from a storyboard value in ms. */
export function seconds(milliseconds: number): number {
  return milliseconds / 1_000;
}
