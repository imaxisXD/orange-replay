import { type ReactNode } from "react";

export function DemoUnavailableStateContent({
  actions,
  brand,
  error,
}: {
  actions: ReactNode;
  brand: ReactNode;
  error?: unknown;
}) {
  return (
    <section className="mx-auto flex min-h-105 w-full max-w-md items-center justify-center">
      <div className="lit flex w-full flex-col gap-4 overflow-hidden rounded-lg p-6 text-center">
        <div className="mx-auto flex items-center gap-2.5">{brand}</div>
        <div className="flex flex-col gap-2">
          <h1 className="text-[18px] font-semibold tracking-[-0.015em]">Demo not available</h1>
          <p className="text-[13px] text-muted-foreground">{demoUnavailableMessage(error)}</p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">{actions}</div>
      </div>
    </section>
  );
}

function demoUnavailableMessage(error: unknown): string {
  if (hasStatus(error, 0)) {
    return "The live demo could not be reached. Try again in a moment.";
  }
  return "The live demo is not turned on for this deployment.";
}

function hasStatus(error: unknown, status: number): boolean {
  return (
    typeof error === "object" && error !== null && "status" in error && error.status === status
  );
}
