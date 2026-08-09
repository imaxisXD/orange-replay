// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ProjectSettingsDraft } from "../src/lib/project-settings";
import { CaptureCard } from "../src/routes/settings/settings-cards";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("capture settings", () => {
  it("shows the replay styling boundary and toggles the saved draft", async () => {
    const updateDraft = vi.fn();
    await act(async () => {
      root.render(
        <CaptureCard
          capture={{ heatmaps: false, console: false, network: false, canvas: false }}
          error=""
          onToggle={() => undefined}
          replayAssets
          retentionDays={30}
          sampleRate={1}
          updateDraft={updateDraft}
        />,
      );
    });

    expect(container.textContent).toContain("Preserve replay styling");
    expect(container.textContent).toContain(
      "Privately cache public styles, fonts, and background images after recording.",
    );
    const control = container.querySelector<HTMLElement>('[role="switch"]');
    expect(control?.getAttribute("aria-checked")).toBe("true");

    await act(async () => control?.click());

    const updater = updateDraft.mock.calls[0]?.[0] as
      | ((draft: ProjectSettingsDraft) => ProjectSettingsDraft)
      | undefined;
    expect(updater?.(draft()).replayAssets).toBe(false);
  });
});

function draft(): ProjectSettingsDraft {
  return {
    sampleRate: 1,
    retentionDays: 30,
    allowedOrigins: ["*"],
    maskPolicyVersion: 1,
    maskRules: [],
    capture: { heatmaps: false, console: false, network: false, canvas: false },
    replayAssets: true,
  };
}
