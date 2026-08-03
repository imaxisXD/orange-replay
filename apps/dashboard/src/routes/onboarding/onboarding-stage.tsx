import type { FormEvent, ReactNode } from "react";
import { m, useReducedMotion } from "@/lib/motion";
import { REVEAL, STEP } from "./onboarding-motion";
import { useOnboarding } from "./onboarding-context";

/**
 * One activation screen's frame. Every step renders through this, so the slide
 * and the staggered reveal come from one place and each step only describes its
 * own content.
 *
 * The step slides along the direction of travel — Continue moves one way, Back
 * moves the other — so the flow reads as a position in a sequence rather than
 * an unrelated screen swap. Height is not animated here: the shell's frame
 * persists across steps and owns that tween.
 */
export function OnboardingStage({
  action,
  body,
  heading,
  onSubmit,
  support,
}: {
  /**
   * Optional, and null on step 2: that step has no Continue, because it waits
   * for the event itself. Its status card takes this slot instead, so the last
   * chunk of the reveal still lands on whatever moves the step on.
   */
  action: ReactNode;
  body: ReactNode;
  heading: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  /**
   * Optional. A step whose body already says what to do goes without one rather
   * than restating it: step 2's stack picker names the file and the placement,
   * so a supporting line there spent a whole chunk of the column agreeing with
   * the instruction underneath it.
   */
  support?: ReactNode;
}) {
  const reduceMotion = useReducedMotion() === true;
  const { direction, isFirstPaint } = useOnboarding();
  const lead = isFirstPaint ? REVEAL.firstPaintDelay : 0;

  return (
    <m.form
      animate={{ filter: "blur(0px)", opacity: 1, x: 0 }}
      className="flex flex-col"
      initial={
        reduceMotion
          ? false
          : { filter: `blur(${STEP.blur}px)`, opacity: 0, x: direction * STEP.travelX }
      }
      onSubmit={onSubmit}
      transition={reduceMotion ? { duration: 0 } : { ...STEP.transition, delay: lead }}
    >
      <Chunk delay={lead + REVEAL.delays.heading} reduceMotion={reduceMotion}>
        <h1 className="text-[20px] font-semibold leading-6 tracking-[-0.025em] text-foreground">
          {heading}
        </h1>
      </Chunk>

      {support !== undefined && (
        <Chunk
          className="mt-2 text-[14px] leading-5 text-muted-foreground"
          delay={lead + REVEAL.delays.support}
          reduceMotion={reduceMotion}
        >
          {support}
        </Chunk>
      )}

      <Chunk className="mt-4.5" delay={lead + REVEAL.delays.body} reduceMotion={reduceMotion}>
        {body}
      </Chunk>

      {action !== null && action !== undefined && (
        <Chunk className="mt-6" delay={lead + REVEAL.delays.action} reduceMotion={reduceMotion}>
          {action}
        </Chunk>
      )}
    </m.form>
  );
}

/**
 * One staggered chunk of a step. Splitting a step into heading, support, body
 * and action lets the entrance carry reading order. The stagger runs on the
 * step's own entrance only — never on a value changing inside it.
 */
function Chunk({
  children,
  className,
  delay,
  reduceMotion,
}: {
  children: ReactNode;
  className?: string;
  delay: number;
  reduceMotion: boolean;
}) {
  return (
    <m.div
      animate={{ filter: "blur(0px)", opacity: 1, y: 0 }}
      className={className}
      initial={
        reduceMotion ? false : { filter: `blur(${REVEAL.blur}px)`, opacity: 0, y: REVEAL.riseY }
      }
      transition={reduceMotion ? { duration: 0 } : { ...REVEAL.spring, delay }}
    >
      {children}
    </m.div>
  );
}
