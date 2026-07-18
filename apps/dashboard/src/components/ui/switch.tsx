"use client";

import { forwardRef, useRef, useState, useEffect, useId, type HTMLAttributes } from "react";
import { animate, m, useMotionValue, useReducedMotion, type Transition } from "@/lib/motion";
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@/lib/utils";
import { spring } from "@/lib/springs";

type SwitchSize = "small" | "medium" | "large";

interface SwitchProps extends HTMLAttributes<HTMLDivElement> {
  label: string;
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
  size?: SwitchSize;
  thumbTransition?: Transition;
}

const SWITCH_SIZE_SCALE: Record<SwitchSize, number> = {
  small: 0.8,
  medium: 1,
  large: 1.2,
};

const SWITCH_THUMB_SIZE: Record<SwitchSize, number> = {
  small: 12,
  medium: 16,
  large: 19.2,
};

const SWITCH_PRESS_MORPH_SCALE: Record<SwitchSize, number> = {
  small: 0.5,
  medium: 1,
  large: 1,
};

const SWITCH_THUMB_BACKGROUND =
  "linear-gradient(to top, oklch(1 0 0) 0%, oklch(0.97 0.003 286) 36%, oklch(0.84 0.008 286) 100%)";
const SWITCH_THUMB_SHADOW =
  "inset 0 1px 2px rgb(10 10 12 / 0.28), inset 0 -1px 1px rgb(255 255 255 / 0.95), 0 1px 2px rgb(0 0 0 / 0.22)";

const BASE_TRACK_WIDTH = 34;
const BASE_TRACK_HEIGHT = 20;
const BASE_PILL_EXTEND = 2;
const BASE_PRESS_EXTEND = 4;
const BASE_PRESS_SHRINK = 4;
const BASE_DRAG_DEAD_ZONE = 2;

