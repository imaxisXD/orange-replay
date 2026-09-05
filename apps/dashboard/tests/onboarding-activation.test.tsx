// @vitest-environment happy-dom
import { act, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(Element.prototype, "getAnimations", {
  configurable: true,
  value: () => [],
});

const navigate = vi.fn();
const beginPreviewCut = vi.fn();
const motionState = vi.hoisted(() => ({ reduceMotion: false }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));
vi.mock("@/lib/motion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/motion")>()),
  useReducedMotion: () => motionState.reduceMotion,
}));

const apiMocks = vi.hoisted(() => ({
  createProject: vi.fn(),
  ensureProjectWebsite: vi.fn(),
  fetchLiveSessions: vi.fn(),
  fetchProjectWebsiteInstallStatus: vi.fn(),
  fetchProjectWebsiteSetup: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  ...apiMocks,
}));

import { decideProjectsHome, decideWorkspaceStart } from "../src/lib/dashboard-access";
import {
  ONBOARDING_STEPS,
  OnboardingProvider,
  onboardingStepIndex,
} from "../src/routes/onboarding/onboarding-context";
import type { InstallTargetId } from "../src/routes/onboarding/install-targets";
import { OnboardingInstallPage } from "../src/routes/onboarding/onboarding-install-step";
import { readWebsiteSetupError } from "../src/routes/onboarding/onboarding-setup-error";
import {
  ACT,
  CAMERA,
  PREVIEW_EXIT,
  PREVIEW_BODY,
  PREVIEW_FRAME,
  PREVIEW_PAGE,
  STEP,
  SWITCHER_FIELD,
  TIMING,
  VERIFY,
  cameraStop,
  canvasParallaxScale,
  onboardingAct,
  previewPage,
} from "../src/routes/onboarding/onboarding-motion";
import { OnboardingVerifyPage } from "../src/routes/onboarding/onboarding-verify-step";
import {
  readOnboardingRecorderKey,
  saveOnboardingRecorderKey,
} from "../src/routes/onboarding/onboarding-recorder-key";
import {
  continuesVisitorJourney,
  isWebsiteProjectName,
  readWebsiteUrl,
  websitePreviewLabel,
  websitePreviewSource,
  websiteFaviconUrl,
  websiteProjectName,
  websiteUrlError,
} from "../src/routes/onboarding/onboarding-website";
import { OnboardingWebsitePage } from "../src/routes/onboarding/onboarding-website-step";
import { ApiError, liveSessionsQueryKey } from "../src/lib/api";
import { liveHandoffQueryKey, type LiveHandoffState } from "../src/lib/live-sessions";
import { findReusableEmptyProjectId } from "../src/lib/website-journey";

const PROJECT_ID = "project_abc";
const ACCOUNT_WORKSPACE_ID = "org_abc";
const WEBSITE_ID = "website_abc";
const FIRST_SESSION_ID = "website-session-0001";
const RAW_KEY = `or_live_${"a".repeat(32)}`;
const SAVED_WEBSITE = new URL("https://saved.example");

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
/** Mirrors the harness's camera flag so a test can assert what the shell sees. */
let namingProject: boolean;
/** Mirrors the act flag the verify step reports up to the shell. */
let isRecordingReported: boolean;
/** Mirrors the confirmed-session flag the handoff reports up to the shell. */
let isLiveConfirmedReported: boolean;
let isFirstWebsite: boolean;
let workspaceName: string | null;
let editingWebsiteId: string | null;
let journeyOrigins: string[];
let journeyDomain: string | undefined;
let emptyProjectId: string | null;
let accountWorkspaceId: string | null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  namingProject = false;
  isRecordingReported = false;
  isLiveConfirmedReported = false;
  isFirstWebsite = true;
  workspaceName = null;
  editingWebsiteId = null;
  journeyOrigins = [];
  journeyDomain = undefined;
  emptyProjectId = null;
  accountWorkspaceId = ACCOUNT_WORKSPACE_ID;
  window.sessionStorage.clear();
  navigate.mockReset();
  beginPreviewCut.mockReset();
  motionState.reduceMotion = false;
  for (const mock of Object.values(apiMocks)) mock.mockReset();
  // The handoff asks Live for the session the first event started. Empty by
  // default, so a test that does not care about it falls through to the cap.
  apiMocks.fetchLiveSessions.mockResolvedValue({ sessions: [], truncated: false });
  apiMocks.fetchProjectWebsiteInstallStatus.mockResolvedValue({
    firstEventAt: null,
    firstSessionId: null,
  });
  window.matchMedia = vi.fn().mockReturnValue({
    addEventListener: vi.fn(),
    matches: false,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    removeEventListener: vi.fn(),
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  window.sessionStorage.clear();
  document.body.replaceChildren();
});

describe("activation website identity", () => {
  it("accepts full and plain website addresses", () => {
    expect(readWebsiteUrl("https://acme.com")?.origin).toBe("https://acme.com");
    expect(readWebsiteUrl("http://localhost:3000")?.origin).toBe("http://localhost:3000");
    expect(readWebsiteUrl("acme.com")?.origin).toBe("https://acme.com");
    expect(readWebsiteUrl("www.acme.app")?.origin).toBe("https://www.acme.app");
    expect(readWebsiteUrl("javascript:alert(1)")).toBeNull();
    expect(readWebsiteUrl("  ")).toBeNull();
  });

  it("names the project after the bare hostname", () => {
    expect(websiteProjectName(new URL("https://www.acme.com/pricing"))).toBe("acme.com");
    expect(websiteProjectName(new URL("https://shop.acme.co.uk"))).toBe("shop.acme.co.uk");
  });

  it("tracks partial typing for the preview label", () => {
    expect(websitePreviewLabel("", "Your website")).toBe("Your website");
    expect(websitePreviewLabel("https://ac", "Your website")).toBe("ac");
    expect(websitePreviewLabel("https://www.acme.com/x", "Your website")).toBe("acme.com");
  });

  it("does not revive a saved website while step one is empty", () => {
    expect(websitePreviewSource("", "getfileurl.com", false)).toBe("");
    expect(websitePreviewSource("acme.com", "getfileurl.com", false)).toBe("acme.com");
    expect(websitePreviewSource("", "getfileurl.com", true)).toBe("getfileurl.com");
  });

  it("recognises an already activated project name", () => {
    expect(isWebsiteProjectName("acme.com")).toBe(true);
    expect(isWebsiteProjectName("Default project")).toBe(false);
  });

  it("bounds a visitor journey by the registrable domain", () => {
    expect(
      continuesVisitorJourney(new URL("https://app.acme.com"), ["https://acme.com"], "acme.com"),
    ).toBe(true);
    expect(
      continuesVisitorJourney(
        new URL("https://www.acme.com"),
        ["https://app.acme.com"],
        "acme.com",
      ),
    ).toBe(true);
    expect(
      continuesVisitorJourney(new URL("https://other.io"), ["https://acme.com"], "acme.com"),
    ).toBe(false);
    // A newer dashboard fails closed while an older Worker has not supplied
    // the public-suffix-safe boundary yet.
    expect(continuesVisitorJourney(new URL("https://app.acme.com"), ["https://acme.com"])).toBe(
      false,
    );
    // Multi-part public suffixes stay separate journeys.
    expect(
      continuesVisitorJourney(
        new URL("https://acme.co.uk"),
        ["https://other.co.uk"],
        "other.co.uk",
      ),
    ).toBe(false);
    // The first website and local development never force a split.
    expect(continuesVisitorJourney(new URL("https://acme.com"), [])).toBe(true);
    expect(continuesVisitorJourney(new URL("http://localhost:3000"), ["https://acme.com"])).toBe(
      true,
    );
    expect(continuesVisitorJourney(new URL("https://acme.com"), ["http://localhost:3000"])).toBe(
      true,
    );
    // Public HTTP cannot carry the HTTPS cookie journey across subdomains.
    expect(
      continuesVisitorJourney(new URL("http://app.acme.com"), ["https://acme.com"], "acme.com"),
    ).toBe(false);
    expect(continuesVisitorJourney(new URL("https://acme.com"), ["http://acme.com"])).toBe(false);
  });

  it("reuses only a confirmed empty project", () => {
    expect(
      findReusableEmptyProjectId("project_current", [
        { id: "project_unknown" },
        { id: "project_used", websiteOrigin: "https://acme.com" },
        { id: "project_empty", websiteOrigin: null },
      ]),
    ).toBe("project_empty");
    expect(
      findReusableEmptyProjectId("project_empty", [{ id: "project_empty", websiteOrigin: null }]),
    ).toBeNull();
  });

  it("rejects a hostname the rename route would refuse, and says why", () => {
    // 100 chars is the project-name limit; a longer host would enable Continue
    // and then dead-end on invalid_project_name.
    const longHost = `https://${"a".repeat(50)}.${"b".repeat(50)}.com`;
    expect(readWebsiteUrl(longHost)).toBeNull();
    expect(websiteUrlError(longHost)).toContain("too long");
    expect(websiteUrlError("not a website")).toBe(
      "Enter a website like example.com or https://www.example.com.",
    );
    expect(websiteUrlError("")).toBe("");
    expect(websiteUrlError("https://acme.com")).toBe("");
  });
});

