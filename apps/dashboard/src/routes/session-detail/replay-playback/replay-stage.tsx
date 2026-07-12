import type { RefObject } from "react";
import type { PlayerErrorEvent } from "@orange-replay/player";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AlertCircle } from "@/lib/icon-map";

export function ReplayStage({
  buffering,
  containerRef,
  isFollowing,
  liveConnected,
  playerError,
  ready,
  retryPlayer,
  waitingForKeyframe,
}: {
  buffering: boolean;
  containerRef: RefObject<HTMLDivElement | null>;
  isFollowing: boolean;
  liveConnected: boolean;
  playerError: PlayerErrorEvent | null;
  ready: boolean;
  retryPlayer: () => void;
  waitingForKeyframe: boolean;
}) {
  return (
    <div
      aria-busy={!ready || buffering || waitingForKeyframe}
      className="relative aspect-video min-h-90 overflow-hidden bg-background"
      data-testid="replay-stage"
    >
      <div ref={containerRef} className="absolute inset-0 overflow-hidden" />

      {isFollowing && waitingForKeyframe && playerError === null && (
        <ReplayOverlay
          dotClassName="live-pulse size-2.25 rounded-full bg-success"
          label={
            liveConnected ? "Connected live — waiting for the next keyframe…" : "Connecting live…"
          }
        />
      )}

      {ready && buffering && !waitingForKeyframe && playerError === null && (
        <ReplayOverlay
          dotClassName="size-8 animate-spin rounded-full border border-dash border-t-amber"
          label="Buffering…"
        />
      )}

      {playerError !== null && (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-background/82 p-4">
          <Alert className="max-w-md" variant="destructive">
            <AlertCircle aria-hidden />
            <AlertTitle>Could not play replay</AlertTitle>
            <AlertDescription>
              <p>{playerError.message}</p>
              <Button onClick={retryPlayer} size="sm" variant="secondary">
                Retry
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      )}
    </div>
  );
}

function ReplayOverlay({ dotClassName, label }: { dotClassName: string; label: string }) {
  return (
    <div
      aria-live="polite"
      className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-background/72"
      role="status"
    >
      <span className={dotClassName} />
      <span className="text-[13px] text-muted-foreground">{label}</span>
    </div>
  );
}
