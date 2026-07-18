import { useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/* Deterministic PRNG so the field draws the same lattice every render — same
   trick as the toast's ToastEmberCanvas, which this component generalizes. */
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

interface EmberFieldOptions {
  fadePerRow: number;
  intensity: number;
  pulse: number;
}

/* Measures the canvas, lays out the cell lattice, and starts the shimmer
   loop. Returns a cleanup that stops the loop. */
function startEmberField(
  canvas: HTMLCanvasElement,
  { fadePerRow, intensity, pulse }: EmberFieldOptions,
): (() => void) | undefined {
  const context = canvas.getContext("2d");
  if (!context) return undefined;

  // offsetWidth/Height instead of getBoundingClientRect so the lattice
  // measures correctly inside rotated wrappers.
  const width = canvas.offsetWidth;
  const height = canvas.offsetHeight;
  const devicePixels = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * devicePixels);
  canvas.height = Math.round(height * devicePixels);
  context.setTransform(devicePixels, 0, 0, devicePixels, 0, 0);
  const fillColor = getComputedStyle(canvas).color;

  const random = mulberry32(41);
  const pitch = 5;
  const size = 2;
  const rows = Math.floor(height / pitch);
  const cells: { alpha: number; phase: number; speed: number; x: number; y: number }[] = [];
  for (let row = 0; row < rows; row += 1) {
    const y = height - size - 1 - row * pitch;
    const fade = 1 - row * fadePerRow;
    if (fade <= 0) continue;
    for (let x = 2; x < width - size; x += pitch) {
      const base = random();
      const isBright = random() > 0.93;
      const brightness = isBright ? 0.35 + 0.2 * random() : 0.03 + 0.15 * base * base;
      cells.push({
        alpha: brightness * fade * intensity,
        phase: random() * Math.PI * 2,
        speed: (0.8 + random() * 1.6) * pulse,
        x,
        y,
      });
    }
  }

  function draw(timeMs: number) {
    if (!context) return;
    context.clearRect(0, 0, width, height);
    context.fillStyle = fillColor;
    const amplitude = Math.min(0.48, 0.3 * pulse);
    for (const cell of cells) {
      const shimmer =
        1 - amplitude + amplitude * Math.sin(cell.phase + (timeMs / 1000) * cell.speed);
      context.globalAlpha = Math.min(1, cell.alpha * shimmer);
      context.fillRect(cell.x, cell.y, size, size);
    }
    context.globalAlpha = 1;
  }

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    draw(0);
    return undefined;
  }
  let frame = 0;
  const loop = (timeMs: number) => {
    draw(timeMs);
    frame = requestAnimationFrame(loop);
  };
  frame = requestAnimationFrame(loop);
  return () => cancelAnimationFrame(frame);
}

/* The toast's LED-matrix ember field as a standalone surface decoration:
   2px squares on a 5px lattice, brightest along the bottom edge, each cell
   shimmering on its own slow sine wave. Color comes from the element's CSS
   `color`; the lattice relays out on resize. Reduced motion renders the same
   field once, statically. */
function EmberField({
  className,
  fadePerRow = 0.3,
  intensity = 1,
  pulse = 1,
}: {
  className?: string;
  /* Brightness lost per lattice row above the bottom edge; 0.3 matches the
     toast's short flame, smaller values fill taller surfaces. */
  fadePerRow?: number;
  /* Multiplies every cell's brightness; 1 matches the toast. */
  intensity?: number;
  /* Scales both shimmer depth and speed; 1 matches the toast's calm field. */
  pulse?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let stop = startEmberField(canvas, { fadePerRow, intensity, pulse });
    const observer = new ResizeObserver(() => {
      stop?.();
      stop = startEmberField(canvas, { fadePerRow, intensity, pulse });
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      stop?.();
    };
  }, [fadePerRow, intensity, pulse]);

  return (
    <canvas aria-hidden className={cn("pointer-events-none absolute", className)} ref={canvasRef} />
  );
}

export { EmberField };