describe("activation step model", () => {
  it("maps each step path to its position in the flow", () => {
    expect(onboardingStepIndex(`/onboarding/${PROJECT_ID}/website`)).toBe(0);
    expect(onboardingStepIndex(`/onboarding/${PROJECT_ID}/install/`)).toBe(1);
    expect(onboardingStepIndex(`/onboarding/${PROJECT_ID}/verify`)).toBe(2);
    expect(onboardingStepIndex("/onboarding")).toBe(0);
    expect(ONBOARDING_STEPS).toHaveLength(3);
  });
});

describe("activation routing decision", () => {
  const account = {
    isAdmin: false,
    workspaces: [{ projects: [{ id: PROJECT_ID, role: "owner" as const }] }],
  };

  it("asks about activation before choosing a landing screen", () => {
    expect(decideProjectsHome({ account })).toEqual({
      action: "check-activation",
      projectId: PROJECT_ID,
    });
  });

  it("sends a project with no events to activation and an active one to its overview", () => {
    expect(decideProjectsHome({ account, checkedActivation: true, hasFirstEvent: false })).toEqual({
      action: "activate-project",
      projectId: PROJECT_ID,
    });
    expect(decideProjectsHome({ account, checkedActivation: true, hasFirstEvent: true })).toEqual({
      action: "open-project",
      projectId: PROJECT_ID,
    });
  });

  it("opens the project when the activation check itself failed", () => {
    // A 503 from the presence registry must not divert a project that is
    // already live: activation's first step replaces allowedOrigins, so a
    // routine outage would let an owner overwrite a working install.
    expect(
      decideProjectsHome({ account, checkedActivation: true, hasFirstEvent: undefined }),
    ).toEqual({ action: "open-project", projectId: PROJECT_ID });
  });

  it("never sends a project the visitor cannot manage to activation", () => {
    // Activation rejects a member-only project, so routing one there is an
    // infinite redirect between /projects and /onboarding.
    const memberAccount = {
      isAdmin: false,
      workspaces: [{ projects: [{ id: PROJECT_ID, role: "member" as const }] }],
    };
    expect(decideProjectsHome({ account: memberAccount })).toEqual({
      action: "open-project",
      projectId: PROJECT_ID,
    });
    expect(
      decideProjectsHome({ account: memberAccount, checkedActivation: true, hasFirstEvent: false }),
    ).toEqual({ action: "open-project", projectId: PROJECT_ID });
  });

  it("still bootstraps an account with no workspace before anything else", () => {
    expect(decideProjectsHome({ account: { isAdmin: false, workspaces: [] } })).toEqual({
      action: "bootstrap-account",
    });
  });

  it("starts a truly empty Workspace at Website entry", () => {
    expect(decideWorkspaceStart([])).toEqual({ action: "add-website" });
  });

  it("resumes the oldest unfinished Website instead of asking for it again", () => {
    expect(
      decideWorkspaceStart([
        { id: "website_ndle", firstEventAt: null },
        { id: "website_app", firstEventAt: null },
      ]),
    ).toEqual({ action: "resume-website", websiteId: "website_ndle" });
  });

  it("opens a Workspace once any Website has connected", () => {
    expect(
      decideWorkspaceStart([
        { id: "website_pending", firstEventAt: null },
        { id: "website_connected", firstEventAt: 1 },
      ]),
    ).toEqual({ action: "open-project" });
  });
});

