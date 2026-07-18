import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { EmberField } from "@/components/ember-field";
import { ArrowUpRight } from "@/lib/icon-map";
import { m, useReducedMotion, type Transition } from "@/lib/motion";
import { AppShell } from "./app-shell";

/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD
 *
 * Read top-to-bottom. Each value is ms after the demo mounts.
 *
 *    0ms   dashboard waits at scale 0.94 and opacity 0
 *   50ms   dashboard scales and fades into place
 *  500ms   two teal paths leave the top center together
 *          and meet at the bottom center
 *    end   the edge settles to zero while the demo banner
 *          tab rises behind the dashboard's top-right edge
 * ───────────────────────────────────────────────────────── */

const WORKSPACE_REST = {
  opacity: 1,
  scale: 1,
  y: 0,
};

const EDGE_PATH = {
  initialLength: 0,
  finalLength: 1,
  initialOpacity: 0,
  radius: 11,
};

const NOTCH_LIT_BORDER = {
  dashLength: 12,
  gapLength: 4,
  layerOpacity: 0.85,
  strokeOpacity: 0.42,
};

export const DEMO_BANNER_NOTCH_MAX_VISIBLE_HEIGHT = 52;

export type DemoBannerAnimationConfig = {
  timing: {
    workspaceEnter: number;
    edgeDraw: number;
    notchDelay: number;
  };
  entry: {
    offsetY: number;
    startScale: number;
    startOpacity: number;
    spring: unknown;
  };
  edge: {
    strokeWidth: number;
    opacity: number;
    glowBlur: number;
    glowOpacity: number;
    spring: unknown;
    settle: {
      strokeWidth: number;
      opacity: number;
      glowBlur: number;
      glowOpacity: number;
      spring: unknown;
    };
  };
  notch: {
    height: number;
    visibleHeight: number;
    widthPercent: number;
    offsetX: number;
    cornerRadius: number;
    slantWidth: number;
    slantRadius: number;
    litBorderWidth: number;
    glowBlur: number;
    glowOpacity: number;
    dots: {
      fadePerRow: number;
      intensity: number;
      pulse: number;
    };
    spring: unknown;
  };
};

export const DEMO_BANNER_ANIMATION_DEFAULTS = {
  timing: {
    workspaceEnter: 50,
    edgeDraw: 500,
    notchDelay: 10,
  },
  entry: {
    offsetY: 0,
    startScale: 0.94,
    startOpacity: 0,
    spring: {
      type: "spring" as const,
      visualDuration: 0.95,
      bounce: 0.2,
    },
  },
  edge: {
    strokeWidth: 0.7,
    opacity: 0.92,
    glowBlur: 23,
    glowOpacity: 1,
    spring: {
      type: "spring" as const,
      visualDuration: 0.6,
      bounce: 0,
    },
    settle: {
      strokeWidth: 0,
      opacity: 0,
      glowBlur: 23,
      glowOpacity: 0,
      spring: {
        type: "spring" as const,
        visualDuration: 0.45,
        bounce: 0,
      },
    },
  },
  notch: {
    height: 81,
    visibleHeight: 42,
    widthPercent: 50,
    offsetX: -13,
    cornerRadius: 8,
    slantWidth: 48,
    slantRadius: 7,
    litBorderWidth: 2.8,
    glowBlur: 64,
    glowOpacity: 0,
    dots: {
      fadePerRow: 0.065,
      intensity: 4.3,
      pulse: 2.3,
    },
    spring: {
      type: "spring" as const,
      visualDuration: 0.8,
      bounce: 0.15,
    },
  },
} satisfies DemoBannerAnimationConfig;

