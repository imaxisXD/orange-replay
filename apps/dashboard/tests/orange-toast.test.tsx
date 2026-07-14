// @vitest-environment happy-dom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  OrangeToastPreview,
  OrangeToastProvider,
  type OrangeToastVariant,
  useOrangeToast,
} from "../src/components/ui/orange-toast";

function ToastTestButton() {
  const toastManager = useOrangeToast();

  return (
    <button
      onClick={() =>
        toastManager.add({
          title: "Your session is live!",
          actionProps: { children: "View Session" },
        })
      }
      type="button"
    >
      Show session toast
    </button>
  );
}

function ErrorToastTestButton() {
  const toastManager = useOrangeToast();

  return (
    <button
      onClick={() =>
        toastManager.add({
          title: "Could not load this replay",
          type: "error",
          priority: "high",
        })
      }
      type="button"
    >
      Show error toast
    </button>
  );
}

function UpdatingToastTestButton() {
  const toastManager = useOrangeToast();

  return (
    <button
      onClick={() => {
        const toastId = toastManager.add({
          title: "Preparing replay export…",
          type: "loading",
        });

        window.setTimeout(() => {
          toastManager.update(toastId, {
            title: "Replay export is ready",
            type: "success",
          });
        }, 100);
      }}
      type="button"
    >
      Prepare export
    </button>
  );
}

