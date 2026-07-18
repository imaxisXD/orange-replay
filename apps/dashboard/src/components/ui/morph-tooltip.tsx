"use client";

import {
  createContext,
  use,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useDirection, type TextDirection } from "@base-ui/react/direction-provider";
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { LazyMotion, domMax } from "framer-motion";
import { m, useReducedMotion, type HTMLMotionProps, type Transition } from "@/lib/motion";
import { useShape } from "@/lib/shape-context";
import { cn } from "@/lib/utils";
import "./morph-tooltip.css";

type MorphTooltipSize = "sm" | "md" | "lg";
type MorphTooltipMotionPreset = "dashboard" | "reference";

interface MorphTooltipSizeMetrics {
  closedSize: number;
  openHeight: number;
  openWidth: number;
  sideOffset: number;
}

const MORPH_TOOLTIP_SIZE_METRICS: Record<MorphTooltipSize, MorphTooltipSizeMetrics> = {
  sm: { closedSize: 40, openHeight: 32, openWidth: 144, sideOffset: 4 },
  md: { closedSize: 60, openHeight: 48, openWidth: 186, sideOffset: 6 },
  lg: { closedSize: 72, openHeight: 56, openWidth: 224, sideOffset: 8 },
};

const LABEL_SIZE_CLASSES: Record<MorphTooltipSize, string> = {
  sm: "text-[11px]",
  md: "text-[11.5px]",
  lg: "text-[13px]",
};

interface MorphTooltipTransitions {
  arrowOpen: Transition;
  arrowClose: Transition;
  contentDurationMs: number;
  surfaceOpen: Transition;
  surfaceClose: Transition;
  labelOpen: Transition;
  labelClose: Transition;
}

const MORPH_TOOLTIP_DASHBOARD_TIMING = {
  bounce: 0.2,
  holdMs: 500,
  surfaceCloseMs: 120,
  surfaceDelayMs: 200,
  surfaceOpenMs: 200,
  textDelayMs: 150,
  textHideMs: 10,
  textRevealMs: 200,
} as const;

const MORPH_TOOLTIP_MOTION_PRESETS = {
  dashboard: {
    arrowOpen: {
      delay: MORPH_TOOLTIP_DASHBOARD_TIMING.textDelayMs / 1000,
      duration: MORPH_TOOLTIP_DASHBOARD_TIMING.textRevealMs / 1000,
      ease: "easeInOut",
    },
    arrowClose: {
      duration: MORPH_TOOLTIP_DASHBOARD_TIMING.textHideMs / 1000,
      ease: "easeInOut",
    },
    contentDurationMs: MORPH_TOOLTIP_DASHBOARD_TIMING.textRevealMs,
    surfaceOpen: {
      type: "spring",
      duration: MORPH_TOOLTIP_DASHBOARD_TIMING.surfaceOpenMs / 1000,
      bounce: MORPH_TOOLTIP_DASHBOARD_TIMING.bounce,
      delay: MORPH_TOOLTIP_DASHBOARD_TIMING.surfaceDelayMs / 1000,
    },
    surfaceClose: {
      type: "spring",
      duration: MORPH_TOOLTIP_DASHBOARD_TIMING.surfaceCloseMs / 1000,
      bounce: MORPH_TOOLTIP_DASHBOARD_TIMING.bounce / 2,
    },
    labelOpen: {
      delay: MORPH_TOOLTIP_DASHBOARD_TIMING.textDelayMs / 1000,
      duration: MORPH_TOOLTIP_DASHBOARD_TIMING.textRevealMs / 1000,
      ease: "easeInOut",
    },
    labelClose: {
      duration: MORPH_TOOLTIP_DASHBOARD_TIMING.textHideMs / 1000,
      ease: "easeInOut",
    },
  },
  reference: {
    arrowOpen: { delay: 0.2, duration: 0.4, ease: "easeInOut" },
    arrowClose: { duration: 0.2, ease: "easeInOut" },
    contentDurationMs: 400,
    surfaceOpen: { type: "spring", duration: 0.5, bounce: 0.2, delay: 0.2 },
    surfaceClose: { type: "spring", duration: 0.4, bounce: 0.1 },
    labelOpen: { delay: 0.2, duration: 0.4, ease: "easeInOut" },
    labelClose: { duration: 0.2, ease: "easeInOut" },
  },
} satisfies Record<MorphTooltipMotionPreset, MorphTooltipTransitions>;

