import { Button } from "@/components/ui/button";
import { useOrangeToast, type OrangeToastVariant } from "@/components/ui/orange-toast";
import { useDashboardWorkspace } from "@/lib/dashboard-workspace";
import { useNavigate } from "@tanstack/react-router";

interface ToastExample {
  description: string;
  label: string;
  signalClassName: string;
  title: string;
  variant: OrangeToastVariant;
}

const toastExamples: ToastExample[] = [
  {
    variant: "default",
    label: "Default",
    title: "Session note saved",
    description: "Quiet confirmation for ordinary product feedback.",
    signalClassName: "bg-foreground/70",
  },
  {
    variant: "success",
    label: "Success",
    title: "Your session is live!",
    description: "A completed action with an optional next step.",
    signalClassName: "bg-success",
  },
  {
    variant: "error",
    label: "Error",
    title: "Could not load this replay",
    description: "A failed action with a useful recovery path.",
    signalClassName: "bg-danger",
  },
  {
    variant: "warning",
    label: "Warning",
    title: "Storage is almost full",
    description: "Important attention without treating it as failure.",
    signalClassName: "bg-amber",
  },
  {
    variant: "info",
    label: "Info",
    title: "A newer session is available",
    description: "Helpful context that does not interrupt the task.",
    signalClassName: "bg-player-blue",
  },
  {
    variant: "loading",
    label: "Loading",
    title: "Preparing replay export…",
    description: "A persistent task state that resolves into success.",
    signalClassName: "bg-teal",
  },
];

export function ToastLabPage() {
  const toastManager = useOrangeToast();
  const navigate = useNavigate();
  const { projectId } = useDashboardWorkspace();

  function showLoadingToast(): void {
    const exportReady = new Promise<void>((resolve) => window.setTimeout(resolve, 1_600));

    void toastManager.promise(exportReady, {
      loading: { title: "Preparing replay export…", type: "loading" },
      success: { title: "Replay export is ready", type: "success" },
      error: { title: "Could not prepare the export", type: "error", priority: "high" },
    });
  }

  function showMixedStack(): void {
    toastManager.add({
      title: "A newer session is available",
      type: "info",
    });
    toastManager.add({
      title: "Storage is almost full",
      type: "warning",
    });
    toastManager.add({
      title: "Could not load this replay",
      type: "error",
      priority: "high",
    });
  }

  function showToast(example: ToastExample): void {
    if (example.variant === "loading") {
      showLoadingToast();
      return;
    }

    let toastId = "";
    const actionProps =
      example.variant === "success"
        ? {
            children: "View Session",
            onClick: () => {
              toastManager.close(toastId);
              void navigate({
                to: "/projects/$projectId/sessions",
                params: { projectId },
              });
            },
          }
        : example.variant === "error"
          ? {
              children: "Try Again",
              onClick: () => {
                toastManager.close(toastId);
                showLoadingToast();
              },
            }
          : undefined;

    toastId = toastManager.add({
      title: example.title,
      type: example.variant,
      priority: example.variant === "error" ? "high" : "low",
      actionProps,
    });
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex max-w-2xl flex-col gap-1.5">
        <h1 className="text-[18px] font-semibold tracking-[-0.015em]">Toast lab</h1>
        <p className="text-[13px] text-muted-foreground">
          Test every notification state with the same Orange Replay structure, logo fragments, and
          measured motion.
        </p>
      </header>

      <section className="lit overflow-hidden rounded-lg">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-[13px] font-semibold text-foreground">Notification variants</h2>
            <p className="mt-1 max-w-2xl text-[13px] text-muted-foreground">
              Semantic color is limited to the signal cell and dashed edge. The surface, typography,
              action shape, and particle language stay consistent.
            </p>
          </div>
          <Button onClick={showMixedStack} size="sm" type="button" variant="secondary">
            Show mixed stack
          </Button>
        </div>
        <ul className="divide-y divide-border">
          {toastExamples.map((example) => (
            <li
              className="flex min-h-18 flex-wrap items-center justify-between gap-4 px-5 py-3.5"
              key={example.variant}
            >
              <div className="flex min-w-0 items-start gap-3">
                <span
                  aria-hidden
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-[2px] ${example.signalClassName}`}
                />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="w-16 font-mono text-[11px] text-muted-foreground">
                      {example.label}
                    </span>
                    <span className="text-[13px] font-medium text-foreground">{example.title}</span>
                  </div>
                  <p className="mt-1 text-[12px] text-muted-foreground">{example.description}</p>
                </div>
              </div>
              <Button
                onClick={() => showToast(example)}
                size="sm"
                type="button"
                variant="secondary"
              >
                Show
              </Button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
