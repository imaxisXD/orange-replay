// @vitest-environment happy-dom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";
import { OrangeToastProvider, useOrangeToast } from "../src/components/ui/orange-toast";

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

describe("Orange Replay toast", () => {
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
    expect(toasts).toHaveLength(4);
    expect(document.querySelectorAll("[data-testid='orange-toast'][data-limited]")).toHaveLength(1);
    expect(
      document.querySelectorAll("[data-testid='orange-toast']:not([data-limited])"),
    ).toHaveLength(3);
    expect(document.querySelectorAll("[data-toast-particle]")).toHaveLength(4);
    expect(
      document.querySelectorAll(
        "[data-testid='orange-toast']:not([data-front]) [data-toast-particle]",
      ),
    ).toHaveLength(0);

    root.unmount();
    container.remove();
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