interface MorphTooltipContextValue {
  closeFinished: boolean;
  closedHeight: number;
  closedWidth: number;
  metrics: MorphTooltipSizeMetrics;
  open: boolean;
  reduceMotion: boolean;
  size: MorphTooltipSize;
  startSurfaceMotion: () => void;
  transitions: MorphTooltipTransitions;
  updateTriggerSize: (width: number, height: number) => void;
}

interface MorphTooltipPositionContextValue {
  sideOffset: number;
}

const MorphTooltipContext = createContext<MorphTooltipContextValue | null>(null);
const MorphTooltipPositionContext = createContext<MorphTooltipPositionContextValue | null>(null);
const MorphTooltipPopupStateContext = createContext<{
  instant: boolean;
  open: boolean;
} | null>(null);

function useMorphTooltip(part: string) {
  const context = use(MorphTooltipContext);
  if (!context) throw new Error(`MorphTooltip.${part} must be used inside MorphTooltip.Root`);
  return context;
}

function useMorphTooltipPosition() {
  const context = use(MorphTooltipPositionContext);
  if (!context) {
    throw new Error("MorphTooltip.Popup must be used inside MorphTooltip.Positioner");
  }
  return context;
}

function useMorphTooltipPopupState(part: string) {
  const context = use(MorphTooltipPopupStateContext);
  if (!context) throw new Error(`MorphTooltip.${part} must be used inside MorphTooltip.Popup`);
  return context;
}

interface MorphTooltipRootProps<Payload = unknown> extends Omit<
  TooltipPrimitive.Root.Props<Payload>,
  "defaultOpen" | "onOpenChange" | "onOpenChangeComplete" | "open"
> {
  /** Initial state when the component is uncontrolled. */
  defaultOpen?: boolean;
  /** Controlled open state. */
  open?: boolean;
  /** Receives the same change details as Base UI Tooltip.Root. */
  onOpenChange?: TooltipPrimitive.Root.Props<Payload>["onOpenChange"];
  /** Runs after the Motion exit or entrance completes. */
  onOpenChangeComplete?: TooltipPrimitive.Root.Props<Payload>["onOpenChangeComplete"];
  /** `dashboard` is the finalized product timing. `reference` preserves the original demo spring. */
  motionPreset?: MorphTooltipMotionPreset;
  /** Surface and label transitions. Unspecified tracks keep the component defaults. */
  transitions?: Partial<MorphTooltipTransitions>;
  /** `md` preserves the original 60×60 → 186×48 animation. */
  size?: MorphTooltipSize;
}

function MorphTooltipRoot<Payload = unknown>({
  children,
  defaultOpen = false,
  onOpenChange,
  onOpenChangeComplete,
  open: controlledOpen,
  motionPreset = "dashboard",
  size = "md",
  transitions: transitionOverrides,
  ...rootProps
}: MorphTooltipRootProps<Payload>) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = controlledOpen ?? uncontrolledOpen;
  const [closeFinished, setCloseFinished] = useState(!open);
  const [triggerSize, setTriggerSize] = useState<{ height: number; width: number } | null>(null);
  const reduceMotion = useReducedMotion() === true;
  const metrics = MORPH_TOOLTIP_SIZE_METRICS[size];
  const closedHeight = triggerSize?.height ?? metrics.closedSize;
  const closedWidth = triggerSize?.width ?? metrics.closedSize;
  const transitions = { ...MORPH_TOOLTIP_MOTION_PRESETS[motionPreset], ...transitionOverrides };

  const updateTriggerSize = useCallback((width: number, height: number) => {
    setTriggerSize((current) => {
      if (current?.width === width && current.height === height) return current;
      return { height, width };
    });
  }, []);

  function handleOpenChange(
    nextOpen: boolean,
    eventDetails: TooltipPrimitive.Root.ChangeEventDetails,
  ) {
    if (controlledOpen === undefined) setUncontrolledOpen(nextOpen);
    if (nextOpen) setCloseFinished(false);
    onOpenChange?.(nextOpen, eventDetails);
  }

  function handleOpenChangeComplete(nextOpen: boolean) {
    setCloseFinished(!nextOpen);
    onOpenChangeComplete?.(nextOpen);
  }

  function startSurfaceMotion() {
    setCloseFinished(false);
  }

  return (
    <MorphTooltipContext.Provider
      value={{
        closeFinished,
        closedHeight,
        closedWidth,
        metrics,
        open,
        reduceMotion,
        size,
        startSurfaceMotion,
        transitions,
        updateTriggerSize,
      }}
    >
      <LazyMotion features={domMax}>
        <TooltipPrimitive.Root
          {...rootProps}
          onOpenChange={handleOpenChange}
          onOpenChangeComplete={handleOpenChangeComplete}
          open={open}
        >
          {children}
        </TooltipPrimitive.Root>
      </LazyMotion>
    </MorphTooltipContext.Provider>
  );
}

