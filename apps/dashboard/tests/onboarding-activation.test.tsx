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
  ensureProjectWebsite: vi.fn(),
  fetchProjectWebsiteInstallStatus: vi.fn(),
  fetchProjectWebsiteSetup: vi.fn(),
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
  STEP,
  SWITCHER_FIELD,
  TIMING,
  VERIFY,
  cameraStop,
  canvasParallaxScale,
  onboardingAct,
} from "../src/routes/onboarding/onboarding-motion";
import { OnboardingVerifyPage } from "../src/routes/onboarding/onboarding-verify-step";
import {
  readOnboardingRecorderKey,
  saveOnboardingRecorderKey,
} from "../src/routes/onboarding/onboarding-recorder-key";
import {
  activationAllowedOrigins,
  isWebsiteProjectName,
  readWebsiteUrl,
  websitePreviewLabel,
  websitePreviewSource,
  websiteFaviconUrl,
  websiteProjectName,
  websiteUrlError,
} from "../src/routes/onboarding/onboarding-website";
import { OnboardingWebsitePage } from "../src/routes/onboarding/onboarding-website-step";

const PROJECT_ID = "project_abc";
const WEBSITE_ID = "website_abc";
const RAW_KEY = `or_live_${"a".repeat(32)}`;
const SAVED_WEBSITE = new URL("https://saved.example");

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
  window.sessionStorage.clear();
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
    ]);
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

    expect(container.textContent).toContain("Add your website");
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

  it("keeps the visitor on the step and explains a failed write", async () => {
    apiMocks.ensureProjectWebsite.mockRejectedValue(new Error("Network is unreachable."));
    await render(<OnboardingWebsitePage />);

    await setWebsiteInput("https://acme.com");
    await act(async () => {
      findButton("Continue").click();
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Network is unreachable.");
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
  it("pulses a page-shaped skeleton until the first recorder key is ready", async () => {
    const keyRequest = deferred<ReturnType<typeof websiteSetup>>();
    apiMocks.fetchProjectWebsiteSetup.mockReturnValue(keyRequest.promise);
    await render(<OnboardingInstallPage />);

    const reveal = container.querySelector(".onboarding-install-reveal");
    const skeleton = container.querySelector(".t-skel-skeleton.is-pulsing");
    expect(reveal?.getAttribute("data-state")).toBe("loading");
    expect(reveal?.classList.contains("is-revealed")).toBe(false);
    expect(skeleton?.getAttribute("aria-hidden")).toBe("false");
    expect(skeleton?.children).toHaveLength(3);
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
    expect(container.querySelector("pre")?.textContent).toContain("Orange Replay loader");
  });

  it("loads the Website key and copies a snippet that carries it", async () => {
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

  it("retries automatic recorder-key preparation after a request failure", async () => {
    apiMocks.fetchProjectWebsiteSetup
      .mockRejectedValueOnce(new Error("Recorder-key storage is unavailable."))
      .mockResolvedValueOnce(websiteSetup());
    await render(<OnboardingInstallPage />);

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Recorder-key storage is unavailable.");
    });
    await act(async () => {
      findButton("Try again").click();
    });
    await vi.waitFor(() => {
      expect(apiMocks.fetchProjectWebsiteSetup).toHaveBeenCalledTimes(2);
      expect(findButton("I added the snippet").disabled).toBe(false);
    });
  });

  it("reuses the tab's once-readable key after a reload instead of creating another", async () => {
    saveOnboardingRecorderKey(PROJECT_ID, WEBSITE_ID, RAW_KEY);
    await render(<OnboardingInstallPage />);

    expect(apiMocks.fetchProjectWebsiteSetup).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("This project already has a key");
    expect(findButton("I added the snippet").disabled).toBe(false);
    expect(container.querySelector("pre")?.textContent).toContain("Orange Replay loader");
  });
});

describe("activation step 3: verify", () => {
  it("waits on the real install status and does not claim success early", async () => {
    apiMocks.fetchProjectWebsiteInstallStatus.mockResolvedValue({ firstEventAt: null });
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
    saveOnboardingRecorderKey(PROJECT_ID, WEBSITE_ID, RAW_KEY);
    apiMocks.fetchProjectWebsiteInstallStatus.mockResolvedValue({
      firstEventAt: Date.now() - 2_000,
    });
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
    expect(readOnboardingRecorderKey(PROJECT_ID, WEBSITE_ID)).toBeNull();

    await act(async () => {
      findButton("Open your dashboard").click();
    });
    expect(navigate).toHaveBeenCalledWith({
      to: "/projects/$projectId/overview",
      params: { projectId: PROJECT_ID },
      replace: true,
    });
  });

  it("opens the exact project automatically after the connected state is readable", async () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    apiMocks.fetchProjectWebsiteInstallStatus.mockResolvedValue({
      firstEventAt: Date.now() - 2_000,
    });
    await render(<OnboardingVerifyPage />);

    await vi.waitFor(() => {
      expect(container.textContent).toContain("Recorder connected");
    });
    const redirectTimer = setTimeoutSpy.mock.calls.find(
      ([, delay]) => delay === VERIFY.dashboardDelay,
    );
    expect(redirectTimer).toBeDefined();
    await act(async () => {
      const callback = redirectTimer?.[0];
      if (typeof callback === "function") callback();
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
  const [websiteId, setWebsiteId] = useState<string | null>(WEBSITE_ID);
  const [isNaming, setIsNaming] = useState(false);
  const [recording, setRecording] = useState(false);
  namingProject = isNaming;
  isRecordingReported = recording;
  const draftWebsite = readWebsiteUrl(draft);

  return (
    <OnboardingProvider
      value={{
        act: onboardingAct(0, recording),
        direction: 1,
        faviconUrl:
          draftWebsite === null
            ? websiteFaviconUrl(SAVED_WEBSITE)
            : websiteFaviconUrl(draftWebsite),
        isFirstPaint: true,
        isNamingProject: isNaming,
        isRecording: recording,
        previewProjectLabel: "acme.com",
        projectId: PROJECT_ID,
        recorderKey: key,
        savedWebsiteName: SAVED_WEBSITE.hostname,
        setIsNamingProject: setIsNaming,
        setIsRecording: setRecording,
        setRecorderKey: setKey,
        setWebsiteId,
        setWebsiteDraft: setDraft,
        stepIndex: 0,
        websiteDraft: draft,
        websiteId,
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

function websiteSetup() {
  return {
    website: {
      id: WEBSITE_ID,
      name: "acme.com",
      origin: "https://acme.com",
      firstEventAt: null,
    },
    key: projectKeyAudit(),
    secret: RAW_KEY,
    alreadyConnected: false,
  };
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
