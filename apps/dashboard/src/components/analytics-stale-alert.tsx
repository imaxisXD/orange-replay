import type { AnalyticsDelivery, AnalyticsState, AnalyticsView } from "@orange-replay/shared";
import { AlertCircle } from "../lib/icon-map";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";

export function AnalyticsStatusNotice({
  analyticsDelivery,
  analyticsState,
  analyticsView,
  onShowLatest,
}: {
  analyticsDelivery?: AnalyticsDelivery;
  analyticsState?: AnalyticsState;
  analyticsView?: AnalyticsView;
  onShowLatest?: () => void;
}) {
  const pinned = analyticsView === "pinned";
  const stale = analyticsState === "stale";
  const pending = analyticsDelivery?.state === "pending";
  const directRead =
    analyticsState === "compare" ||
    analyticsState === "d1_rollback" ||
    analyticsState === "d1_residency";
  if (!pinned && !stale && !pending && (analyticsDelivery !== undefined || directRead)) return null;

  return (
    <Alert className="border-amber/30 bg-amber/5 text-foreground [&>svg]:text-amber">
      <AlertCircle aria-hidden />
      <AlertTitle>
        {pinned
          ? "Fixed analytics snapshot"
          : stale
            ? "Analytics may be out of date"
            : pending
              ? "Recent analytics are still arriving"
              : "Analytics delivery status unavailable"}
      </AlertTitle>
      <AlertDescription>
        {pinned ? (
          <>
            <p>This view keeps the selected snapshot. Newer sessions are excluded.</p>
            {stale && <p>The analytics service is unavailable, so its saved snapshot is shown.</p>}
            {onShowLatest !== undefined && (
              <Button className="mt-2" onClick={onShowLatest} size="sm" variant="secondary">
                Show latest results
              </Button>
            )}
          </>
        ) : (
          <>
            {stale && (
              <p>
                The analytics service is temporarily unavailable, so these are the last saved
                results. New sessions or changes may not appear yet.
              </p>
            )}
            {pending ? (
              <p>
                This project has {analyticsDelivery.pendingExports.toLocaleString()} analytics{" "}
                {analyticsDelivery.pendingExports === 1 ? "update" : "updates"} waiting to appear.{" "}
                At the last check, the oldest update had waited {pendingAge(analyticsDelivery)}.
              </p>
            ) : analyticsDelivery === undefined && !directRead ? (
              <p>
                These results are available, but delivery of newer sessions could not be checked.
              </p>
            ) : null}
          </>
        )}
      </AlertDescription>
    </Alert>
  );
}

function pendingAge(delivery: AnalyticsDelivery): string {
  const minutes = Math.max(
    0,
    Math.floor((delivery.checkedAt - (delivery.oldestPendingAt ?? delivery.checkedAt)) / 60_000),
  );
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

export function AnalyticsStaleAlert() {
  return (
    <Alert className="border-amber/30 bg-amber/5 text-foreground [&>svg]:text-amber">
      <AlertCircle aria-hidden />
      <AlertTitle>Analytics may be out of date</AlertTitle>
      <AlertDescription>
        The analytics service is temporarily unavailable, so these are the last saved results. New
        sessions or changes may not appear yet.
      </AlertDescription>
    </Alert>
  );
}
