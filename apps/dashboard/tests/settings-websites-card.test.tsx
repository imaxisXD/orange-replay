// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.assign(Element.prototype, { getAnimations: () => [] });

const apiMocks = vi.hoisted(() => ({
  ensureProjectWebsite: vi.fn(),
  fetchProjectWebsites: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api")>();
  return { ...actual, ...apiMocks };
});

import { WebsitesCard } from "../src/routes/settings/settings-websites-card";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  apiMocks.ensureProjectWebsite.mockReset();
  apiMocks.fetchProjectWebsites.mockReset();
  navigate.mockReset();
  window.sessionStorage.clear();
  apiMocks.fetchProjectWebsites.mockResolvedValue({ websites });
});

afterEach(async () => {
  vi.useRealTimers();
  await act(async () => root.unmount());
  container.remove();
  document.body.replaceChildren();
});

describe("Website settings", () => {
  it("shows every Website with its favicon and resumes unfinished setup", async () => {
    await renderCard();

    expect(container.textContent).toContain("example.com");
    expect(container.textContent).toContain("Connected");
    expect(container.textContent).toContain("app.example.com");
    expect(container.textContent).toContain("Setup needed");
    expect(
      [...container.querySelectorAll<HTMLImageElement>('img[src*="/api/v1/favicon"]')].map(
        (image) => image.getAttribute("src"),
      ),
    ).toEqual([
      "/api/v1/favicon?website=https%3A%2F%2Fexample.com&v=3",
      "/api/v1/favicon?website=https%3A%2F%2Fapp.example.com&v=3",
    ]);

    await act(async () => findButton("Continue setup").click());
    expect(navigate).toHaveBeenCalledWith({
      to: "/onboarding/$projectId/website",
      params: { projectId: "project_one" },
      search: { website: "website_app" },
    });
  });

  it("validates after one quiet second and clears the error when corrected", async () => {
    await renderCard();
    vi.useFakeTimers();
    const input = websiteInput();

    await act(async () => setInputValue(input, "not a website"));
    await act(async () => vi.advanceTimersByTimeAsync(999));
    expect(container.textContent).not.toContain("Enter a website like");
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(container.textContent).toContain("Enter a website like");

    await act(async () => setInputValue(input, "ndle.app"));
    expect(container.textContent).not.toContain("Enter a website like");
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(container.querySelector('img[src*="https%3A%2F%2Fndle.app"]')).not.toBeNull();
  });

  it("hands a corrected Website to installation without creating another key on retry", async () => {
    apiMocks.ensureProjectWebsite.mockResolvedValue({
      website: {
        id: "website_ndle",
        name: "ndle.app",
        origin: "https://ndle.app",
        firstEventAt: null,
      },
      key: {
        id: "key_ndle",
        name: "ndle.app recorder",
        active: true,
        createdAt: 1,
        createdBy: "user_one",
        revokedAt: null,
        revokedBy: null,
        keyHashPrefix: "abc123",
      },
      secret: "or_live_ndle_secret",
      alreadyConnected: false,
    });
    await renderCard();
    const input = websiteInput();

    await act(async () => {
      setInputValue(input, "bad address");
      input.form?.requestSubmit();
    });
    expect(apiMocks.ensureProjectWebsite).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Enter a website like");

    await act(async () => {
      setInputValue(input, "  ndle.app  ");
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
    });
    await waitForUi(() =>
      expect(apiMocks.ensureProjectWebsite).toHaveBeenCalledWith(
        "project_one",
        "https://ndle.app/",
      ),
    );
    expect(apiMocks.ensureProjectWebsite).toHaveBeenCalledTimes(1);
    expect(
      window.sessionStorage.getItem(
        "orange-replay:onboarding-recorder-key:project_one:website_ndle",
      ),
    ).toBe("or_live_ndle_secret");
    expect(navigate).toHaveBeenCalledWith({
      to: "/onboarding/$projectId/install",
      params: { projectId: "project_one" },
      search: { website: "website_ndle" },
    });
  });
});

const websites = [
  {
    id: "website_main",
    name: "example.com",
    origin: "https://example.com",
    firstEventAt: 1,
  },
  {
    id: "website_app",
    name: "app.example.com",
    origin: "https://app.example.com",
    firstEventAt: null,
  },
];

async function renderCard(): Promise<void> {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <WebsitesCard projectId="project_one" />
      </QueryClientProvider>,
    );
  });
  await waitForUi(() => expect(apiMocks.fetchProjectWebsites).toHaveBeenCalledWith("project_one"));
  await waitForUi(() => expect(container.textContent).toContain("Add another website"));
}

function websiteInput(): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="text"]');
  if (input === null) throw new Error("Website URL input not found.");
  return input;
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
  // oxlint-disable-next-line typescript/unbound-method -- The browser setter needs this input as its receiver.
  Reflect.apply(descriptor.set, input, [value]);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function waitForUi(assertion: () => void): Promise<void> {
  await vi.waitFor(async () => {
    await act(async () => Promise.resolve());
    assertion();
  });
}
