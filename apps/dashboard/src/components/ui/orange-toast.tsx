import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { Toast, type ToastObject } from "@base-ui/react/toast";
import { LoadingIndicator } from "./loading-indicator";
import { AlertCircle, Check, Info, X, type IconComponent } from "../../lib/icon-map";
import { useReducedMotion } from "../../lib/motion";
import styles from "./orange-toast.module.css";

const orangeToastVariants = ["default", "success", "error", "warning", "info", "loading"] as const;

export type OrangeToastVariant = (typeof orangeToastVariants)[number];

const variantIcons: Record<OrangeToastVariant, IconComponent | null> = {
  default: null,
  success: Check,
  error: X,
  warning: AlertCircle,
  info: Info,
  loading: null,
};

const celebrationAssets: Record<OrangeToastVariant, string> = {
  default: "/visuals/orange-replay-toast-particles-default.png",
  success: "/visuals/orange-replay-toast-particles-success.png",
  error: "/visuals/orange-replay-toast-particles-error.png",
  warning: "/visuals/orange-replay-toast-particles-warning.png",
  info: "/visuals/orange-replay-toast-particles-info.png",
  loading: "/visuals/orange-replay-toast-particles-loading.png",
};

const originalPixelParticleAsset = "/visuals/orange-replay-toast-logo-particles-b.png";

/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD
 *
 * Read top-to-bottom. Each value is ms after Base UI updates
 * the promise toast from loading to its finished state.
 *
 *   0ms   old message exits upward with blur
 * 150ms   visual state, icon pair, colors, and particles swap
 * ~166ms  new message enters from below after one paint
 * 400ms   icon crossfade settles; the finished state stays still
 * ───────────────────────────────────────────────────────── */
const TOAST_STATE_TIMING = {
  messageExit: 150,
  iconSwap: 250,
} as const;

type ToastVisualStage = 0 | 1 | 2 | 3;

interface ToastVisualContent {
  title: ReactNode;
  variant: OrangeToastVariant;
}

interface ToastVisualTransition {
  current: ToastVisualContent;
  previous: ToastVisualContent | null;
  stage: ToastVisualStage;
}

