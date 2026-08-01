// @vitest-environment happy-dom

import { describe, expect, it } from "vite-plus/test";
import { watchReplayCursorPosition } from "../src/player/replay-cursor-visibility.ts";

describe("replay cursor visibility", () => {
  it("shows immediately when the replay already has a complete position", () => {
    const wrapper = document.createElement("div");
    const cursor = document.createElement("div");
    cursor.className = "replayer-mouse";
    cursor.style.left = "40px";
    cursor.style.top = "60px";
    wrapper.append(cursor);

    const visibility = watchReplayCursorPosition(wrapper);
    expect(cursor.hasAttribute("data-orange-replay-positioned")).toBe(true);

    visibility.stop();
  });

  it("waits for a complete recorded position and hides again when reset", async () => {
    const wrapper = document.createElement("div");
    const cursor = document.createElement("div");
    cursor.className = "replayer-mouse";
    wrapper.append(cursor);

    const visibility = watchReplayCursorPosition(wrapper);
    expect(cursor.hasAttribute("data-orange-replay-positioned")).toBe(false);

    cursor.style.left = "120px";
    await nextMutation();
    expect(cursor.hasAttribute("data-orange-replay-positioned")).toBe(false);

    cursor.style.top = "80px";
    await nextMutation();
    expect(cursor.hasAttribute("data-orange-replay-positioned")).toBe(true);

    visibility.reset();
    expect(cursor.style.left).toBe("");
    expect(cursor.style.top).toBe("");
    expect(cursor.hasAttribute("data-orange-replay-positioned")).toBe(false);

    visibility.stop();
  });
});

async function nextMutation(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
