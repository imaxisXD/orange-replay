import { useRef, useState } from "react";
import NumberFlow, {
  NumberFlowGroup,
  type Format,
  type NumberFlowElement,
} from "@number-flow/react";
import { formatDuration } from "@/lib/format";

const numberTransition = {
  duration: 240,
  easing: "cubic-bezier(0.22, 1, 0.36, 1)",
} satisfies EffectTiming;

const plainNumberFormat = {
  useGrouping: false,
} satisfies Format;

const paddedTimeFormat = {
  minimumIntegerDigits: 2,
  useGrouping: false,
} satisfies Format;

export function AnimatedNumber({
  animated = true,
  format,
  startFromZero = false,
  suffix,
  value,
}: {
  animated?: boolean;
  format?: Format;
  startFromZero?: boolean;
  suffix?: string;
  value: number | null | undefined;
}) {
  if (value === null) return <span aria-label="No data">—</span>;

  return (
    <AnimatedNumberFlow
      animated={animated}
      format={format}
      startFromZero={startFromZero}
      suffix={suffix}
      value={value ?? 0}
    />
  );
}

function AnimatedNumberFlow({
  animated,
  format,
  startFromZero,
  suffix,
  value,
}: {
  animated: boolean;
  format?: Format;
  startFromZero: boolean;
  suffix?: string;
  value: number;
}) {
  if (startFromZero && animated) {
    return <NumberFlowStartingAtZero format={format} suffix={suffix} value={value} />;
  }

  return <NumberFlowValue animated={animated} format={format} suffix={suffix} value={value} />;
}

function NumberFlowStartingAtZero({
  format,
  suffix,
  value,
}: {
  format?: Format;
  suffix?: string;
  value: number;
}) {
  const [displayedValue, setDisplayedValue] = useState(0);
  const displayedValueRef = useRef(0);
  const queuedValueRef = useRef(value);
  const mountedElementRef = useRef<NumberFlowElement | null>(null);
  const updateQueuedRef = useRef(false);

  function setFlowElement(element: NumberFlowElement | null) {
    mountedElementRef.current = element;
    if (element === null) return;

    queuedValueRef.current = value;
    if (updateQueuedRef.current || displayedValueRef.current === queuedValueRef.current) {
      return;
    }

    updateQueuedRef.current = true;
    queueMicrotask(() => {
      updateQueuedRef.current = false;
      if (mountedElementRef.current !== element) return;
      displayedValueRef.current = queuedValueRef.current;
      setDisplayedValue(queuedValueRef.current);
    });
  }

  return (
    <NumberFlowValue
      animated
      flowRef={setFlowElement}
      format={format}
      suffix={suffix}
      value={displayedValue}
    />
  );
}

function NumberFlowValue({
  animated,
  flowRef,
  format,
  suffix,
  value,
}: {
  animated: boolean;
  flowRef?: (element: NumberFlowElement | null) => void;
  format?: Format;
  suffix?: string;
  value: number;
}) {
  return (
    <NumberFlow
      animated={animated}
      ref={flowRef}
      format={format}
      opacityTiming={numberTransition}
      respectMotionPreference
      spinTiming={numberTransition}
      suffix={suffix}
      transformTiming={numberTransition}
      value={value}
    />
  );
}

export function AnimatedDuration({
  animated = true,
  startFromZero = false,
  value,
}: {
  animated?: boolean;
  startFromZero?: boolean;
  value: number | null | undefined;
}) {
  if (value === null) return <span aria-label="No data">—</span>;

  const totalSeconds = Math.max(0, Math.round((value ?? 0) / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const showsHours = hours > 0;

  return (
    <span aria-label={formatDuration(value ?? 0)}>
      <NumberFlowGroup>
        <span aria-hidden className="inline-flex items-baseline">
          {showsHours ? (
            <>
              <AnimatedNumber
                animated={animated}
                format={plainNumberFormat}
                startFromZero={startFromZero}
                value={hours}
              />
              <span>:</span>
            </>
          ) : null}
          <AnimatedNumber
            animated={animated}
            format={showsHours ? paddedTimeFormat : plainNumberFormat}
            startFromZero={startFromZero}
            value={minutes}
          />
          <span>:</span>
          <AnimatedNumber
            animated={animated}
            format={paddedTimeFormat}
            startFromZero={startFromZero}
            value={seconds}
          />
        </span>
      </NumberFlowGroup>
    </span>
  );
}