export function DemoBannerAnimatedAppShell({
  children,
  config = DEMO_BANNER_ANIMATION_DEFAULTS,
  navigationPathname,
  showAccountAvatar = false,
}: {
  children?: ReactNode;
  config?: DemoBannerAnimationConfig;
  navigationPathname?: string;
  showAccountAvatar?: boolean;
}) {
  const reduceMotion = useReducedMotion() === true;
  const [stage, setStage] = useState(0);

  useEffect(() => {
    const workspaceDelay = reduceMotion ? 0 : config.timing.workspaceEnter;
    const edgeDelay = reduceMotion ? 0 : config.timing.edgeDraw;
    const timers = [
      window.setTimeout(
        () => setStage((currentStage) => Math.max(currentStage, 1)),
        workspaceDelay,
      ),
      window.setTimeout(() => setStage((currentStage) => Math.max(currentStage, 2)), edgeDelay),
    ];

    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [config.timing.edgeDraw, config.timing.workspaceEnter, reduceMotion]);

  const workspaceTransition = reduceMotion
    ? ({ duration: 0 } satisfies Transition)
    : (config.entry.spring as Transition);

  return (
    <AppShell
      navigationPathname={navigationPathname}
      showAccountAvatar={showAccountAvatar}
      workspaceMotion={{
        animate: reduceMotion
          ? { opacity: stage >= 1 ? WORKSPACE_REST.opacity : config.entry.startOpacity }
          : {
              opacity: stage >= 1 ? WORKSPACE_REST.opacity : config.entry.startOpacity,
              scale: stage >= 1 ? WORKSPACE_REST.scale : config.entry.startScale,
              y: stage >= 1 ? WORKSPACE_REST.y : config.entry.offsetY,
            },
        initial: reduceMotion
          ? { opacity: config.entry.startOpacity }
          : {
              opacity: config.entry.startOpacity,
              scale: config.entry.startScale,
              y: config.entry.offsetY,
            },
        transition: workspaceTransition,
        style: { overflow: "visible" },
      }}
      workspaceOverlay={
        <>
          <WorkspaceEdge
            edge={config.edge}
            onComplete={() => setStage((currentStage) => Math.max(currentStage, 3))}
            reduceMotion={reduceMotion}
            settled={stage >= 3}
            visible={stage >= 2}
          />
          <DemoBannerNotch
            delayMs={config.timing.notchDelay}
            notch={config.notch}
            reduceMotion={reduceMotion}
            visible={stage >= 3}
          />
        </>
      }
    >
      {children}
    </AppShell>
  );
}

function DemoBannerNotch({
  delayMs,
  notch,
  reduceMotion,
  visible,
}: {
  delayMs: number;
  notch: DemoBannerAnimationConfig["notch"];
  reduceMotion: boolean;
  visible: boolean;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [surfaceSize, setSurfaceSize] = useState({ height: 0, width: 0 });
  const visibleHeight = Math.min(
    notch.height,
    notch.visibleHeight,
    DEMO_BANNER_NOTCH_MAX_VISIBLE_HEIGHT,
  );
  const transition = reduceMotion
    ? ({ duration: 0 } satisfies Transition)
    : ({ ...(notch.spring as Transition), delay: delayMs / 1_000 } satisfies Transition);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (surface === null) return;

    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      const height = Math.round(entry.contentRect.height * 100) / 100;
      const width = Math.round(entry.contentRect.width * 100) / 100;
      setSurfaceSize((currentSize) =>
        currentSize.height === height && currentSize.width === width
          ? currentSize
          : { height, width },
      );
    });

    observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  const notchPaths = createNotchPaths(
    surfaceSize.width,
    surfaceSize.height,
    notch.slantWidth,
    notch.slantRadius,
    notch.cornerRadius,
  );
  const borderMask = createLitBorderMask(notch.slantWidth);

  return (
    <div
      className="pointer-events-none absolute right-0 bottom-[calc(100%-1px)] z-20 overflow-hidden"
      data-demo-banner-notch
      style={{
        height: visibleHeight,
        minWidth: 280,
        transform: `translateX(${notch.offsetX}px)`,
        width: `${notch.widthPercent}%`,
      }}
    >
      <m.div
        animate={{ y: visible ? 0 : visibleHeight }}
        className="demo-banner-notch-lit lit relative w-full overflow-hidden will-change-transform"
        initial={false}
        ref={surfaceRef}
        style={
          {
            "--notch-lit-origin": `${notch.slantWidth}px`,
            clipPath:
              notchPaths === null
                ? `polygon(${notch.slantWidth}px 0, 100% 0, 100% 100%, 0 100%)`
                : `path("${notchPaths.clip}")`,
            borderTopRightRadius: notch.cornerRadius,
            height: notch.height,
          } as CSSProperties
        }
        transition={transition}
      >
        {notchPaths === null ? null : (
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-20 size-full"
            style={{
              WebkitMaskImage: borderMask,
              maskImage: borderMask,
              opacity: NOTCH_LIT_BORDER.layerOpacity,
            }}
          >
            <path
              d={notchPaths.border}
              fill="none"
              stroke="var(--teal)"
              strokeDasharray={`${NOTCH_LIT_BORDER.dashLength} ${NOTCH_LIT_BORDER.gapLength}`}
              strokeOpacity={NOTCH_LIT_BORDER.strokeOpacity}
              strokeWidth={notch.litBorderWidth}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        )}
        <span
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(circle at 82% 12%, color-mix(in oklab, var(--teal) 65%, transparent), transparent 62%)",
            filter: `blur(${notch.glowBlur}px)`,
            opacity: notch.glowOpacity,
          }}
        />
        <span
          aria-hidden="true"
          className="absolute inset-y-0 right-0 w-1/2 [mask-image:linear-gradient(105deg,transparent_5%,black_62%)]"
        >
          <EmberField
            className="inset-0 h-full w-full text-teal"
            fadePerRow={notch.dots.fadePerRow}
            intensity={notch.dots.intensity}
            pulse={notch.dots.pulse}
          />
        </span>
        <div
          className="pointer-events-auto absolute inset-x-0 top-0 flex items-center gap-3 pr-4"
          style={{ height: visibleHeight, paddingLeft: notch.slantWidth + 16 }}
        >
          <p className="relative min-w-0 flex-1 text-[12px] leading-[1.3] font-medium tracking-[-0.005em] text-foreground">
            Our own landing page, recorded with our own product.{" "}
            <span className="text-teal">Look closely — you might spot yourself.</span>
          </p>
          <Link
            aria-hidden={!visible}
            className="demo-cta group relative ml-auto flex shrink-0 items-center gap-2 rounded-[9px] bg-white py-1 pl-3 pr-1 text-[12px] font-[550] tracking-[-0.01em] text-black"
            tabIndex={visible ? 0 : -1}
            to="/login"
          >
            Start free
            <span className="flex size-5 items-center justify-center rounded-full bg-black text-white">
              <ArrowUpRight
                className="transition-transform duration-200 ease-out group-hover:rotate-45"
                size={12}
                strokeWidth={1.5}
              />
            </span>
          </Link>
        </div>
      </m.div>
    </div>
  );
}

