// @vitest-environment happy-dom
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { AccountProjectRole, AccountResponse } from "@orange-replay/shared";
import { clearDashboardAccess } from "../src/lib/dashboard-access";
import { LiveSubdomainPrompt } from "../src/routes/live-subdomain-prompt";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const navigate = vi.fn();
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));

const mountedRoots: Root[] = [];

describe("live subdomain prompt", () => {
  afterEach(async () => {
    for (const root of mountedRoots.splice(0)) {
      await act(async () => root.unmount());
    }
    vi.unstubAllGlobals();
    navigate.mockReset();
    clearDashboardAccess();
    window.localStorage.clear();
    document.body.replaceChildren();
  });

  it("points the snippet at the app subdomain once one website is connected", async () => {
    const { container, teardown } = await renderPrompt({
      websites: [connectedWebsite("https://acme.com")],
    });
    await settleUntil(() => container.textContent?.includes("Record the next subdomain") === true);

    expect(container.textContent).toContain("Record the next subdomain");
    expect(container.textContent).toContain("continue to app.acme.com");
    expect(container.textContent).toContain("add it as another website");
    expect(container.textContent).toContain("Both websites stay in the same visitor journey");

    findButton(container, "Add website").click();
    expect(navigate).toHaveBeenCalledWith({
      to: "/onboarding/$projectId/website",
      params: { projectId: "project-1" },
      search: { draft: "https://app.acme.com" },
    });
    await teardown();
  });

  it("suggests the bare domain when any subdomain came first", async () => {
    const { container, teardown } = await renderPrompt({
      websites: [connectedWebsite("https://dashboard.acme.com")],
    });
    await settleUntil(() => container.textContent?.includes("Record the next subdomain") === true);

    expect(container.textContent).toContain("continue to acme.com");
    expect(container.textContent).not.toContain("app.dashboard.acme.com");
    await teardown();
  });

  it("dismisses per project and stays dismissed", async () => {
    const first = await renderPrompt({ websites: [connectedWebsite("https://acme.com")] });
    await settleUntil(
      () => first.container.textContent?.includes("Record the next subdomain") === true,
    );

    await act(async () => {
      findButton(first.container, "Dismiss").click();
    });
    expect(first.container.textContent).not.toContain("Record the next subdomain");
    await first.teardown();

    const second = await renderPrompt({ websites: [connectedWebsite("https://acme.com")] });
    await settle();
    expect(second.container.textContent).not.toContain("Record the next subdomain");
    // The dismissed prompt never re-asks for the website list.
    expect(requestedUrls(second.fetchMock).some((url) => url.includes("/websites"))).toBe(false);
    await second.teardown();
  });

  it("reads dismissal separately when the route switches projects", async () => {
    const prompt = await renderPrompt({ websites: [connectedWebsite("https://acme.com")] });
    await settleUntil(
      () => prompt.container.textContent?.includes("Record the next subdomain") === true,
    );

    await act(async () => findButton(prompt.container, "Dismiss").click());
    expect(prompt.container.textContent).not.toContain("Record the next subdomain");

    await prompt.rerenderProject("project-2");
    await settleUntil(
      () => prompt.container.textContent?.includes("Record the next subdomain") === true,
    );
    expect(prompt.container.textContent).toContain("continue to app.acme.com");
    await prompt.teardown();
  });

  it("stays quiet before connection, after a second website, and for members", async () => {
    const pending = await renderPrompt({
      websites: [
        { id: "site-1", name: "acme.com", origin: "https://acme.com", firstEventAt: null },
      ],
    });
    await settle();
    expect(pending.container.textContent ?? "").toBe("");
    await pending.teardown();

    const covered = await renderPrompt({
      websites: [connectedWebsite("https://acme.com"), connectedWebsite("https://app.acme.com")],
    });
    await settle();
    expect(covered.container.textContent ?? "").toBe("");
    await covered.teardown();

    const member = await renderPrompt({
      role: "member",
      websites: [connectedWebsite("https://acme.com")],
    });
    await settle();
    expect(member.container.textContent ?? "").toBe("");
    // Members cannot reach the manager-gated website list; never request it.
    expect(requestedUrls(member.fetchMock).some((url) => url.includes("/websites"))).toBe(false);
    await member.teardown();
  });

  it("stays quiet when the saved Website cannot share the HTTPS journey domain", async () => {
    const insecure = await renderPrompt({
      websites: [connectedWebsite("http://acme.com")],
    });
    await settle();
    expect(insecure.container.textContent ?? "").toBe("");
    await insecure.teardown();

    const unrelated = await renderPrompt({
      websites: [connectedWebsite("https://other.com")],
    });
    await settle();
    expect(unrelated.container.textContent ?? "").toBe("");
    await unrelated.teardown();
  });
});

async function renderPrompt(options: {
  role?: AccountProjectRole;
  websites: { id: string; name: string; origin: string; firstEventAt: number | null }[];
}): Promise<{
  container: HTMLElement;
  fetchMock: ReturnType<typeof vi.fn>;
  rerenderProject: (projectId: string) => Promise<void>;
  teardown: () => Promise<void>;
}> {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url.includes("/account")) return jsonResponse(account(options.role ?? "owner"));
    if (url.includes("/websites")) return jsonResponse({ websites: options.websites });
    throw new Error(`Unexpected dashboard request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mountedRoots.push(root);

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <LiveSubdomainPrompt projectId="project-1" />
      </QueryClientProvider>,
    );
  });

  return {
    container,
    fetchMock,
    rerenderProject: async (nextProjectId) => {
      await act(async () => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <LiveSubdomainPrompt projectId={nextProjectId} />
          </QueryClientProvider>,
        );
      });
    },
    teardown: async () => {
      const index = mountedRoots.indexOf(root);
      if (index !== -1) mountedRoots.splice(index, 1);
      await act(async () => root.unmount());
      queryClient.clear();
    },
  };
}

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function settleUntil(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  throw new Error("Timed out waiting for the subdomain prompt to settle");
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (button === undefined) throw new Error(`No button labelled ${label}.`);
  return button;
}

function connectedWebsite(origin: string) {
  return {
    id: `site-${origin}`,
    name: new URL(origin).hostname,
    origin,
    firstEventAt: 1_700_000_000_000,
  };
}

function requestedUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map((call) => requestUrl(call[0] as string | URL | Request));
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function account(role: AccountProjectRole): AccountResponse {
  return {
    user: {
      id: "user-1",
      name: "Test User",
      email: "test@example.com",
      emailVerified: true,
      image: null,
      role: "user",
    },
    workspaces: [
      {
        id: "workspace-1",
        name: "Workspace",
        slug: "workspace",
        role,
        projects: [
          { id: "project-1", name: "Project", role, journeyDomain: "acme.com" },
          { id: "project-2", name: "Project 2", role, journeyDomain: "acme.com" },
        ],
      },
    ],
    activeWorkspaceId: "workspace-1",
    isAdmin: false,
  };
}
