import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { m } from "@/lib/motion";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { IconSwap } from "@/components/ui/icon-swap";
import { InputField, InputGroup } from "@/components/ui/input-group";
import { LoadingArea } from "@/components/ui/loading-indicator";
import {
  authConfigQueryKey,
  checkApiToken,
  clearApiToken,
  fetchAuthConfig,
  setApiToken,
} from "@/lib/api";
import { authClient, readAuthClientError } from "@/lib/auth-client";
import { AlertCircle, Eye, EyeOff, Github, KeyRound, RotateCcw } from "@/lib/icon-map";
import { loginReasonMessage, safeReturnPath } from "@/lib/login-return";
import { localTokenReturnPath, projectIdFromProjectPath } from "@/lib/routes";
import { spring } from "@/lib/springs";

const rejectedTokenMessage = "That token was rejected. Check the owner API token and try again.";

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
  const navigate = useNavigate();
  const search = useSearch({ from: "/login" });
  const returnTo = safeReturnPath(search.returnTo);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const authConfigQuery = useQuery({
    queryKey: authConfigQueryKey,
    queryFn: fetchAuthConfig,
    staleTime: 60_000,
  });
  const authMode = authConfigQuery.data?.mode;
  const shownError = error.length > 0 ? error : loginReasonMessage(search.reason, authMode);

  async function signInWithGithub(): Promise<void> {
    setIsChecking(true);
    setError("");
    clearApiToken();
    try {
      const returnUrl = new URL(returnTo, window.location.origin).href;
      const errorUrl = new URL("/login", window.location.origin);
      errorUrl.searchParams.set("reason", "unauthorized");
      errorUrl.searchParams.set("returnTo", returnTo);
      const result = await authClient.signIn.social({
        provider: "github",
        callbackURL: returnUrl,
        newUserCallbackURL: returnUrl,
        errorCallbackURL: errorUrl.href,
      });
      if (result.error !== null && result.error !== undefined) {
        throw result.error;
      }
    } catch (caughtError) {
      setError(readAuthClientError(caughtError, "GitHub sign-in could not start. Try again."));
      setIsChecking(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmedToken = token.trim();

    if (trimmedToken.length === 0) {
      setError("Enter the API token.");
      return;
    }

    setIsChecking(true);
    setError("");

    const targetProjectId = projectIdFromProjectPath(returnTo);
    try {
      await checkApiToken(trimmedToken, targetProjectId);
    } catch {
      setError(rejectedTokenMessage);
      setIsChecking(false);
      return;
    }

    setApiToken(trimmedToken);
    setIsChecking(false);
    void navigate({ href: localTokenReturnPath(returnTo), replace: true });
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
          ) : authConfigQuery.isError || authMode === "unavailable" ? (
            <Alert variant="destructive">
              <AlertCircle aria-hidden />
              <AlertTitle>Sign-in is not ready</AlertTitle>
              <AlertDescription>
                <p>
                  {authConfigQuery.isError
                    ? "Could not check the sign-in setup."
                    : "The hosted sign-in settings are incomplete."}
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
          ) : authMode === "github" ? (
            <div className="flex flex-col gap-3">
              <div>
                <h1 className="text-[16px] font-semibold">Sign in to your workspace</h1>
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
          ) : (
            <LocalTokenForm
              error={shownError}
              handleSubmit={handleSubmit}
              isChecking={isChecking}
              setError={setError}
              setShowToken={setShowToken}
              setToken={setToken}
              showToken={showToken}
              token={token}
            />
          )}
        </m.div>
      </m.section>
    </main>
  );
}

function LocalTokenForm({
  error,
  handleSubmit,
  isChecking,
  setError,
  setShowToken,
  setToken,
  showToken,
  token,
}: {
  error: string;
  handleSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  isChecking: boolean;
  setError: (value: string) => void;
  setShowToken: (updater: (value: boolean) => boolean) => void;
  setToken: (value: string) => void;
  showToken: boolean;
  token: string;
}) {
  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => void handleSubmit(event)}>
      <InputGroup className="w-full">
        <InputField
          autoComplete="current-password"
          disabled={isChecking}
          endContent={
            <button
              aria-label={showToken ? "Hide API token" : "Show API token"}
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-dim transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-amber"
              onClick={() => setShowToken((currentValue) => !currentValue)}
              type="button"
            >
              <IconSwap swapKey={showToken ? "hide" : "show"}>
                {showToken ? (
                  <EyeOff aria-hidden className="size-4" />
                ) : (
                  <Eye aria-hidden className="size-4" />
                )}
              </IconSwap>
            </button>
          }
          error={error}
          icon={KeyRound}
          index={0}
          label="API token"
          onChange={(nextToken) => {
            setToken(nextToken);
            setError("");
          }}
          placeholder="Owner API token"
          type={showToken ? "text" : "password"}
          value={token}
        />
      </InputGroup>

      <p className="-mt-2 text-[12px] text-muted-foreground">
        Use the owner API token for this Orange Replay project.
      </p>

      <Button className="w-full" loading={isChecking} type="submit">
        Continue
      </Button>
    </form>
  );
}