describe("Orange Replay toast", () => {
  it("keeps all static toast previews mounted without fake controls", () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const variants: OrangeToastVariant[] = [
      "default",
      "success",
      "error",
      "warning",
      "info",
      "loading",
    ];

    flushSync(() =>
      root.render(
        <>
          {variants.map((variant) => (
            <OrangeToastPreview
              actionLabel={variant === "success" ? "View Session" : undefined}
              key={variant}
              title={`${variant} message`}
              variant={variant}
            />
          ))}
        </>,
      ),
    );

    const previews = container.querySelectorAll<HTMLElement>(
      "[data-testid='orange-toast-preview']",
    );
    expect(previews).toHaveLength(6);
    expect([...previews].map((preview) => preview.dataset.variant)).toEqual(variants);
    for (const preview of previews) {
      expect(preview.querySelectorAll("[data-toast-particle]")).toHaveLength(4);
      expect(preview.querySelector("button")).toBeNull();
    }

    flushSync(() => vi.advanceTimersByTime(20_000));
    expect(container.querySelectorAll("[data-testid='orange-toast-preview']")).toHaveLength(6);

    root.unmount();
    container.remove();
    vi.useRealTimers();
  });

  it("portals an actionable toast with four celebration layers", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    flushSync(() =>
      root.render(
        <OrangeToastProvider>
          <ToastTestButton />
        </OrangeToastProvider>,
      ),
    );

    const trigger = container.querySelector("button");
    expect(trigger).not.toBeNull();
    flushSync(() => trigger?.click());

    const toast = document.querySelector<HTMLElement>("[data-testid='orange-toast']");
    expect(toast).not.toBeNull();
    expect(container.contains(toast)).toBe(false);
    expect(toast?.textContent).toContain("Your session is live!");
    expect(toast?.textContent).toContain("View Session");
    expect(toast?.querySelectorAll("[data-toast-particle]")).toHaveLength(4);

    root.unmount();
    container.remove();
  });

  it("renders semantic variants with a visible signal and dismiss action", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    flushSync(() =>
      root.render(
        <OrangeToastProvider>
          <ErrorToastTestButton />
        </OrangeToastProvider>,
      ),
    );

    const trigger = container.querySelector("button");
    flushSync(() => trigger?.click());

    const toast = document.querySelector<HTMLElement>("[data-testid='orange-toast']");
    expect(toast?.dataset.variant).toBe("error");
    expect(toast?.querySelector("[data-toast-signal]")).not.toBeNull();
    const particleAssets = [...(toast?.querySelectorAll("[data-toast-particle]") ?? [])].map(
      (particle) => particle.getAttribute("data-toast-particle-asset"),
    );
    expect(particleAssets).toEqual([
      "/visuals/orange-replay-toast-logo-particles-b.png",
      "/visuals/orange-replay-toast-logo-particles-b.png",
      "/visuals/orange-replay-toast-particles-error.png",
      "/visuals/orange-replay-toast-particles-error.png",
    ]);
    expect(toast?.querySelector("button[aria-label='Dismiss notification']")).not.toBeNull();

    root.unmount();
    container.remove();
  });

  it("uses Base UI's default three-toast stack when the trigger is spammed", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    flushSync(() =>
      root.render(
        <OrangeToastProvider>
          <ToastTestButton />
        </OrangeToastProvider>,
      ),
    );

    const trigger = container.querySelector("button");
    expect(trigger).not.toBeNull();
    flushSync(() => {
      trigger?.click();
      trigger?.click();
      trigger?.click();
      trigger?.click();
    });

    const toasts = document.querySelectorAll<HTMLElement>("[data-testid='orange-toast']");
    const visibleToasts = document.querySelectorAll<HTMLElement>(
      "[data-testid='orange-toast']:not([data-limited])",
    );
    expect(toasts).toHaveLength(4);
    expect(document.querySelectorAll("[data-testid='orange-toast'][data-limited]")).toHaveLength(1);
    expect(visibleToasts).toHaveLength(3);
    expect(
      [...visibleToasts].map((toast) => toast.style.getPropertyValue("--toast-index")),
    ).toEqual(["0", "1", "2"]);
    expect(visibleToasts[0]?.querySelector("[data-behind]")).toBeNull();
    expect(visibleToasts[1]?.querySelector("[data-behind]")).not.toBeNull();
    expect(visibleToasts[2]?.querySelector("[data-behind]")).not.toBeNull();
    expect(document.querySelectorAll("[data-toast-particle]")).toHaveLength(4);
    expect(
      document.querySelectorAll(
        "[data-testid='orange-toast']:not([data-front]) [data-toast-particle]",
      ),
    ).toHaveLength(0);

    root.unmount();
    container.remove();
  });

  it("animates the same updated toast from loading to ready", () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    flushSync(() =>
      root.render(
        <OrangeToastProvider>
          <UpdatingToastTestButton />
        </OrangeToastProvider>,
      ),
    );

    const trigger = container.querySelector("button");
    flushSync(() => trigger?.click());

    const toast = document.querySelector<HTMLElement>("[data-testid='orange-toast']");
    const firstParticle = toast?.querySelector("[data-toast-particle]");
    expect(toast?.dataset.variant).toBe("loading");
    expect(toast?.dataset.visualStage).toBe("0");
    expect(toast?.textContent).toContain("Preparing replay export…");
    expect(toast?.querySelector("[data-toast-icon-swap]")?.getAttribute("data-state")).toBe("a");

    flushSync(() => vi.advanceTimersByTime(100));

    expect(document.querySelector("[data-testid='orange-toast']")).toBe(toast);
    expect(toast?.dataset.variant).toBe("loading");
    expect(toast?.dataset.visualStage).toBe("1");
    expect(toast?.textContent).toContain("Preparing replay export…");
    expect(toast?.querySelector(".is-exit")).not.toBeNull();

    flushSync(() => vi.advanceTimersByTime(150));

    expect(toast?.dataset.variant).toBe("success");
    expect(toast?.dataset.visualStage).toBe("2");
    expect(toast?.textContent).toContain("Replay export is ready");
    expect(toast?.querySelector(".is-enter-start")).not.toBeNull();
    expect(toast?.querySelector("[data-toast-icon-swap]")?.getAttribute("data-state")).toBe("b");
    expect(toast?.querySelector("[data-icon='a']")?.getAttribute("data-toast-signal-variant")).toBe(
      "loading",
    );
    expect(toast?.querySelector("[data-icon='b']")?.getAttribute("data-toast-signal-variant")).toBe(
      "success",
    );
    expect(toast?.querySelector("[data-toast-particle]")).not.toBe(firstParticle);
    expect(
      [...(toast?.querySelectorAll("[data-toast-particle]") ?? [])].map((particle) =>
        particle.getAttribute("data-toast-particle-asset"),
      ),
    ).toEqual([
      "/visuals/orange-replay-toast-logo-particles-b.png",
      "/visuals/orange-replay-toast-logo-particles-b.png",
      "/visuals/orange-replay-toast-particles-success.png",
      "/visuals/orange-replay-toast-particles-success.png",
    ]);

    flushSync(() => vi.advanceTimersByTime(16));
    expect(toast?.dataset.visualStage).toBe("3");
    expect(toast?.querySelector(".is-enter-start")).toBeNull();

    flushSync(() => vi.advanceTimersByTime(234));
    expect(toast?.dataset.visualStage).toBe("0");

    root.unmount();
    container.remove();
    vi.useRealTimers();
  });

  it("starts dismissing an ordinary toast after Base UI's default five seconds", () => {
    vi.useFakeTimers();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    flushSync(() =>
      root.render(
        <OrangeToastProvider>
          <ToastTestButton />
        </OrangeToastProvider>,
      ),
    );

    const trigger = container.querySelector("button");
    flushSync(() => trigger?.click());
    const toast = document.querySelector<HTMLElement>("[data-testid='orange-toast']");
    expect(toast?.hasAttribute("data-ending-style")).toBe(false);

    flushSync(() => vi.advanceTimersByTime(4_999));
    expect(toast?.hasAttribute("data-ending-style")).toBe(false);
    flushSync(() => vi.advanceTimersByTime(1));
    expect(toast?.hasAttribute("data-ending-style")).toBe(true);

    root.unmount();
    container.remove();
    vi.useRealTimers();
  });
});
