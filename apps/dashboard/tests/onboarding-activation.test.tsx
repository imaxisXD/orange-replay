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
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));

const apiMocks = vi.hoisted(() => ({
  createProjectKey: vi.fn(),
  fetchInstallStatus: vi.fn(),
  fetchProjectConfig: vi.fn(),
  fetchProjectKeys: vi.fn(),
  renameProject: vi.fn(),
  saveProjectConfig: vi.fn(),
}));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  ...apiMocks,
}));

import { decideProjectsHome } from "../src/lib/dashboard-access";
import {
  ONBOARDING_STEPS,
  OnboardingProvider,
  onboardingProgress,
  onboardingStepIndex,
} from "../src/routes/onboarding/onboarding-context";
import { OnboardingInstallPage } from "../src/routes/onboarding/onboarding-install-step";
import {
  ACT,
  CAMERA,
  PREVIEW_FRAME,
  cameraStop,
  onboardingAct,
} from "../src/routes/onboarding/onboarding-motion";
import { OnboardingVerifyPage } from "../src/routes/onboarding/onboarding-verify-step";
import {
  activationAllowedOrigins,
  isWebsiteProjectName,
  readWebsiteUrl,
  websitePreviewLabel,
  websiteProjectName,
  websiteUrlError,
} from "../src/routes/onboarding/onboarding-website";
import { OnboardingWebsitePage } from "../src/routes/onboarding/onboarding-website-step";

const PROJECT_ID = "project_abc";
const RAW_KEY = `or_live_${"a".repeat(32)}`;

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;
/** Mirrors the harness's camera flag so a test can assert what the shell sees. */
let namingProject: boolean;
/** Mirrors the act flag the verify step reports up to the shell. */
let isRecordingReported: boolean;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  namingProject = false;
  isRecordingReported = false;
  navigate.mockReset();
  for (const mock of Object.values(apiMocks)) mock.mockReset();
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
  document.body.replaceChildren();
});

describe("activation website identity", () => {
  it("accepts only a full http or https address", () => {
    expect(readWebsiteUrl("https://acme.com")?.origin).toBe("https://acme.com");
    expect(readWebsiteUrl("http://localhost:3000")?.origin).toBe("http://localhost:3000");
    expect(readWebsiteUrl("acme.com")).toBeNull();
    expect(readWebsiteUrl("javascript:alert(1)")).toBeNull();
    expect(readWebsiteUrl("  ")).toBeNull();
  });

  it("names the project after the bare hostname", () => {
    expect(websiteProjectName(new URL("https://www.acme.com/pricing"))).toBe("acme.com");
    expect(websiteProjectName(new URL("https://shop.acme.co.uk"))).toBe("shop.acme.co.uk");
  });

  it("allows the typed origin and its www sibling so ingest is not refused", () => {
    expect(activationAllowedOrigins(new URL("https://acme.com"))).toEqual([
      "https://acme.com",
      "https://www.acme.com",
    ]);
    expect(activationAllowedOrigins(new URL("https://www.acme.com"))).toEqual([
      "https://www.acme.com",
      "https://acme.com",
    ]);
    // A port belongs to the origin and must survive on both spellings.
    expect(activationAllowedOrigins(new URL("http://localhost:3000"))).toEqual([
      "http://localhost:3000",
      "http://www.localhost:3000",
    ]);
  });

  it("tracks partial typing for the preview label", () => {
    expect(websitePreviewLabel("", "Your website")).toBe("Your website");
    expect(websitePreviewLabel("https://ac", "Your website")).toBe("ac");
    expect(websitePreviewLabel("https://www.acme.com/x", "Your website")).toBe("acme.com");
  });

  it("recognises an already activated project name", () => {
    expect(isWebsiteProjectName("acme.com")).toBe(true);
    expect(isWebsiteProjectName("Default project")).toBe(false);
  });

  it("rejects a hostname the rename route would refuse, and says why", () => {
    // 100 chars is the project-name limit; a longer host would enable Continue
    // and then dead-end on invalid_project_name.
    const longHost = `https://${"a".repeat(50)}.${"b".repeat(50)}.com`;
    expect(readWebsiteUrl(longHost)).toBeNull();
    expect(websiteUrlError(longHost)).toContain("too long");
    expect(websiteUrlError("acme.com")).toBe("Use a full address, like https://example.com.");
    expect(websiteUrlError("")).toBe("");
    expect(websiteUrlError("https://acme.com")).toBe("");
  });
});

