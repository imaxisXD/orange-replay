// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.assign(Element.prototype, { getAnimations: () => [] });

const apiMocks = vi.hoisted(() => ({
  fetchPublicPageSettings: vi.fn(),
  listSessions: vi.fn(),
  savePublicPageSettings: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api")>();
  return { ...actual, ...apiMocks };
});
vi.mock("@number-flow/react", () => ({
  default: ({ value }: { value: number }) => <span>{value}</span>,
  NumberFlowGroup: ({ children }: { children: ReactNode }) => children,
}));

import { PublicPageCard } from "../src/routes/settings/settings-public-page-card";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  apiMocks.fetchPublicPageSettings.mockReset();
  apiMocks.listSessions.mockReset();
  apiMocks.savePublicPageSettings.mockReset();
  apiMocks.fetchPublicPageSettings.mockImplementation(async () => privateSettings);
  apiMocks.listSessions.mockImplementation(async () => ({ sessions: [session], nextBefore: null }));
  apiMocks.savePublicPageSettings.mockImplementation(
    async (_projectId: string, update: { enabled: boolean; sessionIds: string[] }) => ({
      enabled: update.enabled,
      publicId: "pub_one",
      publicUrl: "https://public.example.com/p/pub_one",
      revision: 1,
      recordings: update.sessionIds.length === 0 ? [] : [selectedRecording],
    }),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.replaceChildren();
});

describe("public page settings", () => {
  it("asks for confirmation before publishing", async () => {
    await renderCard();

    await act(async () => findSwitch("Publish public page").click());
    expect(document.body.textContent).toContain("Publish this project page?");
    expect(apiMocks.savePublicPageSettings).not.toHaveBeenCalled();

    await act(async () => findButton("Publish page").click());
    await waitForUi(() =>
      expect(apiMocks.savePublicPageSettings).toHaveBeenCalledWith("project_one", {
        enabled: true,
        sessionIds: [],
      }),
    );
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Public page address"]')?.value,
    ).toBe("https://public.example.com/p/pub_one");
  });

  it("saves only the recordings chosen by the owner", async () => {
    await renderCard();

    await act(async () => findButton("Choose recordings").click());
    await waitForUi(() => {
      expect(apiMocks.listSessions).toHaveBeenCalled();
      expect(document.body.textContent).toContain("/checkout");
    });

    await act(async () => findSwitch("Share recording from").parentElement?.click());
    await waitForUi(() => expect(document.body.textContent).toContain("1/10 selected"));
    await act(async () => findButton("Save recordings").click());
    await waitForUi(() =>
      expect(apiMocks.savePublicPageSettings).toHaveBeenCalledWith("project_one", {
        enabled: false,
        sessionIds: ["session_one"],
      }),
    );
  });
});

const privateSettings = {
  enabled: false,
  publicId: null,
  publicUrl: null,
  revision: 0,
  recordings: [],
};

const session = {
  session_id: "session_one",
  project_id: "project_one",
  org_id: "org_one",
  started_at: 1_000,
  ended_at: 3_000,
  duration_ms: 2_000,
  country: "US",
  region: null,
  city: null,
  device: "desktop",
  browser: "Chrome",
  os: "macOS",
  entry_url: "https://example.com/checkout?email=private@example.com",
  url_count: 1,
  page_count: 1,
  analytics_version: 2,
  max_scroll_depth: 100,
  quick_backs: 0,
  interaction_time_ms: 1_000,
  activity_hist: null,
  clicks: 2,
  errors: 0,
  rages: 0,
  navs: 1,
  bytes: 100,
  segment_count: 1,
  flags: 0,
  manifest_key: "private/manifest.json",
  expires_at: 99_999,
};

const selectedRecording = {
  sessionId: "session_one",
  replayId: "replay_one",
  position: 0,
  startedAt: 1_000,
  durationMs: 2_000,
  entryPath: "/checkout",
  country: "US",
  device: "desktop",
  browser: "Chrome",
  operatingSystem: "macOS",
  clicks: 2,
  errors: 0,
  rages: 0,
  pages: 1,
};

async function renderCard(): Promise<void> {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <PublicPageCard projectId="project_one" />
      </QueryClientProvider>,
    );
  });
  await waitForUi(() => {
    expect(apiMocks.fetchPublicPageSettings).toHaveBeenCalled();
    expect(container.textContent).toContain("Choose recordings");
  });
}

async function waitForUi(assertion: () => void): Promise<void> {
  await vi.waitFor(async () => {
    await act(async () => Promise.resolve());
    assertion();
  });
}

function findButton(label: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  if (button === undefined) throw new Error(`Could not find the ${label} button.`);
  return button;
}

function findSwitch(label: string): HTMLButtonElement {
  const item = [...document.body.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find(
    (control) => {
      const labelId = control.getAttribute("aria-labelledby");
      const text = labelId === null ? "" : document.getElementById(labelId)?.textContent;
      return text?.includes(label) === true;
    },
  );
  if (item === undefined) throw new Error(`Could not find the ${label} switch.`);
  return item;
}
