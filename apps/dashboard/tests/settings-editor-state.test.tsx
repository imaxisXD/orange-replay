// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { StoredProjectConfig } from "@orange-replay/shared/types";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const apiMocks = vi.hoisted(() => ({
  fetchProjectConfig: vi.fn(),
  saveProjectConfig: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  ...apiMocks,
}));

import { useProjectSettingsEditor } from "../src/routes/settings/settings-editor-state";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  apiMocks.fetchProjectConfig.mockReset();
  apiMocks.saveProjectConfig.mockReset();
  apiMocks.fetchProjectConfig.mockResolvedValue(config);
  apiMocks.saveProjectConfig.mockResolvedValue({ ...config, version: 2 });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("project settings editor validation", () => {
  it("blocks a malformed draft, shows the field error, and retries with a normalized payload", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Harness />
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(container.textContent).toContain("ready"));

    await click("Make invalid");
    await click("Save");
    expect(apiMocks.saveProjectConfig).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Enter * or a valid http:// or https:// origin.");

    await click("Correct");
    await click("Save");
    await vi.waitFor(() =>
      expect(apiMocks.saveProjectConfig).toHaveBeenCalledWith("project_one", {
        expectedVersion: 1,
        sampleRate: 0.25,
        retentionDays: 30,
        allowedOrigins: ["https://app.example.com"],
        maskPolicyVersion: 1,
        maskRules: [{ selector: ".private", action: "mask" }],
        capture: config.capture,
      }),
    );
  });
});

function Harness() {
  const editor = useProjectSettingsEditor("project_one");
  if (editor.state.draft === null) return <p>loading</p>;
  return (
    <div>
      <p>ready</p>
      <p>{editor.state.validationErrors.origins}</p>
      <button
        onClick={() =>
          editor.actions.updateDraft((draft) => ({
            ...draft,
            allowedOrigins: ["https://app.example.com/path"],
          }))
        }
        type="button"
      >
        Make invalid
      </button>
      <button
        onClick={() =>
          editor.actions.updateDraft((draft) => ({
            ...draft,
            allowedOrigins: [" https://app.example.com/ "],
            maskRules: draft.maskRules.map((rule) => ({ ...rule, selector: "  .private  " })),
          }))
        }
        type="button"
      >
        Correct
      </button>
      <button onClick={editor.actions.saveChanges} type="button">
        Save
      </button>
    </div>
  );
}

async function click(label: string): Promise<void> {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );
  if (button === undefined) throw new Error(`Could not find ${label}.`);
  await act(async () => button.click());
}

const config: StoredProjectConfig = {
  projectId: "project_one",
  orgId: "org_one",
  shard: 0,
  active: true,
  sampleRate: 0.25,
  retentionDays: 30,
  allowedOrigins: ["*"],
  maskPolicyVersion: 1,
  maskRules: [{ selector: ".saved", action: "mask" }],
  capture: { heatmaps: false, console: false, network: true, canvas: false },
  quotaState: "ok",
  version: 1,
};
