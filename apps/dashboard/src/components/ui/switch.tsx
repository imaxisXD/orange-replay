"use client";

import { forwardRef, useRef, useState, useEffect, useId, type HTMLAttributes } from "react";
import { animate, m, useMotionValue, useReducedMotion, type Transition } from "@/lib/motion";
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@/lib/utils";
import { spring } from "@/lib/springs";

interface SwitchProps extends HTMLAttributes<HTMLDivElement> {
  label: string;
  checked: boolean;
  onToggle: () => void;
  disabled?: boolean;
  thumbTransition?: Transition;
}

const TRACK_WIDTH = 34;
const TRACK_HEIGHT = 20;
const THUMB_SIZE = 16;
const THUMB_OFFSET = 2;
const THUMB_TRAVEL = TRACK_WIDTH - THUMB_SIZE - THUMB_OFFSET * 2;
const PILL_EXTEND = 2;
const PRESS_EXTEND = 4;
const PRESS_SHRINK = 4;
const DRAG_DEAD_ZONE = 2;

const Switch = forwardRef<HTMLDivElement, SwitchProps>(
  ({ label, checked, onToggle, disabled = false, thumbTransition, className, ...props }, ref) => {
    const labelId = useId();
    const reduceMotion = useReducedMotion();
    const thumbSpring: Transition = reduceMotion
      ? { duration: 0 }
      : (thumbTransition ?? spring.moderate);
    const hasMounted = useRef(false);
    const [hovered, setHovered] = useState(false);
    const [pressed, setPressed] = useState(false);

    // Drag refs (not state to avoid re-renders during drag)
    const dragging = useRef(false);
    const didDrag = useRef(false);
    const pointerStart = useRef<{
      clientX: number;
      originX: number;
    } | null>(null);

    // Motion value for thumb x-axis
    const motionX = useMotionValue(checked ? THUMB_OFFSET + THUMB_TRAVEL : THUMB_OFFSET);

    useEffect(() => {
      hasMounted.current = true;
    }, []);

    // Compute thumb shape
    const thumbWidth = pressed
      ? THUMB_SIZE + PRESS_EXTEND
      : hovered
        ? THUMB_SIZE + PILL_EXTEND
        : THUMB_SIZE;
    const thumbHeight = pressed ? THUMB_SIZE - PRESS_SHRINK : THUMB_SIZE;
    const thumbY = pressed ? THUMB_OFFSET + PRESS_SHRINK / 2 : THUMB_OFFSET;
    const extraWidth = thumbWidth - THUMB_SIZE;
    const thumbX = checked ? THUMB_OFFSET + THUMB_TRAVEL - extraWidth : THUMB_OFFSET;

    // Sync motionX when thumbX changes (hover/press/checked) and not dragging
    useEffect(() => {
      if (dragging.current) return;
      if (!hasMounted.current) {
        motionX.set(thumbX);
      } else {
        animate(motionX, thumbX, thumbSpring);
      }
    }, [thumbX, motionX, thumbSpring]);

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
        if (Math.abs(delta) < DRAG_DEAD_ZONE) return;
        dragging.current = true;
      }

      const dragMin = THUMB_OFFSET;
      const pressedThumbWidth = THUMB_SIZE + PRESS_EXTEND;
      const dragMax = TRACK_WIDTH - THUMB_OFFSET - pressedThumbWidth;
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
        const dragMin = THUMB_OFFSET;
        const pressedThumbWidth = THUMB_SIZE + PRESS_EXTEND;
        const dragMax = TRACK_WIDTH - THUMB_OFFSET - pressedThumbWidth;
        const midpoint = (dragMin + dragMax) / 2;

        const shouldBeOn = currentX > midpoint;

        if (shouldBeOn !== checked) {
          onToggle();
        } else {
          // Snap back to current resting position (un-pressed)
          const snapTarget = checked ? THUMB_OFFSET + THUMB_TRAVEL : THUMB_OFFSET;
          animate(motionX, snapTarget, thumbSpring);
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
        const snapTarget = checked ? THUMB_OFFSET + THUMB_TRAVEL : THUMB_OFFSET;
        animate(motionX, snapTarget, thumbSpring);
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
            "relative shrink-0 cursor-pointer rounded-full border outline-none",
            "transition-colors duration-80",
            "focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          )}
          style={{
            width: TRACK_WIDTH,
            height: TRACK_HEIGHT,
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
                  className="absolute top-0 left-0 block rounded-full bg-white shadow-sm"
                  initial={false}
                  style={{
                    ...(baseStyle as React.CSSProperties | undefined),
                    height: thumbHeight,
                    width: thumbWidth,
                    x: motionX,
                  }}
                  animate={{ y: thumbY }}
                  transition={hasMounted.current ? thumbSpring : { duration: 0 }}
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
            // 20px track is taller than the label, so layout doesn't change.
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

Switch.displayName = "Switch";

export { Switch };
export type { SwitchProps };