describe("activation step 1: website", () => {
  it("keeps internal key failures out of the onboarding copy", () => {
    expect(
      readWebsiteSetupError(
        new ApiError("active_key_limit_reached", 409, "active_key_limit_reached"),
      ),
    ).toBe(
      "You have reached the website limit here. Contact support before adding another website.",
    );
    expect(readWebsiteSetupError(new Error("Recorder-key storage is unavailable."))).toBe(
      "Could not prepare the installation script. Try again.",
    );
    expect(
      readWebsiteSetupError(new ApiError("website_already_exists", 409, "website_already_exists")),
    ).toBe("That website is already added.");
    expect(readWebsiteSetupError(new ApiError("website_changed", 409, "website_changed"))).toBe(
      "This Website changed in another tab. Reload and try again.",
    );
    expect(readWebsiteSetupError(new ApiError("untrusted_origin", 403, "untrusted_origin"))).toBe(
      "This dashboard address cannot save changes. Open Orange Replay from its normal address and try again.",
    );
  });

  it("reports an invalid address after one quiet second and clears it on correction", async () => {
    await render(<OnboardingWebsitePage />);
    vi.useFakeTimers();
    try {
      await setWebsiteInput("not a website");
      expect(container.textContent).not.toContain("Enter a website like");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(TIMING.websiteValidation - 1);
      });
      expect(container.textContent).not.toContain("Enter a website like");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(container.textContent).toContain("Enter a website like");
      expect(container.querySelector(".t-input-wrap.is-error .t-error-msg")).not.toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(16);
      });
      expect(container.querySelector(".t-input.is-shaking")).not.toBeNull();

      await setWebsiteInput("acme.com");
      expect(container.querySelector(".t-input-wrap.is-error")).toBeNull();
      expect(container.querySelector(".t-input.is-shaking")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks continuing until the address is usable, then shakes on submit", async () => {
    await render(<OnboardingWebsitePage />);

    expect(container.textContent).toContain("Add your first website");
    expect(container.textContent).toContain("Enter the website where you want to start recording.");
    expect(findButton("Continue").disabled).toBe(true);

    await setWebsiteInput("not a website");
    expect(findButton("Continue").disabled).toBe(false);

    await act(async () => {
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true }));
    });
    expect(container.textContent).toContain("Enter a website like");
    expect(container.querySelector(".t-input-wrap.is-error .t-error-msg")).not.toBeNull();
    await vi.waitFor(() => expect(container.querySelector(".t-input.is-shaking")).not.toBeNull());
    expect(apiMocks.ensureProjectWebsite).not.toHaveBeenCalled();
  });

  it("adds one Website and opens its install step", async () => {
    apiMocks.ensureProjectWebsite.mockResolvedValue(websiteSetup());
    await render(<OnboardingWebsitePage />);
    expect(container.querySelector('.t-favicon-slot[data-stage="0"]')).not.toBeNull();
    expect(container.querySelector(".t-favicon-frame")).toBeNull();

    await setWebsiteInput("acme.com");
    expect(findButton("Continue").disabled).toBe(false);
    expect(container.querySelector('.t-favicon-slot[data-stage="1"]')).not.toBeNull();
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "/api/v1/favicon?website=https%3A%2F%2Facme.com&v=3",
    );
    await act(async () => {
      container.querySelector("img")?.dispatchEvent(new Event("load"));
    });
    expect(container.querySelector('.t-favicon-slot[data-stage="2"]')).not.toBeNull();
    expect(container.querySelector(".t-skel.is-revealed")).not.toBeNull();
    await act(async () => {
      findButton("Continue").click();
    });

    await vi.waitFor(() => {
      expect(apiMocks.ensureProjectWebsite).toHaveBeenCalledWith(PROJECT_ID, "https://acme.com/");
      expect(navigate).toHaveBeenCalledWith({
        to: "/onboarding/$projectId/install",
        params: { projectId: PROJECT_ID },
        search: { website: WEBSITE_ID },
      });
    });
  });

  it("edits the same unfinished Website and keeps its installation", async () => {
    editingWebsiteId = WEBSITE_ID;
    isFirstWebsite = false;
    workspaceName = "Noodle";
    apiMocks.ensureProjectWebsite.mockResolvedValue(
      websiteSetup({ name: "next.example", origin: "https://next.example" }),
    );
    await render(<OnboardingWebsitePage />);

    expect(container.textContent).toContain("Edit website");
    expect(container.textContent).toContain("Update the website you want Orange Replay to record.");
    expect((container.querySelector("input") as HTMLInputElement | null)?.value).toBe(
      SAVED_WEBSITE.origin,
    );

    await setWebsiteInput("next.example");
    await act(async () => {
      findButton("Save and continue").click();
    });

    await vi.waitFor(() => {
      expect(apiMocks.ensureProjectWebsite).toHaveBeenCalledWith(
        PROJECT_ID,
        "https://next.example/",
        WEBSITE_ID,
      );
      expect(navigate).toHaveBeenCalledWith({
        to: "/onboarding/$projectId/install",
        params: { projectId: PROJECT_ID },
        search: { website: WEBSITE_ID },
      });
    });
  });

  it("returns to the same installation without saving when the Website did not change", async () => {
    editingWebsiteId = WEBSITE_ID;
    isFirstWebsite = false;
    workspaceName = "Noodle";
    await render(<OnboardingWebsitePage />);

    await act(async () => {
      findButton("Save and continue").click();
    });

    expect(apiMocks.ensureProjectWebsite).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith({
      to: "/onboarding/$projectId/install",
      params: { projectId: PROJECT_ID },
      search: { website: WEBSITE_ID },
    });
  });

  it("explains the journey rule when adding a later Website", async () => {
    isFirstWebsite = false;
    workspaceName = "Noodle";
    await render(<OnboardingWebsitePage />);

    expect(container.textContent).toContain("Add a website");
    expect(container.textContent).toContain(
      "Add related subdomains to keep one visitor journey. A new domain gets its own recordings.",
    );
    expect(container.textContent).not.toContain("recorder key");
  });

  it("keeps a related subdomain in the same journey", async () => {
    isFirstWebsite = false;
    journeyOrigins = ["https://acme.com"];
    journeyDomain = "acme.com";
    apiMocks.ensureProjectWebsite.mockResolvedValue(
      websiteSetup({ name: "app.acme.com", origin: "https://app.acme.com" }),
    );
    await render(<OnboardingWebsitePage />);

    await setWebsiteInput("app.acme.com");
    await act(async () => {
      findButton("Continue").click();
    });

    await vi.waitFor(() => {
      expect(apiMocks.ensureProjectWebsite).toHaveBeenCalledWith(
        PROJECT_ID,
        "https://app.acme.com/",
      );
    });
    expect(apiMocks.createProject).not.toHaveBeenCalled();
  });

  it("gives an unrelated domain its own recordings", async () => {
    isFirstWebsite = false;
    journeyOrigins = ["https://acme.com"];
    journeyDomain = "acme.com";
    apiMocks.createProject.mockResolvedValue({
      project: { id: "project_new", name: "Default project", role: "owner" },
      account: { workspaces: [] },
    });
    apiMocks.ensureProjectWebsite.mockResolvedValue(
      websiteSetup({ name: "other.io", origin: "https://other.io" }),
    );
    await render(<OnboardingWebsitePage />);

    await setWebsiteInput("other.io");
    await act(async () => {
      findButton("Continue").click();
    });

    await vi.waitFor(() => {
      expect(apiMocks.createProject).toHaveBeenCalledWith(ACCOUNT_WORKSPACE_ID);
      expect(apiMocks.ensureProjectWebsite).toHaveBeenCalledWith(
        "project_new",
        "https://other.io/",
      );
      expect(navigate).toHaveBeenCalledWith({
        to: "/onboarding/$projectId/install",
        params: { projectId: "project_new" },
        search: { website: WEBSITE_ID },
      });
    });
    // The minted key follows the new project so its install step can restore it.
    expect(readOnboardingRecorderKey("project_new", WEBSITE_ID)).toBe(RAW_KEY);
  });

  it("reuses the same empty project when Website setup is retried", async () => {
    isFirstWebsite = false;
    journeyOrigins = ["https://acme.com"];
    journeyDomain = "acme.com";
    apiMocks.createProject.mockResolvedValue({
      project: { id: "project_new", name: "Default project", role: "owner" },
      account: { workspaces: [] },
    });
    apiMocks.ensureProjectWebsite
      .mockRejectedValueOnce(new ApiError("Connection lost.", 0, "network_error"))
      .mockResolvedValueOnce(websiteSetup({ name: "other.io", origin: "https://other.io" }));
    await render(<OnboardingWebsitePage />);

    await setWebsiteInput("other.io");
    await act(async () => findButton("Continue").click());
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain("Could not add this website. Try again."),
      );
    });

    await act(async () => findButton("Continue").click());
    await vi.waitFor(() => {
      expect(apiMocks.ensureProjectWebsite).toHaveBeenCalledTimes(2);
      expect(navigate).toHaveBeenCalledWith({
        to: "/onboarding/$projectId/install",
        params: { projectId: "project_new" },
        search: { website: WEBSITE_ID },
      });
    });
    expect(apiMocks.createProject).toHaveBeenCalledTimes(1);
  });

  it("recovers an empty project after reload instead of creating another", async () => {
    isFirstWebsite = false;
    emptyProjectId = "project_draft";
    journeyOrigins = ["https://acme.com"];
    journeyDomain = "acme.com";
    apiMocks.ensureProjectWebsite.mockResolvedValue(
      websiteSetup({ name: "other.io", origin: "https://other.io" }),
    );
    await render(<OnboardingWebsitePage />);

    await setWebsiteInput("other.io");
    await act(async () => findButton("Continue").click());
    await vi.waitFor(() =>
      expect(apiMocks.ensureProjectWebsite).toHaveBeenCalledWith(
        "project_draft",
        "https://other.io/",
      ),
    );
    expect(apiMocks.createProject).not.toHaveBeenCalled();
  });

  it("fails closed when the account destination is unavailable", async () => {
    isFirstWebsite = false;
    accountWorkspaceId = null;
    journeyOrigins = ["https://acme.com"];
    journeyDomain = "acme.com";
    await render(<OnboardingWebsitePage />);

    await setWebsiteInput("other.io");
    await act(async () => findButton("Continue").click());
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain(
          "Could not find where to add this website. Reload and try again.",
        ),
      );
    });
    expect(apiMocks.createProject).not.toHaveBeenCalled();
    expect(apiMocks.ensureProjectWebsite).not.toHaveBeenCalled();
  });

  it("waits when the Worker has not supplied the safe journey boundary", async () => {
    isFirstWebsite = false;
    journeyOrigins = ["https://acme.com"];
    await render(<OnboardingWebsitePage />);

    await setWebsiteInput("app.acme.com");
    await act(async () => findButton("Continue").click());
    await act(async () => {
      await vi.waitFor(() =>
        expect(container.textContent).toContain(
          "Website setup is still loading. Wait a moment and try again.",
        ),
      );
    });
    expect(apiMocks.createProject).not.toHaveBeenCalled();
    expect(apiMocks.ensureProjectWebsite).not.toHaveBeenCalled();
  });

  it("explains that an existing Website is connected without changing its setup", async () => {
    isFirstWebsite = false;
    workspaceName = "Noodle";
    apiMocks.ensureProjectWebsite.mockResolvedValue(connectedWebsiteSetup());
    await render(<OnboardingWebsitePage />);

    await setWebsiteInput("acme.com");
    await act(async () => {
      findButton("Continue").click();
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain("acme.com is already connected");
    });
    expect(container.textContent).toContain("This website is already connected alongside Noodle.");
    expect(container.textContent).toContain("No new installation was created.");
    expect(container.textContent).not.toContain("recorder key");
    expect(navigate).not.toHaveBeenCalled();

    await act(async () => {
      findButton("Go to dashboard").click();
    });
    // This exit is not the activation payoff: the Website was already connected
    // before this visit, so there is no session this flow just proved exists.
    // Overview is the ordinary home, and stays the ordinary home.
    expect(navigate).toHaveBeenCalledWith({
      to: "/projects/$projectId/overview",
      params: { projectId: PROJECT_ID },
      replace: true,
    });
  });

  it("keeps the visitor on the step and explains a failed write", async () => {
    apiMocks.ensureProjectWebsite.mockRejectedValue(new Error("Network is unreachable."));
    await render(<OnboardingWebsitePage />);

    await setWebsiteInput("https://acme.com");
    await act(async () => {
      findButton("Continue").click();
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Could not add this website. Try again.");
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(apiMocks.ensureProjectWebsite).toHaveBeenCalledTimes(1);
  });

  it("moves the preview camera onto the switcher only while a name is being typed", async () => {
    await render(<OnboardingWebsitePage />);
    const input = container.querySelector("input");

    await setWebsiteInput("https://ac");
    expect(namingProject).toBe(true);

    // React delegates onBlur from the bubbling focusout event, not blur.
    await act(async () => {
      input?.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(namingProject).toBe(false);
  });
});

describe("activation step 2: install", () => {
  it("pulses a page-shaped skeleton until the installation script is ready", async () => {
    const keyRequest = deferred<ReturnType<typeof websiteSetup>>();
    apiMocks.fetchProjectWebsiteSetup.mockReturnValue(keyRequest.promise);
    await render(<OnboardingInstallPage />);

    const reveal = container.querySelector(".onboarding-install-reveal");
    const skeleton = container.querySelector(".t-skel-skeleton.is-pulsing");
    expect(reveal?.getAttribute("data-state")).toBe("loading");
    expect(reveal?.classList.contains("is-revealed")).toBe(false);
    expect(skeleton?.getAttribute("aria-hidden")).toBe("false");
    // Both the manual script and agent prompt have a title, preview card and
    // expander, with a choice divider. The skeleton mirrors all seven controls
    // so revealing them swaps in place.
    expect(skeleton?.children).toHaveLength(7);
    expect(container.querySelector('.t-skel-content[aria-hidden="true"]')).not.toBeNull();

    await vi.waitFor(() => {
      expect(apiMocks.fetchProjectWebsiteSetup).toHaveBeenCalledWith(PROJECT_ID, WEBSITE_ID);
    });
    expect(reveal?.getAttribute("data-state")).toBe("loading");

    keyRequest.resolve(websiteSetup());
    await vi.waitFor(() => {
      expect(reveal?.getAttribute("data-state")).toBe("ready");
      expect(reveal?.classList.contains("is-revealed")).toBe(true);
    });
    expect(skeleton?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector('.t-skel-content[aria-hidden="true"]')).toBeNull();
    expect(container.querySelector("pre")?.textContent).toContain("Orange Replay loader,");
    expect(container.textContent).not.toContain("recorder key");
  });

  it("loads and copies the Website installation script", async () => {
    const writeText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue();
    // Define the one property rather than replacing navigator: spreading it
    // would drop its prototype along with everything else the tree reads.
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    apiMocks.fetchProjectWebsiteSetup.mockResolvedValue(websiteSetup());
    await render(<OnboardingInstallPage />);

    await vi.waitFor(() => {
      expect(apiMocks.fetchProjectWebsiteSetup).toHaveBeenCalledWith(PROJECT_ID, WEBSITE_ID);
    });
    await vi.waitFor(() => {
      expect(copyLabel()).toBe("Copy");
    });
    // No Continue: the step advances on the event, not on a click, and the
    // waiting state it would have announced belongs to the preview.
    expect(container.textContent).not.toContain("Continue");

    // The card summarises the loader by default, so a 1,800-character minified
    // line does not fill the column — and the raw key is not on screen until
    // asked for. What gets pasted is what must carry the key.
    const collapsed = container.querySelector("pre")?.textContent ?? "";
    expect(collapsed).toContain("Orange Replay loader,");
    expect(collapsed).not.toContain(RAW_KEY);

    await act(async () => {
      findButton("Copy").click();
    });
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    const copied = writeText.mock.calls[0]?.[0] ?? "";
    expect(copied).toContain(RAW_KEY);
    expect(copied).toContain("or-recorder.js");

    // Success turns the check green and plays transitions.dev's success check;
    // the colour is the state, the animation is only how it arrived. The copy
    // glyph leaves at the same time rather than being unmounted.
    await vi.waitFor(() => {
      expect(copyLabel()).toBe("Copied");
    });
    const check = container.querySelector(".t-success-check");
    expect(check?.getAttribute("class")).toContain("text-success");
    expect(check?.getAttribute("data-state")).toBe("in");
    expect(container.querySelector(".t-copy-glyph")?.getAttribute("data-state")).toBe("out");

    await act(async () => {
      findButton("View full code").click();
    });
    expect(container.querySelector("pre")?.textContent).toContain(RAW_KEY);

    // The code card scrolls through the shared ScrollArea, whose content wrapper
    // carries `min-width: fit-content` inline. Without this override the
    // minified loader laid out sideways to 1289px inside a 368px viewport and
    // most of it could not be reached, because this scroller is vertical only.
    // Layout is not measurable here, so the guard is the class that prevents it.
    const viewport = container.querySelector('[data-slot="scroll-area-viewport"]');
    expect(viewport?.getAttribute("class")).toContain("min-w-0");
  });

  it("previews, reveals and copies the coding-agent prompt for the selected stack", async () => {
    const writeText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue();
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    apiMocks.fetchProjectWebsiteSetup.mockResolvedValue(websiteSetup());
    await render(<OnboardingInstallPage />);

    await vi.waitFor(() => {
      expect(findButtonByLabel("Copy agent prompt")).toBeDefined();
    });

    // The collapsed card shows a real prompt summary without exposing the key.
    expect(container.textContent).toContain("Use your coding agent");
    const methodDivider = container.querySelector("[data-install-method-divider]");
    expect(methodDivider?.textContent?.trim()).toBe("or");
    expect(methodDivider?.querySelectorAll('[role="separator"]')).toHaveLength(2);
    expect(container.textContent).toContain("Stack: HTML · Every page");
    expect(container.querySelector(".text-agent-purple")).not.toBeNull();
    expect(container.textContent).not.toContain("Requirements:");
    expect(container.textContent).not.toContain(RAW_KEY);

    await act(async () => {
      findButton("View full prompt").click();
    });
    expect(container.textContent).toContain("Requirements:");
    expect(container.textContent).toContain(RAW_KEY);
    expect(findButton("Hide full prompt").getAttribute("aria-expanded")).toBe("true");

    // Opening the full script collapses the prompt, so the fixed-height
    // onboarding column never holds two expanded code surfaces at once.
    await act(async () => {
      findButton("View full code").click();
    });
    expect(container.textContent).not.toContain("Requirements:");
    expect(findButton("View full prompt").getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      findButtonByLabel("Copy agent prompt").click();
    });
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
      expect(findButtonByLabel("Agent prompt copied")).toBeDefined();
    });
    const htmlPrompt = writeText.mock.calls[0]?.[0] ?? "";
    expect(htmlPrompt).toContain("Use this exact script tag:");
    expect(htmlPrompt).toContain("<script>");
    expect(htmlPrompt).toContain(RAW_KEY);
    expect(htmlPrompt).toContain("Suggested file: Every page");

    // The prompt follows the current stack. Changing it clears the copied state
    // because the clipboard still contains the previous framework's request.
    await act(async () => {
      findTab("Next.js").click();
    });
    expect(findButtonByLabel("Copy agent prompt")).toBeDefined();
    expect(container.textContent).toContain("Stack: Next.js · app/layout.tsx");

    await act(async () => {
      findButtonByLabel("Copy agent prompt").click();
    });
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(2);
    });
    const nextPrompt = writeText.mock.calls[1]?.[0] ?? "";
    expect(nextPrompt).toContain("Suggested file: `app/layout.tsx`");
    expect(nextPrompt).toContain('import Script from "next/script"');
    expect(nextPrompt).toContain(RAW_KEY);
  });

  it("retries automatic script preparation after a request failure", async () => {
    apiMocks.fetchProjectWebsiteSetup
      .mockRejectedValueOnce(new Error("Website setup is unavailable."))
      .mockResolvedValueOnce(websiteSetup());
    await render(<OnboardingInstallPage />);

    await vi.waitFor(() => {
      expect(container.textContent).toContain(
        "Could not prepare the installation script. Try again.",
      );
    });
    await act(async () => {
      findButton("Try again").click();
    });
    await vi.waitFor(() => {
      expect(apiMocks.fetchProjectWebsiteSetup).toHaveBeenCalledTimes(2);
      expect(copyLabel()).toBe("Copy");
    });
  });

  it("uses the tab's saved script immediately while confirming its Website", async () => {
    saveOnboardingRecorderKey(PROJECT_ID, WEBSITE_ID, RAW_KEY);
    apiMocks.fetchProjectWebsiteSetup.mockResolvedValue(websiteSetup());
    await render(<OnboardingInstallPage />);

    expect(container.textContent).not.toContain("This project already has a key");
    expect(copyLabel()).toBe("Copy");
    expect(container.querySelector("pre")?.textContent).toContain("Orange Replay loader,");
    await vi.waitFor(() => {
      expect(apiMocks.fetchProjectWebsiteSetup).toHaveBeenCalledTimes(1);
    });
  });

  it("changes the file, the placement and the pasted code with the stack", async () => {
    const writeText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue();
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    saveOnboardingRecorderKey(PROJECT_ID, WEBSITE_ID, RAW_KEY);
    apiMocks.fetchProjectWebsiteSetup.mockResolvedValue(websiteSetup());
    await render(<OnboardingInstallPage />);

    // The stack picker does not wait on the key: it is outside the reveal, so
    // every framework is selectable while the script is still being prepared.
    expect(findTab("Next.js").getAttribute("aria-selected")).toBe("false");
    expect(visibleInstruction()).toContain("Every page you want to record needs the tag");

    await act(async () => {
      findTab("Next.js").click();
    });

    expect(findTab("Next.js").getAttribute("aria-selected")).toBe("true");
    expect(container.textContent).toContain("app/layout.tsx");
    expect(visibleInstruction()).toContain("Next.js runs it before hydration");
    expect(visibleInstruction()).not.toContain("Every page you want to record needs the tag");

    await act(async () => {
      findButton("Copy").click();
    });
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledTimes(1);
    });
    const copied = writeText.mock.calls[0]?.[0] ?? "";
    expect(copied).toContain('import Script from "next/script"');
    expect(copied).toContain(RAW_KEY);

    // Switching away must drop the Copied badge: it would be claiming that a
    // different snippet is on the clipboard. Read the swapping label, not
    // `textContent`: an invisible copy of the longer word is always rendered to
    // reserve the button's width.
    await vi.waitFor(() => {
      expect(copyLabel()).toBe("Copied");
    });
    await act(async () => {
      findTab("Svelte").click();
    });
    await vi.waitFor(() => {
      expect(copyLabel()).toBe("Copy");
    });
    expect(container.textContent).toContain("src/app.html");
  });

  it("shows the connected state when another tab finished setup", async () => {
    saveOnboardingRecorderKey(PROJECT_ID, WEBSITE_ID, RAW_KEY);
    apiMocks.fetchProjectWebsiteSetup.mockResolvedValue(connectedWebsiteSetup());
    await render(<OnboardingInstallPage />);

    await vi.waitFor(() => {
      expect(container.textContent).toContain("acme.com is already connected");
    });
    expect(container.textContent).toContain("No changes needed");
    expect(container.textContent).not.toContain(RAW_KEY);
    expect(readOnboardingRecorderKey(PROJECT_ID, WEBSITE_ID)).toBeNull();
    expect(navigate).not.toHaveBeenCalled();

    await act(async () => {
      findButton("Add another website").click();
    });
    expect(navigate).toHaveBeenCalledWith({
      to: "/onboarding/$projectId/website",
      params: { projectId: PROJECT_ID },
      replace: true,
    });
  });
});

