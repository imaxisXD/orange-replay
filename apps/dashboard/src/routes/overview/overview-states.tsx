import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
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
  return (
    <>
      <section className="lit grid overflow-hidden rounded-lg sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div
            className="border-r border-dashed border-dash px-4.5 py-4 last:border-r-0"
            key={index}
          >
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-2 h-7 w-24" />
            <Skeleton className="mt-2 h-3 w-32" />
          </div>
        ))}
      </section>
      <section className="lit overflow-hidden rounded-lg p-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="mt-2 h-3 w-44" />
        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_unused, index) => (
            <Skeleton className="h-16 w-full" key={index} />
          ))}
        </div>
      </section>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {Array.from({ length: 4 }, (_, index) => (
          <section className="lit min-h-80 rounded-lg p-4" key={index}>
            <Skeleton className="h-4 w-28" />
            <Skeleton className="mt-2 h-3 w-48" />
            <div className="mt-6 flex flex-col gap-4">
              {Array.from({ length: 4 }, (_unused, rowIndex) => (
                <Skeleton className="h-9 w-full" key={rowIndex} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </>
  );
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
