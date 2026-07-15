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
      <h2 className="text-[13px] font-semibold leading-tight text-foreground">{title}</h2>
      <p className="mt-0.5 text-[11.5px] text-muted-foreground">{description}</p>
    </div>
  );
}

export function CardEmpty({ description, title }: { description: string; title: string }) {
  return (
    <Empty className="min-h-56 rounded-none p-6">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Inbox aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function OverviewLoading() {
  return <LoadingArea className="lit min-h-80 rounded-lg" label="Loading overview breakdowns" />;
}

export function StatsError({ error }: { error: unknown }) {
  const message = overviewErrorMessage(error);
  return (
    <Alert variant="destructive">
      <AlertCircle aria-hidden />
      <AlertTitle>Could not load your overview</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function overviewErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return "Refresh the page, or try a shorter time range.";
  }

  if (error.code === "network_error") {
    return "Check your connection and try again.";
  }

  if (error.code === "invalid_response") {
    return "The overview returned unexpected data. Refresh the page and try again.";
  }

  if (error.code === "analytics_unavailable") {
    return "Your session data is safe, but the overview is temporarily unavailable. Try again soon.";
  }

  return "Refresh the page, or try a shorter time range.";
}
