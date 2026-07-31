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
 *                     Held across install and while waiting.
 *   ACT 2  LIVE       the first event lands. The camera holds
 *                     and the frame lifts. Nothing else moves,
 *                     because nothing else can be said yet:
 *                     no session has finalised, so any number
 *                     the preview showed here would be a lie.
 *                     The lift is the whole payoff, and the
 *                     CTA takes it from there.
 *
 * ── BEATS ────────────────────────────────────────────────
 *
 * FIRST PAINT — once per visit
 *      0ms   canvas, rail and dashboard preview hold at rest
 *     60ms   progress rail fills to the opened step
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
 *    300ms   the persistent form frame finishes tweening to the
 *            new step's height
 *    360ms   progress rail reaches its new position
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
 *   blur     camera releases back to the whole dashboard
 *  invalid   field shakes 8px → 6px → 3px and settles
 *
 * ACT 1 → PROMISE — install, and waiting on step 3
 *      0ms   camera rests wide and flush; nothing on the right
 *            moves, so the left pane carries the whole step
 *      0ms   signal pulses amber while the poll runs
 *
 * ACT 2 → LIVE — the first event arrives
 *      0ms   signal turns green and the check strokes itself in
 *    180ms   the preview frame lifts 10px and its shadow deepens,
 *            held back so the eye is led left to right instead of
 *            being asked to watch two places at once
 *    500ms   check finishes drawing
 *    800ms   frame settles at its lifted rest
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
  railTravel: 360, // rail reaches the next step
  check: 500, // success check finishes drawing
  shake: 320, // invalid-URL shake, matches onboarding.css
} as const;

/* Progress rail above the form column */
export const RAIL = {
  height: 3, // px, a thin line rather than a bar
  spring: { type: "spring" as const, duration: TIMING.railTravel / 1_000, bounce: 0 },
} as const;

/* Step forms entering the 394px column.
 * transitions.dev "page side-by-side": 8px travel, 3px cross-blur, smooth-out,
 * expressed as this codebase's bounce-free spring. */
export const STEP = {
  travelX: 8, // px the step slides along the direction of travel
  blur: 3, // px blur it clears on the way in
  spring: { type: "spring" as const, duration: 0.25, bounce: 0 },
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
   * s. The lift waits for the check to start drawing on the left, because two
   * moves running at once in two places give the eye nothing to follow. This
   * leads it left to right: the fact lands, then the dashboard responds to it.
   */
  liveDelay: 0.18,
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
  strokeSpring: { type: "spring" as const, duration: 0.42, bounce: 0 },
} as const;

/** Seconds from a storyboard value in ms. */
export function seconds(milliseconds: number): number {
  return milliseconds / 1_000;
}