describe("activation step model", () => {
  it("maps each step path to its position in the flow", () => {
    expect(onboardingStepIndex("/onboarding/website")).toBe(0);
    expect(onboardingStepIndex("/onboarding/install/")).toBe(1);
    expect(onboardingStepIndex("/onboarding/verify")).toBe(2);
    expect(onboardingStepIndex("/onboarding")).toBe(0);
    expect(ONBOARDING_STEPS).toHaveLength(3);
  });

  it("reports progress as a fraction of the whole flow", () => {
    expect(onboardingProgress(0)).toBeCloseTo(1 / 3);
    expect(onboardingProgress(2)).toBe(1);
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
});

describe("activation step 1: website", () => {
  it("blocks continuing until the address is usable, then shakes on submit", async () => {
    await render(<OnboardingWebsitePage />);

    expect(container.textContent).toContain("Add your website");
    expect(findButton("Continue").disabled).toBe(true);

    await setWebsiteInput("acme.com");
    expect(findButton("Continue").disabled).toBe(true);

    await act(async () => {
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true }));
    });
    expect(container.textContent).toContain("Use a full address");
    expect(container.querySelector(".onboarding-shake")).not.toBeNull();
    expect(apiMocks.renameProject).not.toHaveBeenCalled();
  });

  it("names the project and opens ingest for both spellings, then moves on", async () => {
    apiMocks.renameProject.mockResolvedValue({ id: PROJECT_ID, name: "acme.com" });
    apiMocks.fetchProjectConfig.mockResolvedValue({
      allowedOrigins: [],
      capture: { heatmaps: false, console: false, network: false, canvas: false },
      jurisdiction: null,
      maskPolicyVersion: 1,
      maskRules: [],
      retentionDays: 30,
      sampleRate: 1,
      version: 1,
    });
    apiMocks.saveProjectConfig.mockResolvedValue({ version: 2 });
    await render(<OnboardingWebsitePage />);

    await setWebsiteInput("https://acme.com");
    expect(findButton("Continue").disabled).toBe(false);
    await act(async () => {
      findButton("Continue").click();
    });

    await vi.waitFor(() => {
      expect(apiMocks.renameProject).toHaveBeenCalledWith(PROJECT_ID, "acme.com");
    });
    await vi.waitFor(() => {
      expect(apiMocks.saveProjectConfig).toHaveBeenCalledWith(
        PROJECT_ID,
        expect.objectContaining({
          allowedOrigins: ["https://acme.com", "https://www.acme.com"],
          expectedVersion: 1,
        }),
      );
    });
    // The allowlist is what lets the project record; the name is cosmetic. It
    // has to land first so a failure between the two cannot leave a project
    // named after the visitor's website yet unable to ingest anything.
    expect(apiMocks.saveProjectConfig.mock.invocationCallOrder[0]).toBeLessThan(
      apiMocks.renameProject.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    await vi.waitFor(() => {
      expect(navigate).toHaveBeenCalledWith({ to: "/onboarding/install" });
    });
  });

  it("keeps the visitor on the step and explains a failed write", async () => {
    apiMocks.fetchProjectConfig.mockRejectedValue(new Error("Network is unreachable."));
    await render(<OnboardingWebsitePage />);

    await setWebsiteInput("https://acme.com");
    await act(async () => {
      findButton("Continue").click();
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Network is unreachable.");
    });
    expect(navigate).not.toHaveBeenCalled();
    // Nothing was renamed, so a failure before the allowlist lands leaves the
    // project exactly as it was rather than half-activated.
    expect(apiMocks.renameProject).not.toHaveBeenCalled();
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
  it("mints the project's first recorder key and copies a snippet that carries it", async () => {
    const writeText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue();
    // Define the one property rather than replacing navigator: spreading it
    // would drop its prototype along with everything else the tree reads.
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    apiMocks.fetchProjectKeys.mockResolvedValue({ keys: [] });
    apiMocks.createProjectKey.mockResolvedValue({
      key: projectKeyAudit(),
      secret: RAW_KEY,
    });
    await render(<OnboardingInstallPage />);

    await vi.waitFor(() => {
      expect(apiMocks.createProjectKey).toHaveBeenCalledWith(PROJECT_ID, "Website recorder");
    });
    await vi.waitFor(() => {
      expect(findButton("I added the snippet").disabled).toBe(false);
    });

    // The card summarises the loader by default, so a 1,800-character minified
    // line does not fill the column — and the raw key is not on screen until
    // asked for. What gets pasted is what must carry the key.
    const collapsed = container.querySelector("pre")?.textContent ?? "";
    expect(collapsed).toContain("Orange Replay loader");
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

    await act(async () => {
      findButton("View full code").click();
    });
    expect(container.querySelector("pre")?.textContent).toContain(RAW_KEY);
  });

  it("retries the request that failed instead of writing when a read failed", async () => {
    // A failed key *list* answered with a key *create* would mint a fresh key on
    // every press and walk the project towards its active-key limit.
    apiMocks.fetchProjectKeys.mockRejectedValue(new Error("Keys are unavailable."));
    await render(<OnboardingInstallPage />);

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Could not check this project's keys");
    });
    await act(async () => {
      findButton("Try again").click();
    });
    expect(apiMocks.createProjectKey).not.toHaveBeenCalled();
    expect(apiMocks.fetchProjectKeys.mock.calls.length).toBeGreaterThan(1);
  });

  it("never mints a second key on its own when one is already active", async () => {
    apiMocks.fetchProjectKeys.mockResolvedValue({ keys: [projectKeyAudit()] });
    await render(<OnboardingInstallPage />);

    await vi.waitFor(() => {
      expect(container.textContent).toContain("This project already has a key");
    });
    expect(apiMocks.createProjectKey).not.toHaveBeenCalled();
    expect(findButton("I added the snippet").disabled).toBe(true);
  });
});