describe("activation step 3: verify", () => {
  it("waits on the real install status and does not claim success early", async () => {
    apiMocks.fetchProjectWebsiteInstallStatus.mockResolvedValue({
      firstEventAt: null,
      firstSessionId: null,
    });
    await render(<OnboardingVerifyPage />);

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Waiting for your website");
    });
    expect(container.textContent).not.toContain("acme.com is connected");
    expect(container.querySelector(".onboarding-signal")).not.toBeNull();

    await act(async () => {
      findButton("Check again").click();
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("confirms the recorder once an event has arrived and opens the dashboard", async () => {
    saveOnboardingRecorderKey(PROJECT_ID, WEBSITE_ID, RAW_KEY);
    apiMocks.fetchProjectWebsiteInstallStatus.mockResolvedValue({
      firstEventAt: Date.now() - 2_000,
      firstSessionId: FIRST_SESSION_ID,
    });
    await render(<OnboardingVerifyPage />);

    await vi.waitFor(() => {
      expect(container.textContent).toContain("acme.com is connected");
    });
    expect(container.querySelector("svg path")).not.toBeNull();
    // The step is a route and cannot animate the right pane itself, so the act
    // has to reach the shell or the preview never gets its payoff beat.
    await vi.waitFor(() => {
      expect(isRecordingReported).toBe(true);
    });
    expect(readOnboardingRecorderKey(PROJECT_ID, WEBSITE_ID)).toBeNull();

    await act(async () => {
      findButton("Go to dashboard").click();
    });
    // Live, not Overview: Overview needs a finalised session and is guaranteed
    // empty this early, while the session just proved to exist is on Live.
    expect(navigate).toHaveBeenCalledWith({
      to: "/projects/$projectId/live",
      params: { projectId: PROJECT_ID },
      replace: true,
    });
  });

  it("confirms the session, seeds Live's cache, and holds the payoff before the cut", async () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    apiMocks.fetchProjectWebsiteInstallStatus.mockResolvedValue({
      firstEventAt: Date.now() - 2_000,
      firstSessionId: FIRST_SESSION_ID,
    });
    const live = {
      sessions: [liveSession()],
      truncated: false,
    };
    apiMocks.fetchLiveSessions.mockResolvedValue(live);
    await render(<OnboardingVerifyPage />);

    // The confirmed answer fills the preview's Live card — the payoff — and
    // becomes the Live page's own cache entry, so the page the cut lands on
    // renders with the session already in place.
    await vi.waitFor(() => {
      expect(isLiveConfirmedReported).toBe(true);
    });
    expect(queryClient.getQueryData(liveSessionsQueryKey(PROJECT_ID))).toEqual(live);

    // The cut waits out the payoff hold so "Live now" can be read before the
    // frame starts moving; nothing navigates during the hold.
    expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === PREVIEW_EXIT.duration)).toBe(
      false,
    );
    const hold = setTimeoutSpy.mock.calls.find(([, delay]) => delay === VERIFY.payoffHold);
    expect(hold).toBeDefined();
    expect(navigate).not.toHaveBeenCalled();

    await act(async () => {
      const callback = hold?.[0];
      if (typeof callback === "function") callback();
    });
    // The route then changes behind the preview's cut rather than on the same
    // tick, so the grow has something to grow over.
    await act(async () => {
      const cut = setTimeoutSpy.mock.calls.find(([, delay]) => delay === PREVIEW_EXIT.duration);
      const callback = cut?.[0];
      if (typeof callback === "function") callback();
    });
    expect(navigate).toHaveBeenCalledWith({
      to: "/projects/$projectId/live",
      params: { projectId: PROJECT_ID },
      replace: true,
    });
    setTimeoutSpy.mockRestore();
  });

  it("ignores another live session and waits for this Website's first session", async () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    apiMocks.fetchProjectWebsiteInstallStatus.mockResolvedValue({
      firstEventAt: Date.now() - 2_000,
      firstSessionId: FIRST_SESSION_ID,
    });
    apiMocks.fetchLiveSessions
      .mockResolvedValueOnce({ sessions: [liveSession("another-session-0001")], truncated: false })
      .mockResolvedValue({ sessions: [liveSession()], truncated: false });
    await render(<OnboardingVerifyPage />);

    await vi.waitFor(() => expect(apiMocks.fetchLiveSessions).toHaveBeenCalledTimes(1));
    expect(isLiveConfirmedReported).toBe(false);
    const retry = setTimeoutSpy.mock.calls.find(([, delay]) => delay === VERIFY.handoffPoll);
    expect(retry).toBeDefined();

    await act(async () => {
      const callback = retry?.[0];
      if (typeof callback === "function") callback();
    });
    await vi.waitFor(() => expect(isLiveConfirmedReported).toBe(true));
    setTimeoutSpy.mockRestore();
  });

  it("aborts the live request and does not schedule another poll after leaving", async () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const liveRequest = deferred<ReturnType<typeof liveResponse>>();
    let requestSignal: AbortSignal | undefined;
    apiMocks.fetchProjectWebsiteInstallStatus.mockResolvedValue({
      firstEventAt: Date.now() - 2_000,
      firstSessionId: FIRST_SESSION_ID,
    });
    apiMocks.fetchLiveSessions.mockImplementation(
      (_projectId: string, options: { signal?: AbortSignal }) => {
        requestSignal = options.signal;
        return liveRequest.promise;
      },
    );
    await render(<OnboardingVerifyPage />);
    await vi.waitFor(() => expect(apiMocks.fetchLiveSessions).toHaveBeenCalledTimes(1));

    await render(<div />);
    expect(requestSignal?.aborted).toBe(true);
    liveRequest.resolve(liveResponse());
    await act(async () => Promise.resolve());
    expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === VERIFY.handoffPoll)).toBe(false);
    expect(isLiveConfirmedReported).toBe(false);
    setTimeoutSpy.mockRestore();
  });

  it("skips presentation delays when reduced motion is requested", async () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    motionState.reduceMotion = true;
    apiMocks.fetchProjectWebsiteInstallStatus.mockResolvedValue({
      firstEventAt: Date.now() - 2_000,
      firstSessionId: FIRST_SESSION_ID,
    });
    apiMocks.fetchLiveSessions.mockResolvedValue(liveResponse());
    await render(<OnboardingVerifyPage />);

    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === VERIFY.payoffHold)).toBe(false);
    expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === PREVIEW_EXIT.duration)).toBe(
      false,
    );
    setTimeoutSpy.mockRestore();
  });

  it("hands over anyway when the live query stays empty", async () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    apiMocks.fetchProjectWebsiteInstallStatus.mockResolvedValue({
      firstEventAt: Date.now() - 2_000,
      firstSessionId: FIRST_SESSION_ID,
    });
    await render(<OnboardingVerifyPage />);

    await vi.waitFor(() => {
      expect(container.textContent).toContain("acme.com is connected");
    });
    // A slow, empty or failing query must not strand anyone on a screen that
    // has finished saying what it had to say.
    const cap = [...setTimeoutSpy.mock.calls]
      .reverse()
      .find(([, delay]) => delay === VERIFY.handoffCap);
    expect(cap).toBeDefined();
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => {
      const callback = cap?.[0];
      if (typeof callback === "function") callback();
    });
    expect(
      queryClient.getQueryData<LiveHandoffState>(liveHandoffQueryKey(PROJECT_ID))?.connectingUntil,
    ).toBeGreaterThan(Date.now());
    // The cap decides when to leave; the cut still runs before the route does.
    await act(async () => {
      const cut = setTimeoutSpy.mock.calls.find(([, delay]) => delay === PREVIEW_EXIT.duration);
      const callback = cut?.[0];
      if (typeof callback === "function") callback();
    });
    expect(navigate).toHaveBeenCalledWith({
      to: "/projects/$projectId/live",
      params: { projectId: PROJECT_ID },
      replace: true,
    });
    setTimeoutSpy.mockRestore();
  });
});

