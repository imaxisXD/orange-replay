import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { LoadingArea } from "@/components/ui/loading-indicator";
import { ApiError } from "@/lib/api";
import { AlertCircle, Inbox } from "@/lib/icon-map";

export function CardTitle({ description, title }: { description: string; title: string }) {
  return (
    <div>
      <h2 className="text-[13px] font-semibold text-foreground">{title}</h2>
      <p className="mt-0.5 text-[11.5px] text-dim">{description}</p>
    </div>
  );
}

export function CardEmpty({ description }: { description: string }) {
  return (
    <Empty className="min-h-56 rounded-none p-6">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Inbox aria-hidden />
        </EmptyMedia>
        <EmptyTitle>Nothing in this range yet</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function OverviewLoading() {
  return <LoadingArea className="lit min-h-105 rounded-lg" label="Loading overview analytics" />;
}

export function StatsError({ error }: { error: unknown }) {
  const message =
    error instanceof ApiError
      ? (error.code ?? error.message)
      : "The analytics request failed. Refresh, or try a narrower date range.";
  return (
    <Alert variant="destructive">
      <AlertCircle aria-hidden />
      <AlertTitle>Could not load analytics</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
