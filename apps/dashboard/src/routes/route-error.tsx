import { isRouteErrorResponse, Link, useParams, useRouteError } from "react-router";
import { Button } from "@/components/ui/button";
import { defaultProjectId } from "@/router";

export function RouteError({ notFound = false }: { notFound?: boolean }) {
  const params = useParams();
  const error = useRouteError();
  const projectId = params.projectId ?? defaultProjectId;
  const is404 = notFound || (isRouteErrorResponse(error) && error.status === 404);
  const message = readErrorMessage(error);

  return (
    <section className="mx-auto flex min-h-[420px] w-full max-w-md items-center justify-center">
      <div className="lit flex w-full flex-col gap-4 overflow-hidden rounded-lg p-6 text-center">
        <h1 className="text-[18px] font-semibold tracking-[-0.015em]">
          {is404 ? "Page not found" : "Something went wrong"}
        </h1>
        <p className="text-[13px] text-muted-foreground">
          {is404 ? "This page is not available." : "The dashboard could not show this page."}
        </p>
        {!is404 && message.length > 0 && (
          <p className="font-mono text-[12px] text-dim">{message}</p>
        )}
        <Button asChild>
          <Link to={`/projects/${projectId}/sessions`}>Back to sessions</Link>
        </Button>
      </div>
    </section>
  );
}

function readErrorMessage(error: unknown): string {
  if (isRouteErrorResponse(error)) return `${error.status} ${error.statusText}`;
  if (error instanceof Error) return error.message;
  return "";
}
