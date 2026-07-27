import { useRef, useState, type FormEventHandler, type PointerEvent, type ReactNode } from "react";
import NumberFlow from "@number-flow/react";
import { Minus, Plus } from "@/lib/icon-map";
import { useReducedMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";

// Matches the AnimatedNumber roll used elsewhere, so a stepped value and a
// streamed metric move on the same curve.
const numberTransition = {
  duration: 240,
  easing: "cubic-bezier(0.22, 1, 0.36, 1)",
} satisfies EffectTiming;

const numberFormat = { useGrouping: false } as const;

/**
 * A number field that reads as one control: step buttons on either side of a
 * rolling digit. Typing edits the real input and lands instantly; the buttons
 * roll the digits, so a deliberate step is legible and a typed value is not.
 *
 * The input carries the value and the accessible name but renders transparent
 * over the NumberFlow display, which keeps the caret and selection behaviour of
 * a native field while the digits animate.
 */
export function NumberStepper({
  ariaLabel,
  className,
  max = Number.POSITIVE_INFINITY,
  min = Number.NEGATIVE_INFINITY,
  onChange,
  step = 1,
  suffix,
  value,
}: {
  ariaLabel: string;
  className?: string;
  max?: number;
  min?: number;
  onChange: (value: number) => void;
  /** Increment per button press, and the native arrow-key step. */
  step?: number;
  suffix?: string;
  value: number;
}) {
  const defaultValue = useRef(value);
  const inputRef = useRef<HTMLInputElement>(null);
  // Typing must not roll: the digits would chase the caret. Only the buttons
  // animate, so the roll always means "the control moved by one".
  const [animated, setAnimated] = useState(true);
  // The caret would visibly drift while the digits roll, so it hides for the
  // length of the animation.
  const [showCaret, setShowCaret] = useState(true);
  const reduceMotion = useReducedMotion();

  const handleInput: FormEventHandler<HTMLInputElement> = ({ currentTarget: element }) => {
    setAnimated(false);
    let next = value;
    if (element.value === "") {
      next = defaultValue.current;
    } else {
      const parsed = element.valueAsNumber;
      if (!Number.isNaN(parsed) && parsed >= min && parsed <= max) next = parsed;
    }
    // Reassert the input's own value: "09" and "9" are the same number, so
    // React would not re-render and the stale text would stay on screen.
    element.value = String(next);
    onChange(next);
  };

  const stepBy = (diff: number) => (event: PointerEvent<HTMLButtonElement>) => {
    setAnimated(true);
    if (event.pointerType === "mouse") {
      // Keep focus on the field rather than the button, so the ring stays on
      // the control and typing continues to work after a step.
      event.preventDefault();
      inputRef.current?.focus();
    }
    onChange(Math.min(Math.max(value + diff, min), max));
  };

  return (
    <div
      className={cn(
        // Fixed three-column track: both step buttons are the same square and
        // the field keeps one width whatever the suffix says, so a column of
        // steppers lines up. Same fill the switch paints on its off track, so
        // the two controls read as one material.
        "group inline-grid w-[132px] grid-cols-[32px_minmax(0,1fr)_32px] items-stretch overflow-hidden rounded-[7px] border border-border bg-[var(--control-fill)] font-mono text-[12px] text-foreground ring-1 ring-transparent transition-[border-color,box-shadow] duration-80 focus-within:ring-amber",
        className,
      )}
    >
      <StepButton
        disabled={value <= min}
        label={`Decrease ${ariaLabel}`}
        onPointerDown={stepBy(-step)}
      >
        <Minus aria-hidden size={13} strokeWidth={2} />
      </StepButton>

      <span className="flex items-center justify-center gap-1 py-1.5">
        <span className="relative grid items-center justify-items-center text-center [grid-template-areas:'overlap'] *:[grid-area:overlap]">
          <input
            aria-label={ariaLabel}
            autoComplete="off"
            className={cn(
              "number-stepper-input w-[3.5ch] bg-transparent text-center font-[inherit] text-transparent outline-none",
              showCaret ? "caret-foreground" : "caret-transparent",
            )}
            inputMode="numeric"
            max={max}
            min={min}
            onInput={handleInput}
            ref={inputRef}
            step={step}
            // Kerning off to match NumberFlow's own metrics, so the transparent
            // input and the visible digits stay aligned character for character.
            style={{ fontKerning: "none" }}
            type="number"
            value={value}
          />
          <NumberFlow
            animated={animated && reduceMotion !== true}
            aria-hidden
            className="pointer-events-none tabular-nums"
            format={numberFormat}
            locales="en-US"
            onAnimationsFinish={() => setShowCaret(true)}
            onAnimationsStart={() => setShowCaret(false)}
            transformTiming={numberTransition}
            value={value}
            willChange
          />
        </span>

        {/* The digits stay mono and tabular so a stepped value never shifts
            width; the unit is prose, so it takes the sans stack. */}
        {suffix === undefined ? null : (
          <span aria-hidden className="font-sans text-[11.5px] text-[var(--control-fill-muted)]">
            {suffix}
          </span>
        )}
      </span>

      <StepButton
        disabled={value >= max}
        label={`Increase ${ariaLabel}`}
        onPointerDown={stepBy(step)}
      >
        <Plus aria-hidden size={13} strokeWidth={2} />
      </StepButton>
    </div>
  );
}

function StepButton({
  children,
  disabled,
  label,
  onPointerDown,
}: {
  children: ReactNode;
  disabled: boolean;
  label: string;
  onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      aria-label={label}
      // Full-strength glyph: on --control-fill a muted grey measures under 3:1,
      // so hover cannot be a colour shift here — it lifts the surface instead,
      // and the press squashes the glyph the way a button should.
      className="group/step flex items-center justify-center text-foreground transition-colors duration-80 hover:bg-[oklch(1_0_0_/_0.08)] active:bg-[oklch(1_0_0_/_0.12)] disabled:pointer-events-none disabled:opacity-30"
      disabled={disabled}
      onPointerDown={onPointerDown}
      // The field owns focus and the keyboard already steps with the arrow
      // keys, so these stay out of the tab order.
      tabIndex={-1}
      type="button"
    >
      <span className="flex transition-transform duration-100 ease-out group-hover/step:scale-115 group-active/step:scale-90 motion-reduce:transition-none motion-reduce:group-hover/step:scale-100 motion-reduce:group-active/step:scale-100">
        {children}
      </span>
    </button>
  );
}
