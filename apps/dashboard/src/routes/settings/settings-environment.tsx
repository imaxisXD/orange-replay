import { useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { SettingsCard } from "./settings-fields";
import { Button } from "@/components/ui/button";
import { health } from "@/lib/api";
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
      : "Could not reach the Worker. Check your connection and try again.";

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
  const { healthQuery, healthState } = useWorkerHealth();

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <SettingsCard
        body="Protected by your signed-in account."
        className="p-4"
        right={<KeyRound aria-hidden className="size-5 text-muted-foreground" />}
        title="Signed-in account"
      >
        <Badge color="green" size="sm" variant="dot">
          Signed in
        </Badge>
      </SettingsCard>

      <SettingsCard
        body="Checks the connected API worker."
        className="p-4"
        right={<Server aria-hidden className="size-5 text-muted-foreground" />}
        title="Worker health"
      >
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
      </SettingsCard>
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
