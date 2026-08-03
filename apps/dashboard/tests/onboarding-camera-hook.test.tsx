// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vite-plus/test";
import { Select, SelectTrigger } from "../src/components/ui/select";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/**
 * The other half of the join described in `onboarding-camera-hook.test.ts`: the
 * activation camera's amber ring is a CSS rule on `[data-shell-switcher]`, so
 * the attribute `AppShell` sets has to survive `SelectTrigger`'s prop spread and
 * land on the real button. A design-system change that stopped forwarding
 * unknown props would take the highlight away as silently as the rename did.
 */
describe("the shell switcher carries its camera hook into the DOM", () => {
  it("renders the hook on the trigger button", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <Select value="alpha">
          <SelectTrigger data-shell-switcher="" placeholder="Workspace" />
        </Select>,
      );
    });

    expect(host.querySelector("button[data-shell-switcher]")).not.toBeNull();

    await act(async () => root.unmount());
    host.remove();
  });
});
