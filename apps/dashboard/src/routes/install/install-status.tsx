import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadingIndicator } from "@/components/ui/loading-indicator";
import { fetchInstallStatus } from "@/lib/api";
import { formatAbsoluteTime, formatRelativeTime } from "@/lib/format";
import { RotateCcw } from "@/lib/icon-map";
import { AnimatePresence, m, useReducedMotion } from "@/lib/motion";
import { installStatusPollIntervalMs, shouldPollInstallStatus } from "@/lib/project-settings";
import { spring } from "@/lib/springs";
import { readInstallErrorMessage } from "./install-helpers";

export function InstallStatus({ projectId }: { projectId: string }) {
  const reduceMotion = useReducedMotion();
  const installStatusQuery = useQuery({
    queryKey: ["install-status", projectId],
    queryFn: () => fetchInstallStatus(projectId),
    refetchInterval: (query) => {
      if (query.state.data?.firstEventAt !== null && query.state.data !== undefined) return false;
      return shouldPollInstallStatus(document.visibilityState)
        ? installStatusPollIntervalMs
        : false;
    },
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const firstEventAt = installStatusQuery.data?.firstEventAt ?? null;
  const loading = installStatusQuery.isPending;
  const verifyError =
    installStatusQuery.error === null ? "" : readInstallErrorMessage(installStatusQuery.error);

  return (
    <section className="lit rounded-lg p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-medium leading-tight">Live verify</h2>
          <p className="mt-1 text-[13px] text-muted-foreground">Checks for the first event.</p>
        </div>
        <span className="text-[11.5px] text-muted-foreground">every 3s</span>
      </div>

      {verifyError.length > 0 && (
        <Alert className="mt-4" variant="destructive">
          <RotateCcw aria-hidden />
          <AlertTitle>Could not check install status</AlertTitle>
          <AlertDescription>
            <p>{verifyError}</p>
            <Button
              className="mt-2 border-danger-border bg-transparent text-danger-foreground hover:text-foreground"
              leadingIcon={RotateCcw}
              onClick={() => void installStatusQuery.refetch()}
              size="sm"
              variant="secondary"
            >
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="mt-5 min-h-15">
        <AnimatePresence initial={false} mode="wait">
          <m.div
            animate={{ opacity: 1, transform: "translateY(0px) scale(1)" }}
            exit={
              reduceMotion
                ? { opacity: 0 }
                : { opacity: 0, transform: "translateY(-4px) scale(0.97)" }
            }
            initial={
              reduceMotion ? false : { opacity: 0, transform: "translateY(4px) scale(0.97)" }
            }
            key={firstEventAt === null ? "waiting" : "installed"}
            transition={
              reduceMotion ? { duration: 0 } : firstEventAt === null ? spring.moderate : spring.slow
            }
          >
            {firstEventAt === null ? (
              <div className="flex items-start gap-3">
                <LoadingIndicator
                  className="mt-0.5"
                  label={loading ? "Checking install status" : "Waiting for the first event"}
                />
                <div>
                  <div className="text-[13px]">
                    {loading ? "Checking install status..." : "Waiting for the first event…"}
                  </div>
                  <div className="mt-1 text-[11.5px] text-muted-foreground">
                    Open a page with the snippet installed — this updates the moment data arrives.
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-start gap-3">
                <Badge color="green" size="sm" variant="dot">
                  Installed
                </Badge>
                <div className="text-[13px]" title={formatAbsoluteTime(firstEventAt)}>
                  First event seen {formatRelativeTime(firstEventAt)}
                </div>
              </div>
            )}
          </m.div>
        </AnimatePresence>
      </div>
    </section>
  );
}