async function render(step: ReactNode): Promise<void> {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Harness>{step}</Harness>
      </QueryClientProvider>,
    );
  });
}

/**
 * Stands in for the shell so one step can be exercised without the router. It
 * holds the same shared state the shell owns, in real React state, so a step
 * writing the draft or the minted key re-renders exactly as it does in the app.
 */
function Harness({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState(editingWebsiteId === null ? "" : SAVED_WEBSITE.origin);
  const [key, setKey] = useState<string | null>(null);
  const [websiteId, setWebsiteId] = useState<string | null>(WEBSITE_ID);
  const [installTargetId, setInstallTargetId] = useState<InstallTargetId>("html");
  const [isNaming, setIsNaming] = useState(false);
  const [recording, setRecording] = useState(false);
  const [liveConfirmed, setLiveConfirmed] = useState(false);
  namingProject = isNaming;
  isRecordingReported = recording;
  isLiveConfirmedReported = liveConfirmed;
  const draftWebsite = readWebsiteUrl(draft);

  return (
    <OnboardingProvider
      value={{
        accountWorkspaceId,
        act: onboardingAct(0, recording),
        beginPreviewCut,
        isLeaving: false,
        installTargetId,
        setInstallTargetId,
        pollTick: 0,
        registerStatusPoll: () => undefined,
        direction: 1,
        editingWebsiteId,
        editingWebsiteOrigin: editingWebsiteId === null ? null : SAVED_WEBSITE.origin,
        emptyProjectId,
        faviconUrl:
          draftWebsite === null
            ? websiteFaviconUrl(SAVED_WEBSITE)
            : websiteFaviconUrl(draftWebsite),
        isFirstPaint: true,
        isFirstWebsite,
        isLiveConfirmed: liveConfirmed,
        journeyDomain,
        journeyOrigins,
        isNamingProject: isNaming,
        isRecording: recording,
        previewProjectLabel: "acme.com",
        projectId: PROJECT_ID,
        recorderKey: key,
        savedWebsiteName: SAVED_WEBSITE.hostname,
        setIsLiveConfirmed: setLiveConfirmed,
        setIsNamingProject: setIsNaming,
        setIsRecording: setRecording,
        setRecorderKey: setKey,
        setWebsiteId,
        setWebsiteDraft: setDraft,
        stepIndex: 0,
        websiteDraft: draft,
        websiteId,
        workspaceName,
      }}
    >
      {children}
    </OnboardingProvider>
  );
}

async function setWebsiteInput(value: string): Promise<void> {
  const input = container.querySelector("input");
  if (input === null) throw new Error("The website field is missing.");
  // React tracks the last value it wrote, so assigning `input.value` directly
  // is swallowed as a no-op change. Go through the prototype setter instead.
  const valueDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  await act(async () => {
    valueDescriptor?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/**
 * The copy button's visible label. `container.textContent` cannot answer this:
 * the button always renders an invisible copy of the longer word to reserve its
 * width, and the swap keeps the outgoing word mounted while it animates out.
 */
function copyLabel(): string | undefined {
  return container.querySelector(".t-text-swap")?.textContent ?? undefined;
}

/**
 * The stack picker's visible placement sentence. Same reason as `copyLabel`:
 * every target's instruction is stacked invisibly inside the panel so the
 * tallest one reserves the height, which puts all five sentences in
 * `textContent` while only the selected tab's is shown.
 */
function visibleInstruction(): string {
  const panel = container.querySelector('[role="tabpanel"]');
  if (panel === null) return "";
  return [...panel.querySelectorAll('span[class*="col-start-1"]')]
    .filter((span) => span.getAttribute("aria-hidden") !== "true")
    .map((span) => span.textContent ?? "")
    .join("");
}

function findTab(label: string): HTMLElement {
  const tab = [...container.querySelectorAll('[role="tab"]')].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (!(tab instanceof HTMLElement)) throw new Error(`No tab labelled ${label}.`);
  return tab;
}

function findButton(label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (button === undefined) throw new Error(`No button labelled ${label}.`);
  return button;
}

function findButtonByLabel(label: string): HTMLButtonElement {
  const button = container.querySelector(`button[aria-label="${label}"]`);
  if (!(button instanceof HTMLButtonElement)) throw new Error(`No button labelled ${label}.`);
  return button;
}

function projectKeyAudit() {
  return {
    active: true,
    createdAt: Date.now(),
    createdBy: null,
    id: "key_1",
    keyHashPrefix: "abcdef01",
    name: "Website recorder",
    revokedAt: null,
    revokedBy: null,
  };
}

function websiteSetup(website: Partial<{ name: string; origin: string }> = {}) {
  return {
    website: {
      id: WEBSITE_ID,
      name: website.name ?? "acme.com",
      origin: website.origin ?? "https://acme.com",
      firstEventAt: null,
    },
    key: projectKeyAudit(),
    secret: RAW_KEY,
    alreadyConnected: false,
  };
}

function connectedWebsiteSetup() {
  const setup = websiteSetup();
  return {
    ...setup,
    alreadyConnected: true,
    secret: null,
    website: { ...setup.website, firstEventAt: Date.now() - 2_000 },
  };
}

function liveSession(sessionId = FIRST_SESSION_ID) {
  const now = Date.now();
  return {
    session_id: sessionId,
    started_at: now,
    last_seen: now,
    entry_url: "https://acme.com/",
    country: null,
    city: null,
    browser: null,
    os: null,
    device: null,
    duration_ms: 0,
  };
}

function liveResponse() {
  return { sessions: [liveSession()], truncated: false };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("activation story acts", () => {
  it("uses the transitions.dev page slide values between steps", () => {
    expect(STEP.travelX).toBe(8);
    expect(STEP.blur).toBe(3);
    expect(STEP.transition).toEqual({ duration: 0.25, ease: [0.22, 1, 0.36, 1] });
  });

  it("derives one act from the step and the recorder", () => {
    expect(onboardingAct(0, false)).toBe(ACT.identity);
    expect(onboardingAct(1, false)).toBe(ACT.promise);
    expect(onboardingAct(2, false)).toBe(ACT.promise);
  });

  it("keeps the live act once an event has arrived, on any step", () => {
    // Stepping Back after connecting must not take the payoff away: "the
    // recorder is live" is true regardless of which screen is open.
    for (const step of [0, 1, 2]) {
      expect(onboardingAct(step, true)).toBe(ACT.live);
    }
  });

  it("moves the camera only while naming, on any act", () => {
    // Naming is a transient override, not a rung on the ladder: someone who
    // steps Back to change their website after connecting still gets the
    // push-in, and the shell is what limits naming to step 1.
    const wide = cameraStop(false);
    expect(cameraStop(true).scale).toBeGreaterThan(wide.scale);
    expect(wide).toEqual({ scale: CAMERA.overview.scale, x: 0, y: 0 });
  });

  it("lifts the frame only once the recorder is live", () => {
    expect(PREVIEW_FRAME.restY).toBe(0);
    expect(PREVIEW_FRAME.liveY).toBeLessThan(0);
  });
});

describe("activation arrival and exits", () => {
  it("stages the arrival so each beat has one subject", () => {
    // The card already being watched answers first, then the frame responds,
    // then the page changes. All three used to land in one frame.
    expect(TIMING.arrivalInstalled).toBe(0);
    expect(TIMING.arrivalLift).toBeGreaterThan(TIMING.arrivalInstalled);
    expect(TIMING.arrivalLive).toBeGreaterThan(TIMING.arrivalLift);
    expect(PREVIEW_FRAME.liveDelay * 1_000).toBe(TIMING.arrivalLift);
  });

  it("starts the exit only after the arrival has been read", () => {
    // "Here is your visitor" and "taking you there" are two statements, and the
    // first is unreadable if the frame starts growing over it. The payoff hold
    // is what now separates them: the cut waits it out after the card fills.
    expect(VERIFY.payoffHold).toBeGreaterThan(TIMING.arrivalLive);
  });

  it("lets the form column leave before the frame has finished covering it", () => {
    // The column is what is being handed over from, so it goes first and
    // faster; the frame is still growing when it is gone.
    expect(PREVIEW_EXIT.columnDuration).toBeLessThan(PREVIEW_EXIT.duration);
  });
});

describe("activation preview page", () => {
  it("shows the page each step is actually about", () => {
    expect(previewPage(0, false)).toBe(PREVIEW_PAGE.overview);
    // Step two stays on Install, and that page carries the wait: the real
    // Install page's verify card is already the product's waiting state.
    expect(previewPage(1, false)).toBe(PREVIEW_PAGE.install);
  });

  it("moves to Live for the event, and for nothing else", () => {
    expect(previewPage(1, true)).toBe(PREVIEW_PAGE.live);
    expect(previewPage(2, false)).toBe(PREVIEW_PAGE.live);
    // Connecting outranks the step, so stepping Back after the recorder is live
    // does not walk the preview back to Install.
    for (const step of [0, 1, 2]) {
      expect(previewPage(step, true)).toBe(PREVIEW_PAGE.live);
    }
  });

  it("leaves the cut time to run before the route changes", () => {
    // The route change waits for the grow; the cap has to outlast a full
    // payoff-and-cut so it can never fire mid-sequence on the boundary.
    expect(VERIFY.handoffCap).toBeGreaterThan(VERIFY.payoffHold + PREVIEW_EXIT.duration);
  });

  it("does not blur the page it swaps in", () => {
    // The left column's chunks clear a blur because they are text being read.
    // The preview is a picture of a page, and blurring it reads as the camera
    // losing focus rather than as a page arriving.
    expect(PREVIEW_BODY.riseY).toBeGreaterThan(0);
    expect(Object.keys(PREVIEW_BODY)).not.toContain("blur");
  });
});

describe("activation preview camera", () => {
  it("rests flush at the frame's corner and pushes in toward the switcher", () => {
    const rest = cameraStop(false);
    const focus = cameraStop(true);

    expect(rest).toEqual({ scale: CAMERA.overview.scale, x: 0, y: 0 });
    expect(focus.scale).toBeGreaterThan(rest.scale);
    // Biased left, so the push reads as going toward the subject rather than
    // enlarging everything from the corner.
    expect(focus.x).toBeLessThan(0);
  });

  it("never lets the brand mark leave the frame", () => {
    // The hard bound on the bias. An earlier framing cancelled the subject's
    // drift exactly and cropped the logo, which read as a broken screenshot.
    for (const stop of [cameraStop(false), cameraStop(true)]) {
      const brandLeftEdge = CAMERA.brandX * stop.scale + stop.x;
      expect(brandLeftEdge).toBeGreaterThan(0);
    }
  });

  it("never lifts the dashboard's top edge above the frame", () => {
    // `y: 120` once pushed the header into mid-frame behind empty canvas.
    for (const stop of [cameraStop(false), cameraStop(true)]) {
      expect(stop.y).toBe(0);
    }
  });

  it("keeps the zoom shallow enough that the dashboard stays a dashboard", () => {
    // 1.42 filled the frame with chrome and stopped reading as a dashboard;
    // the metric band and behaviour card have to survive the push.
    expect(cameraStop(true).scale).toBeLessThan(1.3);
  });

  it("holds the subject's drift well under the swing that read as a slide", () => {
    // The original framing moved the switcher 169px right, which read as the nav
    // re-laying itself out. This is a bound against that, not an ideal: some
    // drift is unavoidable once the bias is capped by the brand.
    const column = (stop: { scale: number; x: number }) => stop.scale * CAMERA.target.x + stop.x;
    const drift = Math.abs(column(cameraStop(true)) - column(cameraStop(false)));
    expect(drift).toBeLessThan(110);
  });
});

describe("activation camera depth and timing", () => {
  it("leaves the far plane alone at rest and moves it a fraction of the push", () => {
    const rest = cameraStop(false).scale;
    const focus = cameraStop(true).scale;

    // At rest the grid must be untouched, or the resting framing changes.
    expect(canvasParallaxScale(rest)).toBeCloseTo(1, 6);

    // A zoom magnifies every plane together; a camera that moves does not. The
    // grid used to sit at 1 through the whole push, which reads as the
    // dashboard sliding over glass.
    const stageMagnification = focus / rest;
    const gridMagnification = canvasParallaxScale(focus);
    expect(gridMagnification).toBeGreaterThan(1);
    expect(gridMagnification).toBeLessThan(stageMagnification);
    expect((gridMagnification - 1) / (stageMagnification - 1)).toBeCloseTo(
      CAMERA.parallax.canvas,
      6,
    );
  });

  it("gives the pull-out more time than the push", () => {
    // A push-in is decisive, a pull-out is a reveal. Equal timings made blurring
    // the field read as the camera snapping back.
    expect(CAMERA.releaseSpring.duration).toBeGreaterThan(CAMERA.spring.duration);
  });

  it("holds the frame lift back so two moves never run at once", () => {
    // The check on the left draws over VERIFY.checkSpring; the lift on the right
    // must start after it, not with it.
    expect(PREVIEW_FRAME.liveDelay).toBeGreaterThan(0);
    expect(PREVIEW_FRAME.liveDelay).toBeLessThan(VERIFY.checkSpring.duration);
  });
});

describe("activation switcher lattice", () => {
  it("frames the switcher rather than sitting somewhere near it", () => {
    // Centred on the same subject the camera pushes toward.
    const centre = SWITCHER_FIELD.x + SWITCHER_FIELD.width / 2;
    expect(centre).toBeCloseTo(CAMERA.target.x, 6);
    // Wider than the 132px switcher, so the lattice reads around the chip.
    expect(SWITCHER_FIELD.width).toBeGreaterThan(132);
  });

  it("puts its bright edge below the switcher, not under it", () => {
    // EmberField is brightest along its bottom edge. If that edge landed inside
    // the switcher's own box the brightest row would be hidden behind a control
    // with a semi-opaque background.
    const switcherBottom = CAMERA.target.y + 15; // half of the 30px control
    expect(SWITCHER_FIELD.y + SWITCHER_FIELD.height).toBeGreaterThan(switcherBottom);
  });

  it("cannot be clipped by the frame's top edge", () => {
    // The switcher sits only 10px into the stage, so a field extending above the
    // stage origin would be cut off rather than fading out.
    expect(SWITCHER_FIELD.y).toBeGreaterThanOrEqual(0);
  });
});
