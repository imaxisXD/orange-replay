import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { BrandMark } from "@/components/brand-mark";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { accountQueryKey, fetchAccount } from "@/lib/api";
import { readDashboardAccessError, signOutDashboardAccess } from "@/lib/dashboard-access";
import { AlertCircle, LogOut } from "@/lib/icon-map";

export function ProjectsPage() {
  const navigate = useNavigate();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const accountQuery = useQuery({
    queryKey: accountQueryKey,
    queryFn: fetchAccount,
    staleTime: 30_000,
  });

  async function signOut(): Promise<void> {
    setIsSigningOut(true);
    setSignOutError("");
    try {
      await signOutDashboardAccess();
      void navigate({ to: "/login", replace: true });
    } catch (error) {
      setSignOutError(readDashboardAccessError(error, "Could not sign out. Try again."));
    }
    setIsSigningOut(false);
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <section className="lit flex w-full max-w-120 flex-col gap-5 overflow-hidden rounded-lg p-6">
        <div className="flex items-center gap-2.5">
          <BrandMark className="size-7" />
          <span className="text-[14px] font-medium">Orange Replay</span>
        </div>
        <Alert variant={accountQuery.isError ? "destructive" : "default"}>
          <AlertCircle aria-hidden />
          <AlertTitle>
            {accountQuery.isError ? "Could not load projects" : "No project is available"}
          </AlertTitle>
          <AlertDescription>
            {accountQuery.isError ? (
              <p>Refresh the page or sign in again.</p>
            ) : (
              <p>Your account has a workspace but no project. Ask a workspace owner to add one.</p>
            )}
          </AlertDescription>
        </Alert>
        {signOutError.length > 0 && (
          <p className="text-[13px] text-danger" role="alert">
            {signOutError}
          </p>
        )}
        <div className="flex justify-end">
          <Button
            leadingIcon={LogOut}
            loading={isSigningOut}
            onClick={() => void signOut()}
            variant="secondary"
          >
            Sign out
          </Button>
        </div>
      </section>
    </main>
  );
}
