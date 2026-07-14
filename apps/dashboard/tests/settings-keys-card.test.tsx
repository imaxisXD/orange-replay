// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const apiMocks = vi.hoisted(() => ({
  createProjectKey: vi.fn(),
  fetchProjectKeys: vi.fn(),
  revokeProjectKey: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api")>();
  return { ...actual, ...apiMocks };
});

import { KeysCard } from "../src/routes/settings/settings-keys-card";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  apiMocks.createProjectKey.mockReset();
  apiMocks.fetchProjectKeys.mockReset();
  apiMocks.revokeProjectKey.mockReset();
  navigate.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.replaceChildren();
});

describe("write key settings", () => {
  it("creates a key and shows the secret once in a selectable read-only field", async () => {
    apiMocks.fetchProjectKeys.mockResolvedValue({ keys: [] });
    apiMocks.createProjectKey.mockResolvedValue({
      key: projectKey,
      secret: "or_live_one_time_secret",
    });
    await renderCard();

    expect(document.body.textContent).not.toContain("or_live_one_time_secret");
    const nameInput = container.querySelector<HTMLInputElement>('input[type="text"]');
    expect(nameInput).not.toBeNull();
    await act(async () => {
      setInputValue(nameInput!, "Production website");
    });

    await act(async () => {
      findButton("Create key").click();
    });
    await waitForUi(() =>
      expect(apiMocks.createProjectKey).toHaveBeenCalledWith("project_one", "Production website"),
    );

    const secretField = document.body.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="New write key secret"]',
    );
    expect(secretField).not.toBeNull();
    expect(secretField?.readOnly).toBe(true);
    expect(secretField?.value).toBe("or_live_one_time_secret");

    secretField?.focus();
    expect(secretField?.selectionStart).toBe(0);
    expect(secretField?.selectionEnd).toBe("or_live_one_time_secret".length);
  });

  it("asks for confirmation before revoking an active key", async () => {
    apiMocks.fetchProjectKeys.mockResolvedValue({ keys: [projectKey] });
    apiMocks.revokeProjectKey.mockResolvedValue({
      key: { ...projectKey, active: false, revokedAt: 2, revokedBy: "user_one" },
    });
    await renderCard();
    await waitForUi(() => expect(container.textContent).toContain("Production website"));

    await act(async () => {
      findButton("Revoke").click();
    });

    expect(apiMocks.revokeProjectKey).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Revoke Production website?");

    await act(async () => {
      findButton("Revoke key").click();
    });
    await waitForUi(() =>
      expect(apiMocks.revokeProjectKey).toHaveBeenCalledWith("project_one", "key_one"),
    );
  });
});

const projectKey = {
  id: "key_one",
  name: "Production website",
  active: true,
  createdAt: 1,
  createdBy: "user_one",
  revokedAt: null,
  revokedBy: null,
  keyHashPrefix: "abc123",
};

async function renderCard(): Promise<void> {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <KeysCard projectId="project_one" />
      </QueryClientProvider>,
    );
  });
  await waitForUi(() => expect(apiMocks.fetchProjectKeys).toHaveBeenCalled());
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

function setInputValue(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  if (descriptor?.set === undefined) throw new Error("The input value setter is unavailable.");
  // oxlint-disable-next-line typescript/unbound-method -- The platform setter needs this input as its receiver.
  Reflect.apply(descriptor.set, input, [value]);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
