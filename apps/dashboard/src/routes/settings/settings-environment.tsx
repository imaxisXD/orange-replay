import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getApiToken, health } from "@/lib/api";
import { KeyRound, RotateCcw, Server } from "@/lib/icon-map";

type HealthState = "checking" | "connected" | "failed";

function useWorkerHealth() {
  const healthQuery = useQuery({
    queryKey: ["health"],
    queryFn: health,
  });
  const healthState: HealthState =
    healthQuery.isPending || healthQuery.isFetching
      ? "checking"
      : healthQuery.data?.ok === true
        ? "connected"
        : "failed";
  const error =
    healthQuery.error === null
      ? ""
      : healthQuery.error instanceof Error
        ? healthQuery.error.message
        : "Health check failed.";

  return { error, healthQuery, healthState };
}

export function SettingsHealthAlert() {
  const { error } = useWorkerHealth();
  if (error.length === 0) return null;

  return (
    <Alert variant="destructive">
      <Server aria-hidden />
      <AlertTitle>Health check failed</AlertTitle>
      <AlertDescription>{error}</AlertDescription>
    </Alert>
  );
}

export function SettingsEnvironmentCards() {
  const hasToken = getApiToken() !== null;
  const { healthQuery, healthState } = useWorkerHealth();

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <section className="lit flex flex-col gap-4 overflow-hidden rounded-lg p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-[15px] font-medium">API token</h2>
            <p className="text-[13px] text-muted-foreground">Stored in this browser only.</p>
          </div>
          <KeyRound aria-hidden className="size-5 text-muted-foreground" />
        </div>
        <Badge color={hasToken ? "green" : "amber"} size="sm" variant="dot">
          {hasToken ? "Token saved" : "Token missing"}
        </Badge>
      </section>

      <section className="lit flex flex-col gap-4 overflow-hidden rounded-lg p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-[15px] font-medium">Worker health</h2>
            <p className="text-[13px] text-muted-foreground">Checks the connected API worker.</p>
          </div>
          <Server aria-hidden className="size-5 text-muted-foreground" />
        </div>
        <div className="flex items-center justify-between gap-3">
          <HealthStatus healthState={healthState} />
          <Button
            leadingIcon={RotateCcw}
            loading={healthState === "checking"}
            onClick={() => void healthQuery.refetch()}
            size="sm"
            variant="ghost"
          >
            Check
          </Button>
        </div>
      </section>
    </div>
  );
}

function HealthStatus({ healthState }: { healthState: HealthState }) {
  if (healthState === "connected") {
    return (
      <Badge color="green" size="sm" variant="dot">
        Connected
      </Badge>
    );
  }

  if (healthState === "failed") {
    return (
      <Badge color="red" size="sm" variant="dot">
        Failed
      </Badge>
    );
  }

  return (
    <Badge color="gray" size="sm" variant="dot">
      Checking
    </Badge>
  );
}