function createLitBorderMask(leftCorner: number) {
  return `radial-gradient(170% 130% at ${leftCorner}px 0%, oklch(0 0 0 / 0.9) 0%, oklch(0 0 0 / 0.42) 24%, oklch(0 0 0 / 0.22) 46%, oklch(0 0 0 / 0.1) 68%, oklch(0 0 0 / 0.07) 100%)`;
}

function createNotchPaths(
  width: number,
  height: number,
  slantWidth: number,
  slantRadius: number,
  cornerRadius: number,
) {
  if (width <= 0 || height <= 0) return null;

  const safeCornerRadius = Math.min(Math.max(cornerRadius, 0), height / 2, width / 2);
  const safeSlantWidth = Math.min(Math.max(slantWidth, 0), width - safeCornerRadius);
  const diagonalLength = Math.hypot(safeSlantWidth, height);
  const availableTopWidth = Math.max(width - safeCornerRadius - safeSlantWidth, 0);
  const safeSlantRadius = Math.min(
    Math.max(slantRadius, 0),
    diagonalLength / 2,
    availableTopWidth / 2,
  );
  const diagonalInsetX =
    diagonalLength === 0 ? 0 : (safeSlantRadius * safeSlantWidth) / diagonalLength;
  const diagonalInsetY = diagonalLength === 0 ? 0 : (safeSlantRadius * height) / diagonalLength;
  const borderSegments = [
    `M 0 ${height}`,
    `L ${safeSlantWidth - diagonalInsetX} ${diagonalInsetY}`,
    `Q ${safeSlantWidth} 0 ${safeSlantWidth + safeSlantRadius} 0`,
    `H ${width - safeCornerRadius}`,
    `Q ${width} 0 ${width} ${safeCornerRadius}`,
    `V ${height}`,
  ];

  return {
    border: borderSegments.join(" "),
    clip: [...borderSegments, "H 0", "Z"].join(" "),
  };
}

