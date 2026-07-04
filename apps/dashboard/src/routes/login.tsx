import { useEffect, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { Eye, EyeOff, KeyRound } from "lucide-react";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { InputField, InputGroup } from "@/components/ui/input-group";
import { checkApiToken, setApiToken } from "@/lib/api";

interface LoginState {
  returnTo?: string;
}

const rejectedTokenMessage = "That token was rejected. Check DEV_API_TOKEN and try again.";

export function LoginPage() {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as LoginState | null;
  const returnTo = state?.returnTo ?? "/projects/p1/sessions";

  useEffect(() => {
    const reason = new URLSearchParams(location.search).get("reason");
    if (reason === "unauthorized") {
      setError(rejectedTokenMessage);
    }
  }, [location.search]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmedToken = token.trim();

    if (trimmedToken.length === 0) {
      setError("Enter the API token.");
      return;
    }

    setIsChecking(true);
    setError("");

    try {
      await checkApiToken(trimmedToken);
      setApiToken(trimmedToken);
      void navigate(returnTo, { replace: true });
    } catch {
      setError(rejectedTokenMessage);
    } finally {
      setIsChecking(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <section className="lit flex w-full max-w-[400px] flex-col gap-6 overflow-hidden rounded-lg p-6">
        <div className="mt-4 flex items-center gap-[10px]">
          <BrandMark className="size-7" />
          <span className="text-[14px] font-medium">Orange Replay</span>
        </div>

        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <InputGroup className="w-full">
            <InputField
              autoComplete="current-password"
              disabled={isChecking}
              endContent={
                <button
                  aria-label={showToken ? "Hide API token" : "Show API token"}
                  className="flex size-7 shrink-0 items-center justify-center rounded-md text-dim transition-colors hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-amber"
                  onClick={() => setShowToken((currentValue) => !currentValue)}
                  type="button"
                >
                  {showToken ? (
                    <EyeOff aria-hidden className="size-4" />
                  ) : (
                    <Eye aria-hidden className="size-4" />
                  )}
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
              placeholder="DEV_API_TOKEN"
              type={showToken ? "text" : "password"}
              value={token}
            />
          </InputGroup>

          <p className="-mt-2 text-[12px] text-dim">
            Local dev: the DEV_API_TOKEN value from apps/worker/.dev.vars
          </p>

          <Button className="w-full" loading={isChecking} type="submit">
            Continue
          </Button>
        </form>
      </section>
    </main>
  );
}