describe("activation step 3: verify", () => {
  it("waits on the real install status and does not claim success early", async () => {
    apiMocks.fetchInstallStatus.mockResolvedValue({ firstEventAt: null });
    await render(<OnboardingVerifyPage />);

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Waiting for the first event");
    });
    expect(container.textContent).not.toContain("Recorder connected");
    expect(container.querySelector(".onboarding-signal")).not.toBeNull();

    await act(async () => {
      findButton("Check again").click();
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("confirms the recorder once an event has arrived and opens the dashboard", async () => {
    apiMocks.fetchInstallStatus.mockResolvedValue({ firstEventAt: Date.now() - 2_000 });
    await render(<OnboardingVerifyPage />);

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Recorder connected");
    });
    expect(container.querySelector("svg path")).not.toBeNull();
    // The step is a route and cannot animate the right pane itself, so the act
    // has to reach the shell or the preview never gets its payoff beat.
    await vi.waitFor(() => {
      expect(isRecordingReported).toBe(true);
    });

    await act(async () => {
      findButton("Open your dashboard").click();
    });
    expect(navigate).toHaveBeenCalledWith({
      to: "/projects/$projectId/overview",
      params: { projectId: PROJECT_ID },
      replace: true,
    });
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
  const [draft, setDraft] = useState("");
  const [key, setKey] = useState<string | null>(null);
  const [isNaming, setIsNaming] = useState(false);
  const [recording, setRecording] = useState(false);
  namingProject = isNaming;
  isRecordingReported = recording;

  return (
    <OnboardingProvider
      value={{
        act: onboardingAct(0, recording),
        direction: 1,
        isFirstPaint: true,
        isNamingProject: isNaming,
        isRecording: recording,
        previewProjectLabel: "acme.com",
        projectId: PROJECT_ID,
        recorderKey: key,
        savedWebsiteName: null,
        setIsNamingProject: setIsNaming,
        setIsRecording: setRecording,
        setRecorderKey: setKey,
        setWebsiteDraft: setDraft,
        stepIndex: 0,
        websiteDraft: draft,
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

function findButton(label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(label),
  );
  if (button === undefined) throw new Error(`No button labelled ${label}.`);
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

describe("activation story acts", () => {
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

describe("activation preview camera", () => {
  it("zooms about the frame's top-left corner, translating nothing", () => {
    const rest = cameraStop(false);
    const focus = cameraStop(true);

    // The corner is the fixed point at both stops. Two earlier attempts added a
    // translate: `y: 120` shoved the header into mid-frame behind empty canvas,
    // and `x: -169` cancelled the subject's drift but cropped the brand.
    expect(rest).toEqual({ scale: CAMERA.overview.scale, x: 0, y: 0 });
    expect(focus).toEqual({ scale: CAMERA.projectFocus.scale, x: 0, y: 0 });
    expect(focus.scale).toBeGreaterThan(rest.scale);
  });

  it("keeps the zoom shallow enough that the dashboard stays a dashboard", () => {
    // Measured off the reference framing two ways (KPI band height, and its
    // four-column pitch): 1.01 CSS. At 1.42 the chrome filled the frame and the
    // page stopped reading as a dashboard.
    expect(cameraStop(true).scale).toBeCloseTo(1.01, 2);
    expect(cameraStop(true).scale).toBeLessThan(1.1);
  });

  it("never crops the dashboard's leading edge at either stop", () => {
    // The brand mark sits ~30px into the stage. A negative x or y would put the
    // brand or the header outside the frame.
    for (const stop of [cameraStop(false), cameraStop(true)]) {
      expect(stop.x).toBeGreaterThanOrEqual(0);
      expect(stop.y).toBeGreaterThanOrEqual(0);
    }
  });

  it("holds the subject's drift well under the swing that read as a slide", () => {
    // The original framing moved the switcher 169px right. Anything near that
    // reads as the nav re-laying itself out rather than as a camera move.
    const column = (stop: { scale: number; x: number }) => stop.scale * CAMERA.target.x + stop.x;
    const drift = Math.abs(column(cameraStop(true)) - column(cameraStop(false)));
    expect(drift).toBeLessThan(70);
  });
});
