import { useEffect, useState } from "react";
import { KeyRound, RotateCcw, Server } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-normal">Settings</h1>
        <p className="text-sm text-muted-foreground">Project config editing lands in T3.6.</p>
      </div>

      {error.length > 0 && (
        <Alert variant="destructive">
          <Server aria-hidden />
          <AlertTitle>Health check failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5 shadow-surface-1">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="font-semibold tracking-normal">Dev token</h2>
              <p className="text-sm text-muted-foreground">Stored in this browser only.</p>
            </div>
            <KeyRound aria-hidden className="size-5 text-muted-foreground" />
          </div>
          <Badge color={hasToken ? "green" : "orange"} variant="dot">
            {hasToken ? "Token saved" : "Token missing"}
          </Badge>
        </section>

        <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5 shadow-surface-1">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="font-semibold tracking-normal">Worker health</h2>
              <p className="text-sm text-muted-foreground">Checks the local API worker.</p>
            </div>
            <Server aria-hidden className="size-5 text-muted-foreground" />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Badge
              color={
                healthState === "connected" ? "green" : healthState === "failed" ? "red" : "gray"
              }
              variant="dot"
            >
              {healthState === "checking"
                ? "Checking"
                : healthState === "connected"
                  ? "Connected"
                  : "Failed"}
            </Badge>
            <Button
              leadingIcon={RotateCcw}
              loading={healthState === "checking"}
              onClick={() => void checkHealth()}
              size="sm"
              variant="tertiary"
            >
              Check
            </Button>
          </div>
        </section>

        <section className="flex flex-col gap-2 rounded-lg border border-border bg-card p-5 shadow-surface-1 md:col-span-2">
          <h2 className="font-semibold tracking-normal">Project config</h2>
          <p className="text-sm text-muted-foreground">
            Masking rules, capture toggles, sampling, retention, keys, snippets, and live verify are
            planned for T3.6.
          </p>
        </section>
      </div>
    </div>
  );
}
