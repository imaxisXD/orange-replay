import { useLayoutEffect, useRef } from "react";

/* ─────────────────────────────────────────────────────────
 * THE STEP RAIL'S TWINKLE
 *
 * `EmberField`'s shimmer, run on the step rail's own lattice: every cell in the
 * reached part carries its own brightness, its own phase and its own speed, and
 * rides a slow sine on all three. No cell shares a clock with its neighbour, so
 * what you see is cells coming up and going down in no order — the effect the
 * product already draws behind the toast, the switcher and the watched card,
 * rather than a new one invented for this rule.
 *
 * Canvas, for the same reason `EmberField` is one: there is no cell to select.
 * The lattice is a repeating background, so per-cell timing in CSS would mean an
 * element per cell — around 260 of them on a 394px rail.
 *
 * The reached edge is computed here rather than read from the DOM: the fill is a
 * CSS animation, and asking the compositor where it is every frame would be a
 * layout read per frame. Both sides run the same numbers from `RAIL` instead, so
 * a cell never lights ahead of the light that is supposed to have reached it.
 * ───────────────────────────────────────────────────────── */

export interface StepRailTwinkleConfig {
  /** Multiplies every cell's brightness. `EmberField`'s own `intensity`. */
  intensity: number;
  /** Scales shimmer depth and speed together. `EmberField`'s own `pulse`. */
  pulse: number;
  /** Share of cells that burn brighter than the rest, 0–1. */
  brightShare: number;
  /** The far row's share of the near row's brightness, 0–1. */
  farShare: number;
}

/** Tuned in `/local-labs/step-rail`; these are what the flow ships with. */
/* Tuned in `/local-labs/step-rail`, 2026-08-05.

   `brightShare` is zero on purpose: with no cells in the bright band every cell
   sits in the quiet one, and intensity carries the whole field instead of a
   scattered few. `pulse` at 4 pins the shimmer depth at its 0.48 cap and runs the
   sine four times as fast, so cells cross their whole range rather than breathing
   through part of it. */
export const STEP_RAIL_TWINKLE_DEFAULTS: StepRailTwinkleConfig = {
  intensity: 3.55,
  pulse: 4,
  brightShare: 0,
  farShare: 0.77,
};

/** The lit cell's colour, one step past the amber the fill is drawn in. */
const CELL_COLOR = "oklch(0.98 0.035 92)";
/** px of canvas above and below the rail, so nothing is cut at the rule's edge. */
const BLEED = 6;

interface Cell {
  /** Resting alpha, before intensity and the shimmer scale it. */
  alpha: number;
  column: number;
  phase: number;
  /** 0 is the far row, 1 the near row. */
  row: 0 | 1;
  speed: number;
}

export interface StepRailGeometry {
  /** Fraction of the rail the fill starts this run at, 0–1. */
  from: number;
  /** Fraction of the rail the fill ends this run at, 0–1. */
  to: number;
  /** ms the run takes, matching the CSS fill. */
  duration: number;
  /** ms before the run starts, matching the CSS fill. */
  delay: number;
  /** px between cells. */
  pitch: number;
  /** px of one cell. */
  cell: number;
}

/* Deterministic PRNG so the field lays out the same on every mount — the same
   `mulberry32` `EmberField` uses, for the same reason. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Where the fill's edge is, as a fraction, at `elapsed` ms after mount. Linear,
 * because the CSS fill is linear — the two have to agree at every frame.
 */
function edgeAt(elapsed: number, { from, to, duration, delay }: StepRailGeometry): number {
  if (elapsed <= delay) return from;
  if (duration <= 0 || elapsed >= delay + duration) return to;
  return from + (to - from) * ((elapsed - delay) / duration);
}

