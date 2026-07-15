// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const apiMocks = vi.hoisted(() => ({
  fetchAccount: vi.fn(),
  fetchAdminStats: vi.fn(),
  fetchAdminUsers: vi.fn(),
}));
const adminMocks = vi.hoisted(() => ({
  banUser: vi.fn(),
  revokeUserSessions: vi.fn(),
  setRole: vi.fn(),
  signOut: vi.fn(),
  unbanUser: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children?: ReactNode }) => <a href="/projects">{children}</a>,
  useNavigate: () => navigate,
}));
vi.mock("@number-flow/react", () => ({
  default: ({ value }: { value: number }) => <span>{value.toLocaleString()}</span>,
  NumberFlowGroup: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/api")>();
  return { ...actual, ...apiMocks };
});
vi.mock("@/lib/admin-auth-client", () => ({
  adminAuthClient: {
    admin: {
      banUser: adminMocks.banUser,
      revokeUserSessions: adminMocks.revokeUserSessions,
      setRole: adminMocks.setRole,
      unbanUser: adminMocks.unbanUser,
    },
    signOut: adminMocks.signOut,
  },
}));

import { AdminPage } from "../src/routes/admin";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  for (const mock of Object.values({ ...apiMocks, ...adminMocks, navigate })) mock.mockReset();

  apiMocks.fetchAccount.mockResolvedValue({
    user: {
      id: "user_self",
      name: "Sunny",
      email: "sunny@example.com",
      emailVerified: true,
      image: null,
      role: "admin",
    },
    workspaces: [],
    isAdmin: true,
  });
  apiMocks.fetchAdminStats.mockResolvedValue({
    users: 2,
    newUsers: 1,
    workspaces: 1,
    projects: 1,
    activeKeys: 1,
  });
  apiMocks.fetchAdminUsers.mockResolvedValue({
    users: [
      adminUser("user_self", "Sunny", "sunny@example.com"),
      adminUser("user_other", "Alex", "alex@example.com"),
    ],
    total: 2,
    limit: 25,
    offset: 0,
  });
  adminMocks.banUser.mockResolvedValue({ data: null, error: null });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.replaceChildren();
});

describe("operator user actions", () => {
  it("disables self-actions and confirms before banning another user", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AdminPage />
        </QueryClientProvider>,
      );
    });
    await waitForUi(() => expect(container.textContent).toContain("sunny@example.com"));

    const selfRow = findRow("sunny@example.com");
    expect(findButtonIn(selfRow, "Ban").disabled).toBe(true);
    expect(findButtonIn(selfRow, "Revoke sessions").disabled).toBe(true);
    expect(
      selfRow.querySelector<HTMLButtonElement>('button[aria-label="Role for Sunny"]')?.disabled,
    ).toBe(true);

    const otherRow = findRow("alex@example.com");
    await act(async () => {
      findButtonIn(otherRow, "Ban").click();
    });

    expect(adminMocks.banUser).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Ban Alex?");

    await act(async () => {
      findButton("Ban user").click();
    });
    await waitForUi(() =>
      expect(adminMocks.banUser).toHaveBeenCalledWith({
        userId: "user_other",
        banReason: "Banned by an Orange Replay operator.",
      }),
    );
  });
});

function adminUser(id: string, name: string, email: string) {
  return {
    id,
    name,
    email,
    image: null,
    role: "user",
    banned: false,
    banReason: null,
    createdAt: 1,
    lastSignedInAt: 1,
    workspaceCount: 1,
  };
}

function findRow(text: string): HTMLTableRowElement {
  const row = [...container.querySelectorAll<HTMLTableRowElement>("tbody tr")].find((item) =>
    item.textContent?.includes(text),
  );
  if (row === undefined) throw new Error(`Could not find the row containing ${text}.`);
  return row;
}

function findButtonIn(element: ParentNode, label: string): HTMLButtonElement {
  const button = [...element.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  if (button === undefined) throw new Error(`Could not find the ${label} button.`);
  return button;
}

function findButton(label: string): HTMLButtonElement {
  return findButtonIn(document.body, label);
}

async function waitForUi(assertion: () => void): Promise<void> {
  await vi.waitFor(async () => {
    await act(async () => Promise.resolve());
    assertion();
  });
}