type MorphTooltipTriggerProps = ComponentProps<typeof TooltipPrimitive.Trigger>;

function MorphTooltipTrigger({
  className,
  closeDelay = MORPH_TOOLTIP_DASHBOARD_TIMING.holdMs,
  ref: forwardedRef,
  style,
  ...triggerProps
}: MorphTooltipTriggerProps) {
  const { closeFinished, open, size, updateTriggerSize } = useMorphTooltip("Trigger");
  const elementRef = useRef<HTMLButtonElement | null>(null);
  const showSurface = !open && closeFinished;
  const mergedRef = useCallback(
    (element: HTMLButtonElement | null) => {
      elementRef.current = element;
      const externalCleanup =
        typeof forwardedRef === "function" ? forwardedRef(element) : undefined;

      if (forwardedRef && typeof forwardedRef !== "function") forwardedRef.current = element;

      return () => {
        elementRef.current = null;
        if (forwardedRef && typeof forwardedRef !== "function") forwardedRef.current = null;
        if (typeof externalCleanup === "function") externalCleanup();
      };
    },
    [forwardedRef],
  );

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;

    function measureTrigger() {
      const measuredElement = elementRef.current;
      if (!measuredElement) return;
      const rectangle = measuredElement.getBoundingClientRect();
      const width =
        rectangle.width || measuredElement.offsetWidth || numericStyle(measuredElement, "width");
      const height =
        rectangle.height || measuredElement.offsetHeight || numericStyle(measuredElement, "height");

      if (width > 0 && height > 0) updateTriggerSize(width, height);
    }

    measureTrigger();
    if (typeof ResizeObserver !== "function") return;

    const observer = new ResizeObserver(measureTrigger);
    observer.observe(element);
    return () => observer.disconnect();
  }, [updateTriggerSize]);

  return (
    <TooltipPrimitive.Trigger
      {...triggerProps}
      ref={mergedRef}
      className={
        typeof className === "function"
          ? (state) => cn("relative z-[51]", className(state))
          : cn("relative z-[51]", className)
      }
      data-morph-tooltip-trigger=""
      data-size={size}
      data-surface-visible={showSurface ? "" : undefined}
      closeDelay={closeDelay}
      style={style}
    />
  );
}

type MorphTooltipIconTriggerProps = MorphTooltipTriggerProps;

function MorphTooltipIconTrigger({
  className,
  style,
  ...triggerProps
}: MorphTooltipIconTriggerProps) {
  const { closeFinished, metrics, open } = useMorphTooltip("IconTrigger");
  const showSurface = !open && closeFinished;
  const baseClassName = cn(
    "grid place-items-center border border-transparent bg-transparent p-0",
    "rounded-full text-foreground outline-none cursor-help",
    "focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring)]",
    showSurface && "border-border bg-popover",
  );

  return (
    <MorphTooltipTrigger
      {...triggerProps}
      className={
        typeof className === "function"
          ? (state) => cn(baseClassName, className(state))
          : cn(baseClassName, className)
      }
      style={
        typeof style === "function"
          ? (state) => ({
              ...style(state),
              height: metrics.closedSize,
              width: metrics.closedSize,
            })
          : { ...style, height: metrics.closedSize, width: metrics.closedSize }
      }
    />
  );
}

function numericStyle(element: HTMLElement, property: "height" | "width") {
  const value = Number.parseFloat(element.style[property]);
  return Number.isFinite(value) ? value : 0;
}