const Switch = forwardRef<HTMLDivElement, SwitchProps>(
  (
    {
      label,
      checked,
      onToggle,
      disabled = false,
      size = "medium",
      thumbTransition,
      className,
      ...props
    },
    ref,
  ) => {
    const labelId = useId();
    const reduceMotion = useReducedMotion();
    const [hovered, setHovered] = useState(false);
    const [pressed, setPressed] = useState(false);
    const sizeScale = SWITCH_SIZE_SCALE[size];
    const pressMorphScale = SWITCH_PRESS_MORPH_SCALE[size];
    const trackWidth = BASE_TRACK_WIDTH * sizeScale;
    const trackHeight = BASE_TRACK_HEIGHT * sizeScale;
    const thumbSize = SWITCH_THUMB_SIZE[size];
    const innerPadding = (trackHeight - thumbSize) / 2;
    const trackRadius = thumbSize / 2 + innerPadding;
    const thumbTravel = trackWidth - thumbSize - innerPadding * 2;
    const pillExtend = BASE_PILL_EXTEND * sizeScale;
    const pressExtend = BASE_PRESS_EXTEND * sizeScale * pressMorphScale;
    const pressShrink = BASE_PRESS_SHRINK * sizeScale * pressMorphScale;
    const dragDeadZone = BASE_DRAG_DEAD_ZONE * sizeScale;

    // Drag refs (not state to avoid re-renders during drag)
    const dragging = useRef(false);
    const didDrag = useRef(false);
    const pointerStart = useRef<{
      clientX: number;
      originX: number;
    } | null>(null);

    // Motion value for thumb x-axis
    const motionX = useMotionValue(checked ? innerPadding + thumbTravel : innerPadding);

    // Compute thumb shape
    const thumbWidth = pressed
      ? thumbSize + pressExtend
      : hovered
        ? thumbSize + pillExtend
        : thumbSize;
    const thumbHeight = pressed ? thumbSize - pressShrink : thumbSize;
    const thumbRadius = thumbHeight / 2;
    const thumbY = pressed ? innerPadding + pressShrink / 2 : innerPadding;
    const extraWidth = thumbWidth - thumbSize;
    const thumbX = checked ? innerPadding + thumbTravel - extraWidth : innerPadding;

    // Sync motionX when thumbX changes (hover/press/checked) and not dragging
    useEffect(() => {
      if (dragging.current) return;
      animate(motionX, thumbX, resolveThumbTransition(reduceMotion, thumbTransition));
    }, [motionX, reduceMotion, thumbTransition, thumbX]);

    // --- Pointer handlers ---

    function handlePointerDown(e: React.PointerEvent<HTMLDivElement>): void {
      if (disabled) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      setPressed(true);
      dragging.current = false;
      didDrag.current = false;
      pointerStart.current = {
        clientX: e.clientX,
        originX: motionX.get(),
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    }

    function handlePointerMove(e: React.PointerEvent<HTMLDivElement>): void {
      if (!pointerStart.current) return;
      const delta = e.clientX - pointerStart.current.clientX;

      if (!dragging.current) {
        if (Math.abs(delta) < dragDeadZone) return;
        dragging.current = true;
      }

      const dragMin = innerPadding;
      const pressedThumbWidth = thumbSize + pressExtend;
      const dragMax = trackWidth - innerPadding - pressedThumbWidth;
      const rawX = pointerStart.current.originX + delta;
      motionX.set(Math.max(dragMin, Math.min(dragMax, rawX)));
    }

    function handlePointerUp(): void {
      if (!pointerStart.current) return;
      setPressed(false);

      if (dragging.current) {
        didDrag.current = true;
        dragging.current = false;

        const currentX = motionX.get();
        const dragMin = innerPadding;
        const pressedThumbWidth = thumbSize + pressExtend;
        const dragMax = trackWidth - innerPadding - pressedThumbWidth;
        const midpoint = (dragMin + dragMax) / 2;

        const shouldBeOn = currentX > midpoint;

        if (shouldBeOn !== checked) {
          onToggle();
        } else {
          // Snap back to current resting position (un-pressed)
          const snapTarget = checked ? innerPadding + thumbTravel : innerPadding;
          animate(motionX, snapTarget, resolveThumbTransition(reduceMotion, thumbTransition));
        }

        requestAnimationFrame(() => {
          didDrag.current = false;
        });
      }

      pointerStart.current = null;
    }

    function handlePointerCancel(): void {
      if (!pointerStart.current) return;
      setPressed(false);

      if (dragging.current) {
        dragging.current = false;
        // Gesture cancelled by the system — snap back without toggling
        const snapTarget = checked ? innerPadding + thumbTravel : innerPadding;
        animate(motionX, snapTarget, resolveThumbTransition(reduceMotion, thumbTransition));
      }

      pointerStart.current = null;
    }

    return (
      <div
        ref={ref}
        role="presentation"
        className={cn(
          "relative z-10 flex items-center gap-2.5 px-3 py-2 cursor-pointer select-none touch-none",
          disabled && "opacity-50 pointer-events-none",
          className,
        )}
        onPointerEnter={(e) => {
          if (e.pointerType === "mouse") setHovered(true);
        }}
        onPointerLeave={() => setHovered(false)}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onClick={() => {
          if (disabled || didDrag.current) return;
          onToggle();
        }}
        {...props}
      >
        {/* Switch */}
        <SwitchPrimitive.Root
          checked={checked}
          aria-labelledby={labelId}
          onCheckedChange={() => {
            if (didDrag.current) return;
            onToggle();
          }}
          disabled={disabled}
          tabIndex={0}
          className={cn(
            "relative shrink-0 cursor-pointer border outline-none",
            "transition-colors duration-80",
            "focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          )}
          data-size={size}
          style={{
            width: trackWidth,
            height: trackHeight,
            borderRadius: trackRadius,
            backgroundColor: checked
              ? hovered
                ? "color-mix(in oklch, var(--amber) 88%, var(--foreground))"
                : "var(--amber)"
              : hovered
                ? "var(--hover)"
                : "var(--secondary)",
            borderColor: checked ? "var(--amber)" : "var(--border)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <SwitchPrimitive.Thumb
            render={(baseProps) => {
              const {
                style: baseStyle,
                // DOM drag/animation handlers have different signatures from
                // Motion's gesture handlers, so do not pass those through.
                onDrag: _onDrag,
                onDragStart: _onDragStart,
                onDragEnd: _onDragEnd,
                onAnimationStart: _onAnimationStart,
                onAnimationEnd: _onAnimationEnd,
                onAnimationIteration: _onAnimationIteration,
                ...thumbProps
              } = baseProps as React.HTMLAttributes<HTMLSpanElement>;

              return (
                <m.span
                  {...thumbProps}
                  className="absolute -top-px -left-px block bg-white"
                  style={{
                    ...(baseStyle as React.CSSProperties | undefined),
                    backgroundImage: SWITCH_THUMB_BACKGROUND,
                    borderRadius: thumbRadius,
                    boxShadow: SWITCH_THUMB_SHADOW,
                    height: thumbHeight,
                    width: thumbWidth,
                    x: motionX,
                  }}
                  animate={{ y: thumbY }}
                  initial={false}
                  transition={resolveThumbTransition(reduceMotion, thumbTransition)}
                />
              );
            }}
          />
        </SwitchPrimitive.Root>

        {/* Label */}
        <span
          id={labelId}
          className={cn(
            // text-box trim recenters the letterforms against the track; the
            // track controls the row height, so the trimmed label does not move it.
            "text-[13px] [text-box:trim-both_cap_alphabetic] transition-[color] duration-80",
            checked ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {label}
        </span>
      </div>
    );
  },
);

function resolveThumbTransition(
  reduceMotion: boolean | null,
  thumbTransition: Transition | undefined,
): Transition {
  return reduceMotion ? { duration: 0 } : (thumbTransition ?? spring.moderate);
}

Switch.displayName = "Switch";

export { Switch };
export type { SwitchProps, SwitchSize };
