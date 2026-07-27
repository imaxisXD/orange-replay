import dateRangeOwlSrc from "@/assets/empty-states/date-range-owl.webp";
import sessionsBeetleReelSrc from "@/assets/empty-states/layers/sessions-beetle-reel.webp";
import sessionsFilmMothSrc from "@/assets/empty-states/layers/sessions-film-moth.webp";
import sessionsFrameFishSrc from "@/assets/empty-states/layers/sessions-frame-fish.webp";
import sessionsReelSnailSrc from "@/assets/empty-states/layers/sessions-reel-snail.webp";
import sessionsWingedWatchSrc from "@/assets/empty-states/layers/sessions-winged-watch.webp";
import { Button } from "@/components/ui/button";
import {
  ParallaxEmptyStateField,
  type ParallaxEmptyStateLayer,
} from "@/components/parallax-empty-state-field";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

export function SessionsDateRangeEmptyState({
  canWiden,
  onShowLast28Days,
}: {
  canWiden: boolean;
  onShowLast28Days: () => void;
}) {
  // `lit` carries the card plate, grain, and dashed bloom: the same frame the
  // live empty state sits in. No border utilities here, since `.lit` sets
  // border: none and draws its own dashed edge.
  return (
    <Empty className="lit min-h-[38rem] min-w-0 flex-1 overflow-hidden rounded-lg p-0 md:p-0">
      <ParallaxEmptyStateField
        className="min-h-[38rem] w-full flex-1 px-6 py-10"
        layers={DATE_RANGE_EMPTY_STATE_LAYERS}
      >
        <EmptyHeader className="max-w-md gap-2">
          <EmptyMedia className="mb-4 size-56 sm:size-64">
            <img
              alt=""
              aria-hidden="true"
              className="h-full w-full object-contain"
              draggable={false}
              height={192}
              src={dateRangeOwlSrc}
              width={192}
            />
          </EmptyMedia>
          <EmptyTitle>No sessions in this date range</EmptyTitle>
          <EmptyDescription>
            {canWiden
              ? "Nothing was recorded during this period. Try a wider date range."
              : "Nothing was recorded during this period. Pick another date range."}
          </EmptyDescription>
        </EmptyHeader>
        {canWiden && (
          <EmptyContent>
            <Button onClick={onShowLast28Days} variant="secondary">
              Show last 28 days
            </Button>
          </EmptyContent>
        )}
      </ParallaxEmptyStateField>
    </Empty>
  );
}

/**
 * Same five collage creatures as the session-stage field, since both states
 * belong to the sessions page, arranged differently so the two never read as
 * the same screenshot. Near layers first: the mobile rule hides `n + 6`.
 */
const DATE_RANGE_EMPTY_STATE_LAYERS: readonly ParallaxEmptyStateLayer[] = [
  {
    src: sessionsWingedWatchSrc,
    left: "12%",
    top: "25%",
    width: "clamp(3.8rem, 6vw, 6rem)",
    movement: -12,
    opacity: 0.4,
    rotation: -6,
  },
  {
    src: sessionsReelSnailSrc,
    left: "88%",
    top: "63%",
    width: "clamp(4rem, 6.4vw, 6.4rem)",
    movement: 12,
    opacity: 0.38,
    rotation: 5,
  },
  {
    src: sessionsFilmMothSrc,
    left: "85%",
    top: "27%",
    width: "clamp(3.2rem, 5vw, 5rem)",
    movement: 16,
    opacity: 0.34,
    rotation: 7,
  },
  {
    src: sessionsBeetleReelSrc,
    left: "13%",
    top: "68%",
    width: "clamp(4rem, 6.6vw, 6.6rem)",
    movement: -13,
    opacity: 0.36,
    rotation: -8,
  },
  {
    src: sessionsFrameFishSrc,
    left: "50%",
    top: "91%",
    width: "clamp(3.2rem, 5vw, 5rem)",
    movement: 15,
    opacity: 0.28,
    rotation: 3,
  },
  {
    src: sessionsWingedWatchSrc,
    left: "31%",
    top: "11%",
    width: "clamp(2rem, 2.9vw, 2.9rem)",
    movement: -19,
    opacity: 0.2,
    rotation: 12,
  },
  {
    src: sessionsFilmMothSrc,
    left: "72%",
    top: "85%",
    width: "clamp(2.1rem, 3.1vw, 3.1rem)",
    movement: 18,
    opacity: 0.19,
    rotation: -9,
  },
  {
    src: sessionsReelSnailSrc,
    left: "6%",
    top: "45%",
    width: "clamp(2.2rem, 3.2vw, 3.2rem)",
    movement: -20,
    opacity: 0.18,
    rotation: 6,
  },
];
