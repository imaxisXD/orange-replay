// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { Button } from "../src/components/ui/button";
import { ShapeProvider } from "../src/lib/shape-context";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.replaceChildren();
});

describe("button in-flight and unavailable states", () => {
  it("gives a loading primary the card plate, a border, and a not-allowed cursor", async () => {
    const { button, plate, teardown } = await renderButton(<Button loading>Save</Button>);

    expect(button.disabled).toBe(true);
    expect(button.className).toContain("cursor-not-allowed");
    // Full strength while in flight: the indicator has to stay readable.
    expect(button.className).not.toContain("opacity-50");
    expect(button.className).not.toContain("pointer-events-none");
    expect(plate.className).toContain("bg-card");
    expect(plate.className).toContain("border-border");
    // The border sits on the plate, so the content box never jogs.
    expect(button.className).not.toContain("border-border");

    await teardown();
  });

  it("keeps an unavailable primary faded, unclickable, and on its own plate", async () => {
    const { button, plate, teardown } = await renderButton(<Button disabled>Save</Button>);

    expect(button.className).toContain("opacity-50");
    expect(button.className).toContain("pointer-events-none");
    expect(button.className).not.toContain("cursor-not-allowed");
    expect(plate.className).toContain("bg-foreground");
    expect(plate.className).not.toContain("border-border");

    await teardown();
  });

  it("lets unavailable win over loading, so the plate never implies the click landed", async () => {
    const { button, plate, teardown } = await renderButton(
      <Button disabled loading>
        Save
      </Button>,
    );

    expect(button.className).toContain("opacity-50");
    expect(button.className).toContain("pointer-events-none");
    expect(button.className).not.toContain("cursor-not-allowed");
    expect(plate.className).toContain("bg-foreground");

    await teardown();
  });

  it("presses the border, plate, and label together", async () => {
    const { button, plate, teardown } = await renderButton(<Button>Save</Button>);
    const content = [...button.children].find((child) => child !== plate);

    expect(button.className).toContain("active:scale-[0.96]");
    expect(button.className).toContain("duration-80");
    expect(button.className).toContain("transition-[color,transform]");
    expect(plate.className).not.toContain("group-active:scale-[0.96]");
    expect(content?.className).not.toContain("group-active:scale-[0.96]");

    await teardown();
  });

  it.each(["secondary", "tertiary"] as const)(
    "keeps the %s border on the same element that scales",
    async (variant) => {
      const { button, teardown } = await renderButton(<Button variant={variant}>Save</Button>);

      expect(button.className).toContain("border");
      expect(button.className).toContain("active:scale-[0.96]");

      await teardown();
    },
  );

  it("leaves the other variants' plates alone while loading", async () => {
    const { button, plate, teardown } = await renderButton(
      <Button loading variant="ghost">
        Save
      </Button>,
    );

    expect(button.className).toContain("cursor-not-allowed");
    expect(plate.className).toContain("bg-transparent");
    expect(plate.className).not.toContain("border-border");

    await teardown();
  });
});

async function renderButton(element: React.ReactElement): Promise<{
  button: HTMLButtonElement;
  plate: HTMLElement;
  root: Root;
  teardown: () => Promise<void>;
}> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(<ShapeProvider defaultShape="rounded">{element}</ShapeProvider>);
  });

  const button = container.querySelector("button");
  if (button === null) throw new Error("Could not find the rendered button");
  const plate = button.querySelector<HTMLElement>("span[aria-hidden]");
  if (plate === null) throw new Error("Could not find the button plate");

  return {
    button,
    plate,
    root,
    teardown: async () => {
      await act(async () => root.unmount());
    },
  };
}