function WorkspaceEdge({
  edge,
  onComplete,
  reduceMotion,
  settled,
  visible,
}: {
  edge: DemoBannerAnimationConfig["edge"];
  onComplete: () => void;
  reduceMotion: boolean;
  settled: boolean;
  visible: boolean;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ height: 0, width: 0 });

  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) return;

    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      const height = Math.round(entry.contentRect.height * 100) / 100;
      const width = Math.round(entry.contentRect.width * 100) / 100;
      setSize((currentSize) =>
        currentSize.height === height && currentSize.width === width
          ? currentSize
          : { height, width },
      );
    });

    observer.observe(svg);
    return () => observer.disconnect();
  }, []);

  const transition = reduceMotion
    ? ({ duration: 0 } satisfies Transition)
    : ((settled ? edge.settle.spring : edge.spring) as Transition);
  const crispPathState = {
    opacity: visible ? (settled ? edge.settle.opacity : edge.opacity) : EDGE_PATH.initialOpacity,
    pathLength: visible ? EDGE_PATH.finalLength : EDGE_PATH.initialLength,
    strokeWidth: settled ? edge.settle.strokeWidth : edge.strokeWidth,
  };
  const glowPathState = {
    ...crispPathState,
    filter: `blur(${settled ? edge.settle.glowBlur : edge.glowBlur}px)`,
    opacity: visible
      ? settled
        ? edge.settle.glowOpacity
        : edge.glowOpacity
      : EDGE_PATH.initialOpacity,
    strokeWidth: (settled ? edge.settle.strokeWidth : edge.strokeWidth) + 2,
  };
  const splitPaths = createSplitEdgePaths(size.width, size.height);

  return (
    <m.svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-30 size-full"
      fill="none"
      initial={false}
      preserveAspectRatio="none"
      ref={svgRef}
      viewBox={size.width > 0 && size.height > 0 ? `0 0 ${size.width} ${size.height}` : undefined}
    >
      {splitPaths.map((path, index) => (
        <m.path
          animate={glowPathState}
          d={path}
          initial={false}
          key={`glow-${index}`}
          pathLength={1}
          stroke="var(--teal)"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={edge.strokeWidth + 2}
          transition={transition}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {splitPaths.map((path, index) => (
        <m.path
          animate={crispPathState}
          d={path}
          initial={false}
          key={`edge-${index}`}
          onAnimationComplete={() => {
            if (visible && !settled && index === splitPaths.length - 1) onComplete();
          }}
          pathLength={1}
          stroke="var(--teal)"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={edge.strokeWidth}
          transition={transition}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </m.svg>
  );
}

function createSplitEdgePaths(width: number, height: number): string[] {
  const inset = 1;
  if (width <= inset * 2 || height <= inset * 2) return [];

  const centerX = width / 2;
  const bottom = height - inset;
  const right = width - inset;
  const radius = Math.max(0, Math.min(EDGE_PATH.radius, centerX - inset, height / 2 - inset));

  return [
    `M ${centerX} ${inset} H ${inset + radius} Q ${inset} ${inset} ${inset} ${
      inset + radius
    } V ${bottom - radius} Q ${inset} ${bottom} ${inset + radius} ${bottom} H ${centerX}`,
    `M ${centerX} ${inset} H ${right - radius} Q ${right} ${inset} ${right} ${
      inset + radius
    } V ${bottom - radius} Q ${right} ${bottom} ${right - radius} ${bottom} H ${centerX}`,
  ];
}
