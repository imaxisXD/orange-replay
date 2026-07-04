import { isRouteErrorResponse, Link, useRouteError } from "react-router";
import { Button } from "@/components/ui/button";

export function RouteError() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : "Something went wrong.";

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <section className="flex max-w-md flex-col gap-4 rounded-lg border border-border bg-card p-6 shadow-surface-2">
        <h1 className="text-xl font-semibold tracking-normal">Dashboard error</h1>
        <p className="text-sm text-muted-foreground">{message}</p>
        <Button asChild variant="tertiary">
          <Link to="/">Back to dashboard</Link>
        </Button>
      </section>
    </main>
  );
}