export function OrangeToastProvider({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider>
      {children}
      <Toast.Portal>
        <Toast.Viewport className={styles.viewport}>
          <OrangeToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

export function useOrangeToast() {
  return Toast.useToastManager();
}

export function OrangeToastPreview({
  actionLabel,
  title,
  variant,
}: {
  actionLabel?: string;
  title: ReactNode;
  variant: OrangeToastVariant;
}) {
  const hasAction = Boolean(actionLabel);

  return (
    <div
      aria-hidden
      className={styles.toastPreview}
      data-has-action={hasAction ? "true" : undefined}
      data-testid="orange-toast-preview"
      data-variant={variant}
    >
      <div className={styles.toastStage}>
        <ToastDecorations variant={variant} />
        <span className={styles.toastBackground} />

        <div className={styles.toastContent}>
          <ToastSignal currentVariant={variant} previousVariant={variant} showCurrent={false} />
          <div className={styles.toastMessageSlot}>
            <span className={`${styles.toastMessageText} t-text-swap`}>{title}</span>
          </div>
          {actionLabel ? (
            <span className={styles.toastAction}>{actionLabel}</span>
          ) : (
            <span className={styles.toastClose}>
              <X aria-hidden size={14} strokeWidth={1.75} />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function OrangeToastPreviewV2({
  actionLabel,
  title,
  variant,
}: {
  actionLabel?: string;
  title: ReactNode;
  variant: OrangeToastVariant;
}) {
  const hasAction = Boolean(actionLabel);

  return (
    <div
      aria-hidden
      className={styles.toastPreviewV2}
      data-has-action={hasAction ? "true" : undefined}
      data-testid="orange-toast-preview-v2"
      data-variant={variant}
    >
      <div className={styles.toastStage}>
        <ToastDecorations variant={variant} />
        <span className={styles.v2Background} />

        <div className={styles.v2Content}>
          <span className={styles.v2SignalRail}>
            <ToastSignalGlyph variant={variant} />
          </span>
          <div className={styles.v2MessageSlot}>
            <span className={styles.v2MessageText}>{title}</span>
          </div>
          {actionLabel ? (
            <span className={styles.v2Action}>{actionLabel}</span>
          ) : (
            <span className={styles.v2Close}>
              <X aria-hidden size={14} strokeWidth={1.75} />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function OrangeToastPreviewV3({
  actionLabel,
  title,
  variant,
}: {
  actionLabel?: string;
  title: ReactNode;
  variant: OrangeToastVariant;
}) {
  const hasAction = Boolean(actionLabel);

  return (
    <div
      aria-hidden
      className={styles.toastPreviewV3}
      data-has-action={hasAction ? "true" : undefined}
      data-testid="orange-toast-preview-v3"
      data-variant={variant}
    >
      <div className={styles.toastStage}>
        <ToastDecorations variant={variant} />
        <span className={styles.v3Background} />
        <span className={styles.v3Edge} />

        <div className={styles.v2Content}>
          <span className={`${styles.v2SignalRail} ${styles.v3SignalRail}`}>
            <ToastSignalGlyph variant={variant} />
          </span>
          <div className={styles.v2MessageSlot}>
            <span className={styles.v2MessageText}>{title}</span>
          </div>
          {actionLabel ? (
            <span className={`${styles.v2Action} ${styles.v3Action}`}>{actionLabel}</span>
          ) : (
            <span className={styles.v2Close}>
              <X aria-hidden size={14} strokeWidth={1.75} />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/* Semantic glyphs drawn from the logo's own 2px pixels on a 5×5 grid.
 * Cells are [column, row, opacity?]; loading uses the shared matrix. */
const v4PixelGlyphs: Record<
  Exclude<OrangeToastVariant, "default" | "loading">,
  [number, number, number?][]
> = {
  success: [
    [0, 2],
    [1, 3],
    [2, 2],
    [3, 1],
    [4, 0],
  ],
  error: [
    [0, 0],
    [4, 0],
    [1, 1],
    [3, 1],
    [2, 2],
    [1, 3],
    [3, 3],
    [0, 4],
    [4, 4],
  ],
  warning: [
    [2, 0],
    [2, 1],
    [2, 2],
    [2, 4],
  ],
  info: [
    [2, 0],
    [2, 2],
    [2, 3],
    [2, 4],
  ],
};

function ToastPixelGlyph({ variant }: { variant: OrangeToastVariant }) {
  if (variant === "loading") {
    return <LoadingIndicator label="Loading notification" />;
  }

  if (variant === "default") {
    return <ToastSignalGlyph variant="default" />;
  }

  return (
    <span className={styles.v4PixelGlyph}>
      {v4PixelGlyphs[variant].map(([column, row, alpha]) => (
        <span
          key={`${column}-${row}`}
          style={{ gridColumn: column + 1, gridRow: row + 1, opacity: alpha }}
        />
      ))}
    </span>
  );
}

export function OrangeToastPreviewV4({
  actionLabel,
  title,
  variant,
}: {
  actionLabel?: string;
  title: ReactNode;
  variant: OrangeToastVariant;
}) {
  const hasAction = Boolean(actionLabel);

  return (
    <div
      aria-hidden
      className={styles.toastPreviewV4}
      data-has-action={hasAction ? "true" : undefined}
      data-testid="orange-toast-preview-v4"
      data-variant={variant}
    >
      <div className={styles.toastStage}>
        <ToastDecorations variant={variant} />

        <span className={styles.v4Tile}>
          <ToastPixelGlyph variant={variant} />
        </span>
        <div className={styles.v4Body}>
          <span className={styles.v4BodyMessage}>{title}</span>
          {actionLabel ? (
            <span className={styles.v4BodyAction}>{actionLabel}</span>
          ) : (
            <span className={styles.v4BodyClose}>
              <X aria-hidden size={14} strokeWidth={1.75} />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function OrangeToastPreviewV5({
  actionLabel,
  title,
  variant,
}: {
  actionLabel?: string;
  title: ReactNode;
  variant: OrangeToastVariant;
}) {
  const hasAction = Boolean(actionLabel);

  return (
    <div
      aria-hidden
      className={styles.toastPreviewV5}
      data-has-action={hasAction ? "true" : undefined}
      data-testid="orange-toast-preview-v5"
      data-variant={variant}
    >
      <div className={styles.toastStage}>
        <ToastDecorations variant={variant} />

        <div className={styles.v5Surface}>
          {variant === "loading" ? (
            <LoadingIndicator label="Loading notification" />
          ) : (
            <span className={styles.v5Dot} />
          )}
          <span className={styles.v5Message}>{title}</span>
          {actionLabel ? (
            <span className={styles.v5Action}>{actionLabel}</span>
          ) : (
            <span className={styles.v5Close}>
              <X aria-hidden size={14} strokeWidth={1.75} />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/* Deterministic PRNG so every render of a variant draws the same field. */
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

/* LED-matrix ember field: squares on a fixed lattice, per-cell brightness
 * randomized (mostly dim, a few bright pops), multiplied by a vertical fade
 * so the bottom row glows and the field dies out as it rises. Each cell
 * shimmers on its own slow sine wave; reduced motion renders the same field
 * once, statically, and offscreen canvases pause their loop. */
function ToastEmberCanvas({ variant }: { variant: OrangeToastVariant }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduceMotion = useReducedMotion();

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const { width, height } = canvas.getBoundingClientRect();
    const devicePixels = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * devicePixels);
    canvas.height = Math.round(height * devicePixels);
    context.scale(devicePixels, devicePixels);
    const fillColor = getComputedStyle(canvas).color;

    let seed = 7;
    for (let index = 0; index < variant.length; index += 1) {
      seed = (seed * 31 + variant.charCodeAt(index)) >>> 0;
    }
    const random = mulberry32(seed || 1);

    const pitch = 5;
    const size = 2;
    const rows = Math.floor(height / pitch);
    const cells: {
      alpha: number;
      phase: number;
      speed: number;
      sway: number;
      x: number;
      y: number;
    }[] = [];
    for (let row = 0; row < rows; row += 1) {
      const y = height - size - 1 - row * pitch;
      const fade = 1 - row * 0.32;
      if (fade <= 0) continue;
      for (let x = 2; x < width - size; x += pitch) {
        const base = random();
        const isBright = random() > 0.92;
        const brightness = isBright ? 0.3 + 0.18 * random() : 0.03 + 0.16 * base * base;
        cells.push({
          alpha: brightness * fade,
          phase: random() * Math.PI * 2,
          speed: 1 + random() * 2,
          sway: isBright ? 0.5 : 0.35,
          x,
          y,
        });
      }
    }

    function draw(timeMs: number) {
      if (!context) return;
      context.clearRect(0, 0, width, height);
      context.fillStyle = fillColor;
      for (const cell of cells) {
        const shimmer = 1 + cell.sway * Math.sin((timeMs / 1000) * cell.speed + cell.phase);
        context.globalAlpha = Math.min(0.55, Math.max(0, cell.alpha * shimmer));
        context.fillRect(cell.x, cell.y, size, size);
      }
    }

    if (reduceMotion) {
      // The same field, drawn once with every cell at its resting brightness.
      context.fillStyle = fillColor;
      for (const cell of cells) {
        context.globalAlpha = cell.alpha;
        context.fillRect(cell.x, cell.y, size, size);
      }
      return;
    }

    let frame = 0;
    let running = false;

    function loop(timeMs: number) {
      draw(timeMs);
      frame = window.requestAnimationFrame(loop);
    }

    function start() {
      if (running) return;
      running = true;
      frame = window.requestAnimationFrame(loop);
    }

    function stop() {
      if (!running) return;
      running = false;
      window.cancelAnimationFrame(frame);
    }

    let observer: IntersectionObserver | undefined;
    if (typeof IntersectionObserver === "undefined") {
      start();
    } else {
      observer = new IntersectionObserver(([entry]) => {
        if (entry?.isIntersecting) {
          start();
        } else {
          stop();
        }
      });
      observer.observe(canvas);
    }

    return () => {
      stop();
      observer?.disconnect();
    };
  }, [reduceMotion, variant]);

  return <canvas className={styles.v6Canvas} ref={canvasRef} />;
}

export function OrangeToastPreviewV6({
  actionLabel,
  title,
  variant,
}: {
  actionLabel?: string;
  title: ReactNode;
  variant: OrangeToastVariant;
}) {
  const hasAction = Boolean(actionLabel);

  return (
    <div
      aria-hidden
      className={styles.toastPreviewV6}
      data-has-action={hasAction ? "true" : undefined}
      data-testid="orange-toast-preview-v6"
      data-variant={variant}
    >
      <div className={styles.toastStage}>
        <ToastDecorations variant={variant} />
        <span className={styles.v6Background} />
        <span className={styles.v6Edge} />
        <span className={styles.v6Field}>
          <ToastEmberCanvas variant={variant} />
        </span>

        <div className={styles.v2Content}>
          <span className={styles.v6Signal}>
            <ToastSignalGlyph variant={variant} />
          </span>
          <div className={`${styles.v2MessageSlot} ${styles.v6MessageSlot}`}>
            <span className={styles.v2MessageText}>{title}</span>
          </div>
          {actionLabel ? (
            <span className={`${styles.v2Action} ${styles.v6Action}`}>{actionLabel}</span>
          ) : (
            <span className={`${styles.v2Close} ${styles.v6Close}`}>
              <X aria-hidden size={14} strokeWidth={1.75} />
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function OrangeToastList() {
  const { toasts } = Toast.useToastManager();

  return toasts.map((toast, index) => (
    <OrangeToastItem index={index} key={toast.id} toast={toast} />
  ));
}

function OrangeToastItem({
  index,
  toast,
}: {
  index: number;
  toast: ToastObject<Record<string, unknown>>;
}) {
  const targetVariant = resolveToastVariant(toast.type);
  const visual = useToastVisualTransition(targetVariant, toast.title);
  const variant = visual.current.variant;
  const previousVariant = visual.previous?.variant ?? variant;
  const showCurrentIcon = visual.previous !== null && visual.stage >= 2;
  const hasAction = Boolean(toast.actionProps?.children);
  const isFront = index === 0;

  const messageClassName = [
    styles.toastMessageText,
    styles.v6LiveMessage,
    "t-text-swap",
    visual.stage === 1 ? "is-exit" : undefined,
    visual.stage === 2 ? "is-enter-start" : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(" ");

  return (
    <Toast.Root
      className={styles.toastRoot}
      data-front={isFront ? "true" : undefined}
      data-has-action={hasAction ? "true" : undefined}
      data-testid="orange-toast"
      data-variant={variant}
      data-visual-stage={visual.stage}
      swipeDirection={["down", "right"]}
      toast={toast}
    >
      <div className={styles.toastExit}>
        <div className={styles.toastStage}>
          {isFront && <ToastDecorations key={`${toast.id}:${variant}`} variant={variant} />}

          <span aria-hidden className={styles.v6Background} />
          <span aria-hidden className={styles.v6Edge} />
          <span aria-hidden className={styles.v6Field}>
            <ToastEmberCanvas variant={variant} />
          </span>

          <Toast.Content className={styles.toastContent}>
            <ToastSignal
              bare
              currentVariant={variant}
              previousVariant={previousVariant}
              showCurrent={showCurrentIcon}
            />
            <div className={styles.toastMessageSlot}>
              <Toast.Title className={messageClassName}>{visual.current.title}</Toast.Title>
            </div>
            <Toast.Action className={`${styles.toastAction} ${styles.v6LiveAction}`} />
            {!hasAction && (
              <Toast.Close
                aria-label="Dismiss notification"
                className={`${styles.toastClose} ${styles.v6LiveClose}`}
              >
                <X aria-hidden size={14} strokeWidth={1.75} />
              </Toast.Close>
            )}
          </Toast.Content>
        </div>
      </div>
    </Toast.Root>
  );
}

function resolveToastVariant(type: string | undefined): OrangeToastVariant {
  return orangeToastVariants.includes(type as OrangeToastVariant)
    ? (type as OrangeToastVariant)
    : "default";
}

function useToastVisualTransition(
  variant: OrangeToastVariant,
  title: ReactNode,
): ToastVisualTransition {
  const reduceMotion = useReducedMotion();
  const currentVisual = useRef<ToastVisualContent>({ title, variant });
  const [visual, setVisual] = useState<ToastVisualTransition>(() => ({
    current: { title, variant },
    previous: null,
    stage: 0,
  }));

  useLayoutEffect(() => {
    const current = currentVisual.current;
    const next = { title, variant };

    if (current.variant === next.variant && Object.is(current.title, next.title)) {
      setVisual((existing) =>
        existing.stage === 0 ? existing : { current, previous: null, stage: 0 },
      );
      return;
    }

    if (reduceMotion) {
      currentVisual.current = next;
      setVisual({ current: next, previous: null, stage: 0 });
      return;
    }

    let enterFrame = 0;
    let settleTimer = 0;
    setVisual({ current, previous: current, stage: 1 });

    const swapTimer = window.setTimeout(() => {
      currentVisual.current = next;
      setVisual({ current: next, previous: current, stage: 2 });

      enterFrame = window.requestAnimationFrame(() => {
        setVisual({ current: next, previous: current, stage: 3 });
      });

      settleTimer = window.setTimeout(() => {
        setVisual({ current: next, previous: null, stage: 0 });
      }, TOAST_STATE_TIMING.iconSwap);
    }, TOAST_STATE_TIMING.messageExit);

    return () => {
      window.clearTimeout(swapTimer);
      window.cancelAnimationFrame(enterFrame);
      window.clearTimeout(settleTimer);
    };
  }, [reduceMotion, title, variant]);

  return visual;
}

function ToastSignal({
  bare = false,
  currentVariant,
  previousVariant,
  showCurrent,
}: {
  bare?: boolean;
  currentVariant: OrangeToastVariant;
  previousVariant: OrangeToastVariant;
  showCurrent: boolean;
}) {
  return (
    <span
      aria-hidden
      className={bare ? `${styles.toastSignal} ${styles.toastSignalBare}` : styles.toastSignal}
      data-toast-signal
    >
      <span className="t-icon-swap" data-state={showCurrent ? "b" : "a"} data-toast-icon-swap>
        <span className="t-icon" data-icon="a" data-toast-signal-variant={previousVariant}>
          <ToastSignalGlyph variant={previousVariant} />
        </span>
        <span className="t-icon" data-icon="b" data-toast-signal-variant={currentVariant}>
          <ToastSignalGlyph variant={currentVariant} />
        </span>
      </span>
    </span>
  );
}

function ToastSignalGlyph({ variant }: { variant: OrangeToastVariant }) {
  if (variant === "loading") {
    return <LoadingIndicator label="Loading notification" />;
  }

  const VariantIcon = variantIcons[variant];

  return VariantIcon ? (
    <VariantIcon size={14} strokeWidth={2} />
  ) : (
    <span className={styles.toastBrandMark}>
      <span />
      <span />
      <span />
    </span>
  );
}

function ToastDecorations({ variant }: { variant: OrangeToastVariant }) {
  const celebrationAsset = celebrationAssets[variant];

  return (
    <span aria-hidden className={styles.decorations}>
      <ToastParticle asset={originalPixelParticleAsset} className={styles.particleLeft} />
      <ToastParticle asset={originalPixelParticleAsset} className={styles.particleCenter} />
      <ToastParticle asset={celebrationAsset} className={styles.particleRight} />
      <ToastParticle asset={celebrationAsset} className={styles.particleBottom} />
    </span>
  );
}

function ToastParticle({ asset, className }: { asset: string; className?: string }) {
  const particleClassName = [styles.particle, className]
    .filter((value): value is string => value !== undefined)
    .join(" ");

  return (
    <span className={particleClassName} data-toast-particle data-toast-particle-asset={asset}>
      <span className={styles.particleDrift}>
        <span className={styles.particleVisual} style={{ backgroundImage: `url(${asset})` }} />
      </span>
    </span>
  );
}
