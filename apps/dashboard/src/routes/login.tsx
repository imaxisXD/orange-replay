import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { motion } from "framer-motion";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import { IconSwap } from "@/components/ui/icon-swap";
import { InputField, InputGroup } from "@/components/ui/input-group";
import { checkApiToken, setApiToken } from "@/lib/api";
import { Eye, EyeOff, KeyRound } from "@/lib/icon-map";
import { safeReturnPath } from "@/lib/login-return";
import { projectIdFromProjectPath } from "@/lib/routes";
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
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const navigate = useNavigate();
  const search = useSearch({ from: "/login" });
  const returnTo = safeReturnPath(search.returnTo);

  useEffect(() => {
    if (search.reason === "unauthorized") {
      setError(rejectedTokenMessage);
    }
  }, [search.reason]);

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
      await checkApiToken(trimmedToken, projectIdFromProjectPath(returnTo));
      setApiToken(trimmedToken);
      void navigate({ href: returnTo, replace: true });
    } catch {
      setError(rejectedTokenMessage);
    } finally {
      setIsChecking(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <motion.section
        animate="show"
        className="lit flex w-full max-w-100 flex-col gap-6 overflow-hidden rounded-lg p-6"
        initial="hidden"
        variants={cardEnter}
      >
        <motion.div className="mt-4 flex items-center gap-2.5" variants={cardChild}>
          <BrandMark className="size-7" />
          <span className="text-[14px] font-medium">Orange Replay</span>
        </motion.div>

        <motion.form className="flex flex-col gap-4" onSubmit={handleSubmit} variants={cardChild}>
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

          <p className="-mt-2 text-[12px] text-dim">
            Use the owner API token for this Orange Replay project.
          </p>

          <Button className="w-full" loading={isChecking} type="submit">
            Continue
          </Button>
        </motion.form>
      </motion.section>
    </main>
  );
}