type MorphTooltipPortalProps = ComponentProps<typeof TooltipPrimitive.Portal>;

function MorphTooltipPortal({ keepMounted = true, ...portalProps }: MorphTooltipPortalProps) {
  return <TooltipPrimitive.Portal {...portalProps} keepMounted={keepMounted} />;
}

type MorphTooltipPositionerProps = ComponentProps<typeof TooltipPrimitive.Positioner>;

function MorphTooltipPositioner({
  align = "center",
  children,
  className,
  hidden,
  side = "top",
  sideOffset,
  style,
  ...positionerProps
}: MorphTooltipPositionerProps) {
  const { metrics, open } = useMorphTooltip("Positioner");
  const resolvedSideOffset = sideOffset ?? metrics.sideOffset;
  const motionSideOffset =
    typeof resolvedSideOffset === "number" ? resolvedSideOffset : metrics.sideOffset;

  return (
    <MorphTooltipPositionContext.Provider value={{ sideOffset: motionSideOffset }}>
      <TooltipPrimitive.Positioner
        {...positionerProps}
        align={align}
        className={
          typeof className === "function"
            ? (state) =>
                cn("morph-tooltip-positioner z-50 grid place-items-start", className(state))
            : cn("morph-tooltip-positioner z-50 grid place-items-start", className)
        }
        data-morph-tooltip-positioner=""
        hidden={hidden ?? false}
        aria-hidden={open ? undefined : true}
        side={side}
        sideOffset={resolvedSideOffset}
        style={
          typeof style === "function"
            ? (state) => ({
                ...style(state),
                height: metrics.openHeight,
                width: metrics.openWidth,
              })
            : { ...style, height: metrics.openHeight, width: metrics.openWidth }
        }
      >
        {children}
      </TooltipPrimitive.Positioner>
    </MorphTooltipPositionContext.Provider>
  );
}

interface MorphTooltipPopupProps extends Omit<
  ComponentProps<typeof TooltipPrimitive.Popup>,
  "render"
> {
  /**
   * Overrides the distance used to return the closed surface to the trigger.
   * Useful when Positioner.sideOffset is a function rather than a number.
   */
  landingOffset?: number;
}

function MorphTooltipPopup({
  className,
  landingOffset,
  style,
  ...popupProps
}: MorphTooltipPopupProps) {
  const {
    closedHeight,
    closedWidth,
    metrics,
    reduceMotion,
    size,
    startSurfaceMotion,
    transitions,
  } = useMorphTooltip("Popup");
  const position = useMorphTooltipPosition();
  const shape = useShape();
  const direction = useDirection();

  return (
    <TooltipPrimitive.Popup
      {...popupProps}
      className={
        typeof className === "function"
          ? (state) =>
              cn(
                "relative grid place-items-center overflow-visible border border-border bg-popover outline-none",
                "will-change-transform",
                className(state),
              )
          : cn(
              "relative grid place-items-center overflow-visible border border-border bg-popover outline-none",
              "will-change-transform",
              className,
            )
      }
      data-morph-tooltip-popup=""
      data-size={size}
      render={(baseProps, state) => {
        const {
          children,
          className: surfaceClassName,
          style: baseStyle,
          ...motionProps
        } = baseProps as HTMLMotionProps<"div">;
        const skipMotion = reduceMotion || state.instant !== undefined;
        const surfaceTransition = skipMotion
          ? { duration: 0 }
          : state.open
            ? transitions.surfaceOpen
            : transitions.surfaceClose;

        return (
          <m.div
            {...motionProps}
            animate={{
              transform: state.open
                ? "translate(0px, 0px)"
                : closedTransform(
                    state.side,
                    state.align,
                    position.sideOffset,
                    direction,
                    metrics,
                    closedWidth,
                    closedHeight,
                    landingOffset,
                  ),
            }}
            className="relative grid place-items-start overflow-visible outline-none will-change-transform"
            data-motion-mode={skipMotion ? "instant" : "animated"}
            initial={false}
            style={{
              ...(baseStyle as CSSProperties | undefined),
              height: metrics.openHeight,
              transformOrigin: "var(--transform-origin)",
              width: metrics.openWidth,
            }}
            transition={surfaceTransition}
          >
            <m.div
              animate={{
                borderRadius: state.open ? shape.bgRadius : 999,
                opacity: state.open ? 1 : 0.9999,
              }}
              className={surfaceClassName}
              data-closed={state.open ? undefined : ""}
              data-instant={state.instant}
              data-morph-tooltip-surface=""
              data-open={state.open ? "" : undefined}
              data-side={state.side}
              initial={false}
              layout="size"
              layoutDependency={`${state.open ? "open" : "closed"}-${size}-${closedWidth}-${closedHeight}`}
              onLayoutAnimationStart={() => {
                if (state.open) startSurfaceMotion();
              }}
              style={{
                ...(typeof style === "function" ? style(state) : style),
                height: state.open ? metrics.openHeight : closedHeight,
                transformOrigin: "var(--transform-origin)",
                width: state.open ? metrics.openWidth : closedWidth,
              }}
              transition={{ ...surfaceTransition, layout: surfaceTransition }}
            />
            <m.div
              animate={{
                transform: state.open
                  ? "translate(0px, 0px)"
                  : `translate(${(closedWidth - metrics.openWidth) / 2}px, ${(closedHeight - metrics.openHeight) / 2}px)`,
              }}
              className="pointer-events-none absolute inset-0 grid place-items-center overflow-visible"
              data-morph-tooltip-content=""
              initial={false}
              transition={surfaceTransition}
            >
              <MorphTooltipPopupStateContext.Provider
                value={{ instant: state.instant !== undefined, open: state.open }}
              >
                {children as ReactNode}
              </MorphTooltipPopupStateContext.Provider>
            </m.div>
          </m.div>
        );
      }}
    />
  );
}

