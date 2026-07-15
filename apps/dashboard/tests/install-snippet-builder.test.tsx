// @vitest-environment happy-dom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(Element.prototype, "getAnimations", {
  configurable: true,
  value: () => [],
});

const apiMocks = vi.hoisted(() => ({ fetchProjectKeys: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  fetchProjectKeys: apiMocks.fetchProjectKeys,
}));

import { matchesActiveProjectWriteKey } from "../src/routes/install/install-helpers";
import { InstallSnippetBuilder } from "../src/routes/install/install-snippet-builder";

const writeKey = `or_live_${"a".repeat(32)}`;
let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  apiMocks.fetchProjectKeys.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  document.body.replaceChildren();
});

describe("install write key verification", () => {
  it("matches only an active key with the same SHA-256 prefix", async () => {
    const prefix = await hashPrefix(writeKey);
    const activeKey = projectKey(prefix, true);

    await expect(matchesActiveProjectWriteKey(writeKey, [activeKey])).resolves.toBe(true);
    await expect(
      matchesActiveProjectWriteKey(writeKey, [{ ...activeKey, active: false }]),
    ).resolves.toBe(false);
    await expect(
      matchesActiveProjectWriteKey(`or_live_${"b".repeat(32)}`, [activeKey]),
    ).resolves.toBe(false);
  });

  it("enables copying for a matching project key and clears it on project switch", async () => {
    const prefix = await hashPrefix(writeKey);
    apiMocks.fetchProjectKeys.mockResolvedValue({ keys: [projectKey(prefix, true)] });
    await renderBuilder("project-one");

    const keyInput = container.querySelector<HTMLInputElement>('input[type="password"]');
    expect(keyInput).not.toBeNull();
    await setInputValue(keyInput!, writeKey);
    await vi.waitFor(() => {
      expect(findCopyButton().disabled).toBe(false);
    });

    await renderBuilder("project-two");
    await vi.waitFor(() => {
      expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("");
    });
    expect(findCopyButton().disabled).toBe(true);
  });

  it("keeps copying blocked for a generated key from another project", async () => {
    const otherPrefix = await hashPrefix(`or_live_${"b".repeat(32)}`);
    apiMocks.fetchProjectKeys.mockResolvedValue({ keys: [projectKey(otherPrefix, true)] });
    await renderBuilder("project-one");

    const keyInput = container.querySelector<HTMLInputElement>('input[type="password"]');
    await setInputValue(keyInput!, writeKey);
    await vi.waitFor(() => {
      expect(container.textContent).toContain("This key is not an active key for this project.");
    });
    expect(findCopyButton().disabled).toBe(true);
  });
});

async function renderBuilder(projectId: string): Promise<void> {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <InstallSnippetBuilder projectId={projectId} />
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => expect(apiMocks.fetchProjectKeys).toHaveBeenCalledWith(projectId));
}

async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
  const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  await act(async () => {
    valueDescriptor?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function findCopyButton(): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    'button[aria-label="Copy full snippet"]',
  );
  if (button === null) throw new Error("Copy button was not rendered.");
  return button;
}

function projectKey(keyHashPrefix: string, active: boolean) {
  return {
    id: "key-one",
    name: "Production",
    keyHashPrefix,
    active,
    createdAt: 1,
    createdBy: "user-one",
    revokedAt: active ? null : 2,
    revokedBy: active ? null : "user-one",
  };
}

async function hashPrefix(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}
