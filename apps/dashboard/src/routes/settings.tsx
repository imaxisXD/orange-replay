import { useEffect, useState } from "react";
import { KeyRound, RotateCcw, Server } from "lucide-react";
import { StatusPill } from "@/components/status-pill";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { getApiToken, health } from "@/lib/api";

type HealthState = "checking" | "connected" | "failed";

export function SettingsPage() {
  const [healthState, setHealthState] = useState<HealthState>("checking");
  const [error, setError] = useState("");
  const hasToken = getApiToken() !== null;

  async function checkHealth(): Promise<void> {
    setHealthState("checking");
    setError("");

    try {
      const result = await health();
      setHealthState(result.ok ? "connected" : "failed");
    } catch (caughtError) {
      setHealthState("failed");
      setError(caughtError instanceof Error ? caughtError.message : "Health check failed.");
    }
  }

  useEffect(() => {
    void checkHealth();
  }, []);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-[18px] font-semibold tracking-[-0.015em]">
          Settings
          <span className="ml-[10px] text-[12px] font-normal text-dim">
            Local project controls.
          </span>
        </h1>
      </div>

      {error.length > 0 && (
        <Alert variant="destructive">
          <Server aria-hidden />
          <AlertTitle>Health check failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <section className="lit flex flex-col gap-4 overflow-hidden rounded-lg p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="text-[15px] font-medium">Dev token</h2>
              <p className="text-[13px] text-muted-foreground">Stored in this browser only.</p>
            </div>
            <KeyRound aria-hidden className="size-5 text-muted-foreground" />
          </div>
          <StatusPill kind={hasToken ? "ok" : "rage"}>
            {hasToken ? "Token saved" : "Token missing"}
          </StatusPill>
        </section>

        <section className="lit flex flex-col gap-4 overflow-hidden rounded-lg p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="text-[15px] font-medium">Worker health</h2>
              <p className="text-[13px] text-muted-foreground">Checks the local API worker.</p>
            </div>
            <Server aria-hidden className="size-5 text-muted-foreground" />
          </div>
          <div className="flex items-center justify-between gap-3">
            <HealthStatus healthState={healthState} />
            <Button
              leadingIcon={RotateCcw}
              loading={healthState === "checking"}
              onClick={() => void checkHealth()}
              size="sm"
              variant="ghost"
            >
              Check
            </Button>
          </div>
        </section>

        <section className="lit flex flex-col gap-2 overflow-hidden rounded-lg p-5 md:col-span-2">
          <h2 className="text-[15px] font-medium">Project config</h2>
          <p className="text-[13px] text-muted-foreground">
            Masking rules, capture toggles, sampling, retention, and keys will be editable here
            soon.
          </p>
        </section>
      </div>
    </div>
  );
}

function HealthStatus({ healthState }: { healthState: HealthState }) {
  if (healthState === "connected") {
    return <StatusPill kind="ok">Connected</StatusPill>;
  }

  if (healthState === "failed") {
    return <StatusPill kind="err">Failed</StatusPill>;
  }

  return <StatusPill kind="neutral">Checking</StatusPill>;
}
