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
 *      0ms   first character pushes the camera in on the whole
 *            dashboard (scale 0.78 → 1.01) about the frame's
 *            top-left corner. Nothing translates, so the brand,
 *            nav, heading and metric band all hold position and
 *            simply get closer: a zoom, not a slide
 *      0ms   the dotted canvas travels at 0.35 of that rate, so
 *            the planes separate and the camera reads as moving
 *            into the room rather than the room magnifying
 *      0ms   the canvas also racks out of focus, 0 → 1px blur:
 *            closer focus means a shallower depth of field
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
  overview: {
    scale: 0.78, // the whole dashboard at rest, flush to the frame's top-left
  },
  projectFocus: {
    /**
     * Derived from the reference framing, measured two ways off its own
     * geometry so the retina factor cancels: the KPI band's height and its
     * four-column pitch both put it at 2.02x the unscaled stage in a 2x
     * capture, i.e. 1.01 CSS. 1.42 was far too deep — the dashboard stopped
     * being legible as a dashboard and became a wall of chrome.
     */
    scale: 1.01,
  },
  /**
   * Both stops sit flush at the frame's top-left, so the corner is the fixed
   * point and the zoom is a plain scale about it. Two earlier attempts added a
   * translate and both were wrong: `y: 120` shoved the header into mid-frame
   * behind a band of empty canvas, and cancelling the subject's drift with
   * `x: -169` cropped the brand. At this scale no translate is needed — the
   * subject drifts under 60px, which reads as a zoom rather than a slide.
   */
  offset: { x: 0, y: 0 },
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
  /**
   * Rack focus. Closer focus means a shallower depth of field, so the far plane
   * softens as the camera comes in. This is how a camera directs attention
   * inside a frame; differential scale between coplanar surfaces is not, and
   * would have read as the nav bar growing faster than the page.
   *
   * 1px, at the quiet end of this flow's blur vocabulary (steps reveal at 3px,
   * IconSwap at 4px), on a background already sitting at 5% opacity.
   */
  canvasBlur: { rest: 0, focus: 1 },
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
 * Where the stage sits. The frame's top-left corner is the fixed point at both
 * stops, so the zoom is a plain scale about that corner: the brand, the nav, the
 * page heading and the metric band all stay put and simply get closer. Nothing
 * is cropped and nothing slides.
 *
 * Naming is a transient override rather than a rung on the act ladder: the shell
 * only reports it on step 1, and gating it on `ACT.identity` as well would take
 * the push-in away from someone who stepped Back to change their website after
 * the recorder connected. Acts 1 and 2 otherwise share the wide resting stop on
 * purpose: the pull-back out of naming is the reveal, and holding it afterwards
 * is what makes the left pane read as the thing to attend to.
 */
export function cameraStop(isNaming: boolean): { scale: number; x: number; y: number } {
  const { x, y } = CAMERA.offset;
  return {
    scale: isNaming ? CAMERA.projectFocus.scale : CAMERA.overview.scale,
    x,
    y,
  };
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