type MorphTooltipArrowProps = ComponentProps<typeof TooltipPrimitive.Arrow>;
type MorphTooltipArrowStyle = CSSProperties & {
  "--morph-tooltip-arrow-delay"?: string;
  "--morph-tooltip-arrow-duration"?: string;
};

function MorphTooltipArrow({ className, style, ...arrowProps }: MorphTooltipArrowProps) {
  const { reduceMotion, transitions } = useMorphTooltip("Arrow");
  const direction = useDirection();

  function arrowStyle(state: TooltipPrimitive.Arrow.State): MorphTooltipArrowStyle {
    const transition = state.open ? transitions.arrowOpen : transitions.arrowClose;
    const skipMotion = reduceMotion || state.instant !== undefined;

    return {
      ...(typeof style === "function" ? style(state) : style),
      "--morph-tooltip-arrow-delay": skipMotion ? "0ms" : transitionTime(transition.delay),
      "--morph-tooltip-arrow-duration": skipMotion ? "0ms" : transitionTime(transition.duration),
    };
  }

  return (
    <TooltipPrimitive.Arrow
      {...arrowProps}
      className={
        typeof className === "function"
          ? (state) => cn("morph-tooltip-arrow", className(state))
          : cn("morph-tooltip-arrow", className)
      }
      data-morph-tooltip-arrow=""
      data-text-direction={direction}
      style={arrowStyle}
    />
  );
}

type MorphTooltipViewportProps = ComponentProps<typeof TooltipPrimitive.Viewport>;
type MorphTooltipViewportStyle = CSSProperties & {
  "--morph-tooltip-content-duration"?: string;
};

function MorphTooltipViewport({ className, style, ...viewportProps }: MorphTooltipViewportProps) {
  const { transitions } = useMorphTooltip("Viewport");

  function viewportStyle(state: TooltipPrimitive.Viewport.State): MorphTooltipViewportStyle {
    return {
      ...(typeof style === "function" ? style(state) : style),
      "--morph-tooltip-content-duration": `${transitions.contentDurationMs}ms`,
      maxWidth: "100%",
      minWidth: "0px",
    };
  }

  return (
    <TooltipPrimitive.Viewport
      {...viewportProps}
      className={
        typeof className === "function"
          ? (state) => cn("morph-tooltip-viewport", className(state))
          : cn("morph-tooltip-viewport", className)
      }
      data-morph-tooltip-viewport=""
      style={viewportStyle}
    />
  );
}

interface MorphTooltipLabelProps extends Omit<
  HTMLMotionProps<"span">,
  "animate" | "initial" | "transition"
> {
  children: ReactNode;
}

