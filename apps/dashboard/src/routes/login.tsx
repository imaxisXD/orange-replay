import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InputField, InputGroup } from "@/components/ui/input-group";
import { setApiToken } from "@/lib/api";

interface LoginState {
  returnTo?: string;
}

export function LoginPage() {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as LoginState | null;
  const returnTo = state?.returnTo ?? "/projects/p1/sessions";

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmedToken = token.trim();

    if (trimmedToken.length === 0) {
      setError("Enter the API token.");
      return;
    }

    setApiToken(trimmedToken);
    void navigate(returnTo, { replace: true });
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <section className="flex w-full max-w-sm flex-col gap-6 rounded-lg border border-border bg-card p-6 shadow-surface-2">
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">Orange Replay</p>
          <h1 className="text-2xl font-semibold tracking-normal">Dashboard login</h1>
          <p className="text-sm leading-6 text-muted-foreground">
            Use the local worker dev token for this build.
          </p>
        </div>

        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <InputGroup className="w-full">
            <InputField
              autoComplete="current-password"
              error={error}
              icon={Lock}
              index={0}
              label="API token"
              onChange={(nextToken) => {
                setToken(nextToken);
                setError("");
              }}
              placeholder="or_dev_token"
              type="password"
              value={token}
            />
          </InputGroup>

          <Button leadingIcon={Lock} type="submit">
            Continue
          </Button>
        </form>
      </section>
    </main>
  );
}
