import { decodeActivityHist } from "@/lib/activity-hist";

const SPARK_HEIGHT_PX = 16;
const MAX_LEVEL = 15;
// Same color as the player scrubber's activity ticks — the sparkline is the
// mini version of that timeline, so the two surfaces share one vocabulary.
const BAR_COLOR = "#2e2e38";
const ERROR_COLOR = "#f4534e";

export function ActivitySpark({ hist }: { hist: string | null | undefined }) {
  const decoded = decodeActivityHist(hist);

  if (decoded === null) {
    return (
      <div aria-hidden className="flex h-4 w-21 items-end" title="No activity data">
        <div className="h-0.5 w-full rounded-[1px] bg-[#17171c]" />
      </div>
    );
  }

  const errorCount = decoded.errors.filter(Boolean).length;
  const label =
    errorCount > 0
      ? `Activity timeline; errors in ${errorCount} of 8 segments`
      : "Activity timeline";

  return (
    <div
      aria-label={label}
      className="flex h-4 w-21 items-end gap-[1.5px]"
      role="img"
      title={label}
    >
      {decoded.levels.map((level, index) => (
        <div
          className="w-full rounded-[1px]"
          key={index}
          style={{
            height: Math.max(2, Math.round((level / MAX_LEVEL) * SPARK_HEIGHT_PX)),
            backgroundColor: decoded.errors[index] === true ? ERROR_COLOR : BAR_COLOR,
          }}
        />
      ))}
    </div>
  );
}