const LABEL_CLIP_CLOSED = "polygon(50% 0, 50% 0, 50% 100%, 50% 100%)";
const LABEL_CLIP_OPEN = "polygon(0 0, 100% 0, 100% 100%, 0 100%)";

function MorphTooltipLabel({ children, className, style, ...labelProps }: MorphTooltipLabelProps) {
  const { reduceMotion, size, transitions } = useMorphTooltip("Label");
  const { instant, open } = useMorphTooltipPopupState("Label");

  return (
    <m.span
      {...labelProps}
      animate={{ clipPath: open ? LABEL_CLIP_OPEN : LABEL_CLIP_CLOSED }}
      className={cn(
        "relative z-[1] leading-none whitespace-nowrap text-popover-foreground",
        LABEL_SIZE_CLASSES[size],
        className,
      )}
      data-morph-tooltip-label=""
      initial={open && !instant && !reduceMotion ? { clipPath: LABEL_CLIP_CLOSED } : false}
      style={{ fontWeight: 450, ...style }}
      transition={
        reduceMotion || instant
          ? { duration: 0 }
          : open
            ? transitions.labelOpen
            : transitions.labelClose
      }
    >
      {children}
    </m.span>
  );
}

function closedTransform(
  side: TooltipPrimitive.Popup.State["side"],
  align: TooltipPrimitive.Popup.State["align"],
  sideOffset: number,
  direction: TextDirection,
  metrics: MorphTooltipSizeMetrics,
  closedWidth: number,
  closedHeight: number,
  landingOffset?: number,
) {
  const physicalSide = resolvePhysicalSide(side, direction);
  const distance =
    landingOffset ??
    (physicalSide === "top"
      ? metrics.openHeight + sideOffset
      : physicalSide === "left"
        ? metrics.openWidth + sideOffset
        : closedWidth + sideOffset);
  const horizontalOffset = alignmentOffset(metrics.openWidth - closedWidth, align, direction);
  const verticalOffset = alignmentOffset(metrics.openHeight - closedHeight, align, "ltr");

  switch (physicalSide) {
    case "bottom":
      return `translate(${horizontalOffset}px, -${distance}px)`;
    case "left":
      return `translate(${distance}px, ${verticalOffset}px)`;
    case "right":
      return `translate(-${distance}px, ${verticalOffset}px)`;
    case "top":
      return `translate(${horizontalOffset}px, ${distance}px)`;
  }
}

function resolvePhysicalSide(side: TooltipPrimitive.Popup.State["side"], direction: TextDirection) {
  if (side === "inline-start") return direction === "rtl" ? "right" : "left";
  if (side === "inline-end") return direction === "rtl" ? "left" : "right";
  return side;
}

function alignmentOffset(
  sizeDifference: number,
  align: TooltipPrimitive.Popup.State["align"],
  direction: TextDirection,
) {
  if (align === "center") return sizeDifference / 2;
  if (align === "start") return direction === "rtl" ? sizeDifference : 0;
  return direction === "rtl" ? 0 : sizeDifference;
}

function transitionTime(value: unknown) {
  return typeof value === "number" ? `${value * 1000}ms` : "0ms";
}

const MorphTooltip = {
  Arrow: MorphTooltipArrow,
  IconTrigger: MorphTooltipIconTrigger,
  Label: MorphTooltipLabel,
  Popup: MorphTooltipPopup,
  Portal: MorphTooltipPortal,
  Positioner: MorphTooltipPositioner,
  Provider: TooltipPrimitive.Provider,
  Root: MorphTooltipRoot,
  Trigger: MorphTooltipTrigger,
  Viewport: MorphTooltipViewport,
};

export {
  MorphTooltip,
  MORPH_TOOLTIP_DASHBOARD_TIMING,
  MORPH_TOOLTIP_MOTION_PRESETS,
  MORPH_TOOLTIP_SIZE_METRICS,
};
export type {
  MorphTooltipArrowProps,
  MorphTooltipIconTriggerProps,
  MorphTooltipLabelProps,
  MorphTooltipMotionPreset,
  MorphTooltipPopupProps,
  MorphTooltipPositionerProps,
  MorphTooltipRootProps,
  MorphTooltipSize,
  MorphTooltipTransitions,
  MorphTooltipTriggerProps,
  MorphTooltipViewportProps,
};