function StepRailTwinkle({
  config = STEP_RAIL_TWINKLE_DEFAULTS,
  forceMotion = false,
  geometry,
}: {
  config?: StepRailTwinkleConfig;
  /**
   * Run the shimmer even when the browser asks for reduced motion. For the lab
   * only: with the OS setting on, the field holds one frame and there is nothing
   * to tune, which reads as a broken panel rather than as a respected setting.
   */
  forceMotion?: boolean;
  geometry: StepRailGeometry;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Read through refs so a dial change retunes the running loop instead of
  // tearing it down and relaying the whole field mid-shimmer.
  const configRef = useRef(config);
  const geometryRef = useRef(geometry);
  configRef.current = config;
  geometryRef.current = geometry;

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const context = canvas.getContext("2d");
    if (context === null) return;

    let width = 0;
    let height = 0;
    let cells: Cell[] = [];

    /* Measure and lay the field out together: the cell list is per column, so a
       resize is a relayout, not just a rescale. */
    const layout = () => {
      width = canvas.offsetWidth;
      height = canvas.offsetHeight;
      const devicePixels = window.devicePixelRatio || 1;
      canvas.width = Math.round(width * devicePixels);
      canvas.height = Math.round(height * devicePixels);
      context.setTransform(devicePixels, 0, 0, devicePixels, 0, 0);

      const rail = geometryRef.current;
      const settings = configRef.current;
      const random = mulberry32(41);
      const columns = Math.max(0, Math.ceil(width / rail.pitch));
      const next: Cell[] = [];
      for (let column = 0; column < columns; column += 1) {
        for (const row of [0, 1] as const) {
          const base = random();
          const isBright = random() < settings.brightShare;
          // The two brightness bands `EmberField` draws: a few cells that carry
          // the field, and a quiet majority that only just registers.
          // The gap between the two bands is what makes the shimmer legible: this
          // light lands on cells the fill has already lit, so a field that is
          // uniformly half-bright reads as a slightly paler row, not as movement.
          const brightness = isBright ? 0.45 + 0.3 * random() : 0.02 + 0.12 * base * base;
          next.push({
            alpha: brightness * (row === 1 ? 1 : settings.farShare),
            column,
            phase: random() * Math.PI * 2,
            row,
            speed: 0.8 + random() * 1.6,
          });
        }
      }
      cells = next;
    };
    layout();
    const observer = new ResizeObserver(layout);
    observer.observe(canvas);

    // Reduced motion keeps the field and stops the shimmer: one still frame, the
    // same answer `EmberField` gives.
    const isStill = !forceMotion && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let startedAt = 0;
    let frame = 0;
    const draw = (now: number) => {
      if (!isStill) frame = requestAnimationFrame(draw);
      if (startedAt === 0) startedAt = now;
      const elapsed = now - startedAt;

      const settings = configRef.current;
      const rail = geometryRef.current;
      const reached = edgeAt(elapsed, rail) * width;
      const amplitude = Math.min(0.48, 0.3 * settings.pulse);
      const seconds = (isStill ? 0 : elapsed) / 1_000;

      context.clearRect(0, 0, width, height);
      context.fillStyle = CELL_COLOR;
      for (const cell of cells) {
        const x = cell.column * rail.pitch;
        // A cell the fill has not reached cannot be lit; the rest shimmer.
        if (x + rail.cell > reached) continue;
        const shimmer =
          1 - amplitude + amplitude * Math.sin(cell.phase + seconds * cell.speed * settings.pulse);
        // Clamp the cell's resting brightness, then let the shimmer scale it.
        // Clamping the product instead pins a bright cell at 1 for most of its
        // cycle: every number in the field keeps changing and the field looks
        // frozen, which is exactly how a too-high intensity used to read.
        const alpha = Math.min(0.95, cell.alpha * settings.intensity) * shimmer;
        if (alpha <= 0.01) continue;
        context.globalAlpha = alpha;
        context.fillRect(x, cell.row === 1 ? BLEED + rail.pitch : BLEED, rail.cell, rail.cell);
      }
      context.globalAlpha = 1;
    };
    frame = requestAnimationFrame(draw);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [forceMotion]);

  return (
    <canvas
      aria-hidden
      className="onboarding-step-rail-twinkle"
      ref={canvasRef}
      // A canvas is a replaced element: setting both `top` and `bottom` leaves it
      // at its intrinsic 2:1 ratio instead of stretching it, so the height is
      // stated outright.
      style={{ height: `calc(100% + ${BLEED * 2}px)`, top: -BLEED }}
    />
  );
}

export { StepRailTwinkle };
