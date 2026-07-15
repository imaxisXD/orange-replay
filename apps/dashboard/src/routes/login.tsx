import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { m } from "@/lib/motion";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { LoadingArea } from "@/components/ui/loading-indicator";
import { authConfigQueryKey, fetchAuthConfig } from "@/lib/api";
import {
  readDashboardAccess,
  readDashboardAccessError,
  startGithubSignIn,
} from "@/lib/dashboard-access";
import { AlertCircle, Github, RotateCcw } from "@/lib/icon-map";
import { loginReasonMessage, safeReturnPath } from "@/lib/login-return";
import { spring } from "@/lib/springs";

// Split + stagger the card's contents on first paint; MotionConfig
// (reducedMotion="user") drops the y-shift and keeps a plain fade when the
// visitor prefers reduced motion.
const cardEnter = {
  hidden: {},
  show: { transition: { delayChildren: 0.04, staggerChildren: 0.08 } },
};
const cardChild = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: spring.moderate },
};

export function LoginPage() {
  const search = useSearch({ from: "/login" });
  const returnTo = safeReturnPath(search.returnTo);
  const [error, setError] = useState("");
  const [isChecking, setIsChecking] = useState(false);
  const authConfigQuery = useQuery({
    queryKey: authConfigQueryKey,
    queryFn: fetchAuthConfig,
    staleTime: 60_000,
  });
  const authMode = authConfigQuery.data?.mode;
  const loginAccess = authMode === undefined ? undefined : readDashboardAccess("private", authMode);
  const shownError = error.length > 0 ? error : loginReasonMessage(search.reason, authMode);

  async function signInWithGithub(): Promise<void> {
    setIsChecking(true);
    setError("");
    try {
      const returnUrl = new URL(returnTo, window.location.origin).href;
      const errorUrl = new URL("/login", window.location.origin);
      errorUrl.searchParams.set("reason", "unauthorized");
      errorUrl.searchParams.set("returnTo", returnTo);
      await startGithubSignIn({
        callbackURL: returnUrl,
        newUserCallbackURL: returnUrl,
        errorCallbackURL: errorUrl.href,
      });
    } catch (caughtError) {
      setError(readDashboardAccessError(caughtError, "GitHub sign-in could not start. Try again."));
      setIsChecking(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <m.section
        animate="show"
        className="lit flex w-full max-w-100 flex-col gap-6 overflow-hidden rounded-lg p-6"
        initial="hidden"
        variants={cardEnter}
      >
        <m.div className="mt-4 flex items-center gap-2.5" variants={cardChild}>
          <BrandMark className="size-7" />
          <span className="text-[14px] font-medium">Orange Replay</span>
        </m.div>

        <m.div variants={cardChild}>
          {authConfigQuery.isPending ? (
            <LoadingArea className="min-h-20" label="Checking sign-in options" />
          ) : authConfigQuery.isError || loginAccess?.adapter === "unavailable" ? (
            <Alert variant="destructive">
              <AlertCircle aria-hidden />
              <AlertTitle>Sign-in is not ready</AlertTitle>
              <AlertDescription>
                <p>
                  {authConfigQuery.isError
                    ? "Could not check the sign-in setup."
                    : "The Better Auth and GitHub settings are incomplete."}
                </p>
                <Button
                  className="mt-2 border-danger-border bg-transparent text-danger-foreground"
                  leadingIcon={RotateCcw}
                  onClick={() => void authConfigQuery.refetch()}
                  size="sm"
                  variant="secondary"
                >
                  Check again
                </Button>
              </AlertDescription>
            </Alert>
          ) : (
            <div className="flex flex-col gap-3">
              <div>
                <h1 className="text-[16px] font-semibold leading-[1.1]">
                  Sign in to your workspace
                </h1>
                <p className="mt-1 text-[13px] text-muted-foreground">
                  Use GitHub to manage projects and write keys.
                </p>
              </div>
              {shownError.length > 0 && (
                <p className="text-[13px] text-danger" role="alert">
                  {shownError}
                </p>
              )}
              <Button
                className="w-full"
                leadingIcon={Github}
                loading={isChecking}
                onClick={() => void signInWithGithub()}
                type="button"
              >
                Continue with GitHub
              </Button>
            </div>
          )}
        </m.div>
      </m.section>
    </main>
  );
}
