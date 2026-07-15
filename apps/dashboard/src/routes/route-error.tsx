import { Link, isNotFound, useParams } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";

export function RouteError({ error, notFound = false }: { error?: unknown; notFound?: boolean }) {
  const params = useParams({ strict: false });
  const projectId = params.projectId;
  const is404 = notFound || isNotFound(error);
  const message = readErrorMessage(error);

  return (
    <section className="mx-auto flex min-h-105 w-full max-w-md items-center justify-center">
      <div className="lit flex w-full flex-col gap-4 overflow-hidden rounded-lg p-6 text-center">
        <h1 className="text-[18px] font-semibold leading-[1.1] tracking-[-0.015em]">
          {is404 ? "Page not found" : "This page hit an error"}
        </h1>
        <p className="text-[13px] text-muted-foreground">
          {is404
            ? "This page does not exist — the link may be old."
            : "Sometimes this happens. Head back to sessions and try again."}
        </p>
        {!is404 && message.length > 0 && (
          <p className="font-mono text-[12px] text-muted-foreground">{message}</p>
        )}
        <Button asChild>
          {projectId === undefined ? (
            <Link to="/projects">Back to projects</Link>
          ) : (
            <Link params={{ projectId }} to="/projects/$projectId/sessions">
              Back to sessions
            </Link>
          )}
        </Button>
      </div>
    </section>
  );
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "";
}
