import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { LazyMotion, domMax } from "framer-motion";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { BrandMark } from "@/components/brand-mark";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { accountQueryKey, fetchAccount } from "@/lib/api";
import {
  canManageProject,
  findAccountProject,
  readDashboardAccess,
  readDashboardAccessError,
  signOutDashboardAccess,
} from "@/lib/dashboard-access";
import { DashboardDockHost } from "@/lib/dashboard-dock";
import { getDashboardEnvironmentLabel } from "@/lib/dashboard-environment";
import { ShieldUser } from "@/lib/icon-map";
import { dashboardNavItems, type DashboardNavItem } from "@/lib/dashboard-navigation";
import { useDashboardWorkspace } from "@/lib/dashboard-workspace";
import { m, useReducedMotion, type HTMLMotionProps } from "@/lib/motion";
import { carriedDateRangeSearch } from "@/lib/session-filters";
import { surfaceClasses } from "@/lib/surface-classes";
import { SurfaceProvider } from "@/lib/surface-context";
import { cn } from "@/lib/utils";
import { WorkspaceSwitcher } from "./workspace-switcher";

const DASHBOARD_SURFACE_LEVEL = 2;
const WORKSPACE_WIDTH_ANIMATION = {
  duration: 180,
} as const;

export function AppShell({
  children,
  navigationPathname,
  projectLabel,
  projectLeadingContent,
  rootClassName,
  showAccountAvatar = true,
  workspaceKey,
  workspaceMotion,
  workspaceOverlay,
}: {
  children?: ReactNode;
  navigationPathname?: string;
  /** Overrides the project switcher's label. Activation types a website name
   *  into the switcher before the rename is saved, so the preview follows the
   *  field instead of the account response. */
  projectLabel?: string;
  /** Optional visual identity before the project label. */
  projectLeadingContent?: ReactNode;
  /** Replaces root sizing so the shell can be framed inside a fixed-size
   *  preview stage instead of the viewport. */
  rootClassName?: string;
  showAccountAvatar?: boolean;
  workspaceKey?: number | string;
  workspaceMotion?: HTMLMotionProps<"div">;
  workspaceOverlay?: ReactNode;
}) {
  const { projectId, isDemo } = useDashboardWorkspace();
  const environmentLabel = getDashboardEnvironmentLabel(
    isDemo,
    import.meta.env.VITE_DASHBOARD_ENVIRONMENT,
  );
  const navigate = useNavigate();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const activeAccess = readDashboardAccess(isDemo ? "demo" : "private");
  const accountQuery = useQuery({
    queryKey: accountQueryKey,
    queryFn: fetchAccount,
    enabled: activeAccess.needsAccount,
    staleTime: 30_000,
  });
  const account = accountQuery.data;
  const activeProject = findAccountProject(account, projectId);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const selectedSession = useRouterState({
    select: (state) => (state.location.search as { selected?: string }).selected,
  });
  // Every screen keeps the design language's centered 1200px column. The sessions
  // triage expands to the wide column only while a session is selected because the
  // replay player needs the room. The expansion is animated so it reads as the
  // player making room rather than a layout glitch.
  const wideMain = /\/sessions\/?$/.test(pathname) && selectedSession !== undefined;
  const mainRef = useWorkspaceWidthAnimation(wideMain);

  async function handleLogout(): Promise<void> {
    setIsSigningOut(true);
    setSignOutError("");
    try {
      await signOutDashboardAccess();
      void navigate({ to: "/login", replace: true });
    } catch (error) {
      setSignOutError(readDashboardAccessError(error, "Could not sign out. Try again."));
    }
    setIsSigningOut(false);
  }

  const workspaceContent = (
    <>
      <ScrollArea orientation="horizontal" viewportClassName="scroll-fade-x" viewportTabIndex={-1}>
        <TopNav
          isDemo={isDemo}
          items={dashboardNavItems(isDemo, canManageProject(activeProject))}
          pathnameOverride={navigationPathname}
          projectId={projectId}
        />
      </ScrollArea>

      <ScrollArea className="min-h-0 flex-1" viewportClassName="scroll-fade" viewportTabIndex={-1}>
        <main
          className={cn(
            "dashboard-main mx-auto w-full min-w-0 max-w-full px-4 py-5 sm:px-7 sm:py-6",
            wideMain ? "max-w-475" : "max-w-300",
          )}
          ref={mainRef}
        >
          {children ?? <Outlet />}
        </main>
      </ScrollArea>
    </>
  );

  return (
    <div className={cn("flex h-screen flex-col overflow-hidden text-foreground", rootClassName)}>
      <header className="z-40 shrink-0">
        <ScrollArea
          orientation="horizontal"
          viewportClassName="scroll-fade-x"
          viewportTabIndex={-1}
        >
          <nav className="flex min-w-0 items-center gap-2 px-4 pt-2.5 pb-4 sm:gap-3.5 sm:px-7">
            <Link
              className="flex min-w-0 shrink items-center gap-2.5 text-[14px] font-semibold tracking-[-0.01em] text-foreground"
              {...(isDemo
                ? { to: "/demo/overview" as const }
                : { params: { projectId }, to: "/projects/$projectId/overview" as const })}
            >
              <BrandMark />
              <span className="truncate">Orange Replay</span>
            </Link>

            <span className="text-divider">/</span>

            <WorkspaceSwitcher
              account={account}
              isDemo={isDemo}
              projectId={projectId}
              projectLabel={projectLabel}
              projectLeadingContent={projectLeadingContent}
            />

            <Badge color="amber" size="sm">
              {environmentLabel}
            </Badge>

            <div className="ml-auto flex min-w-0 shrink-0 items-center gap-2 sm:gap-4">
              {!isDemo && account?.isAdmin === true && (
                <Button asChild leadingIcon={ShieldUser} size="sm" variant="ghost">
                  <Link to="/_admin">Operator</Link>
                </Button>
              )}
              {!isDemo && (
                <div className="flex items-center gap-2">
                  {signOutError.length > 0 && (
                    <p className="max-w-48 text-right text-[11.5px] text-danger" role="alert">
                      {signOutError}
                    </p>
                  )}
                  <Button
                    className="h-auto px-0 py-0 text-[12.5px] text-muted-foreground hover:text-foreground"
                    loading={isSigningOut}
                    onClick={() => void handleLogout()}
                    variant="ghost"
                  >
                    Sign out
                  </Button>
                </div>
              )}
              {showAccountAvatar &&
                (isDemo ? (
                  <span
                    aria-hidden="true"
                    className="size-6.5 rounded-full border border-border bg-[linear-gradient(135deg,var(--teal-soft),var(--teal))]"
                  />
                ) : (
                  <AccountAvatar image={account?.user.image} name={account?.user.name} />
                ))}
            </div>
          </nav>
        </ScrollArea>
      </header>

      {/* The dock host sits beside the workspace card, not inside it: the card
          clips to its rounded corners, which would hold bottom-anchored chrome
          12px short of the window edge. Absolute insets ignore this frame's
          padding, so the dock reaches the true bottom and full width. */}
      <div className="relative min-h-0 flex-1 px-2 pb-2 sm:px-3 sm:pb-3">
        <DashboardDockHost>
          <SurfaceProvider value={DASHBOARD_SURFACE_LEVEL}>
            <m.div
              key={workspaceKey}
              {...workspaceMotion}
              className={cn(
                "flex h-full min-h-0 flex-col overflow-hidden rounded-xl",
                surfaceClasses(DASHBOARD_SURFACE_LEVEL),
                // The demo notch overflows into the project-header row. Lift the
                // transformed workspace layer above that transparent header so
                // the notch CTA can receive pointer events. On a narrow screen
                // the notch stays inside the card, so the header keeps its row.
                workspaceOverlay !== undefined && "relative z-50 max-sm:overflow-hidden",
                workspaceMotion?.className,
              )}
            >
              {workspaceOverlay === undefined ? (
                workspaceContent
              ) : (
                <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl max-sm:pt-[42px]">
                  {workspaceContent}
                </div>
              )}
              {workspaceOverlay}
            </m.div>
          </SurfaceProvider>
        </DashboardDockHost>
      </div>
    </div>
  );
}

function AccountAvatar({ image, name }: { image?: string | null; name?: string }) {
  const [imageFailed, setImageFailed] = useState(false);
  const initials = readInitials(name);

  if (image !== undefined && image !== null && image.length > 0 && !imageFailed) {
    return (
      <img
        alt={name === undefined ? "Account" : name}
        className="size-6.5 rounded-full border border-border bg-secondary object-cover"
        onError={() => setImageFailed(true)}
        referrerPolicy="no-referrer"
        src={image}
      />
    );
  }

  return (
    <span
      aria-label={name === undefined ? "Account" : name}
      className="flex size-6.5 items-center justify-center rounded-full border border-border bg-[linear-gradient(135deg,var(--teal-soft),var(--teal))] text-[10px] font-semibold text-background"
      role="img"
    >
      {initials}
    </span>
  );
}

function readInitials(name: string | undefined): string {
  if (name === undefined || name.trim().length === 0) return "OR";
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

function resolveNavPath(item: DashboardNavItem, isDemo: boolean, projectId: string): string {
  const demoTo = isDemo ? item.demoTo : undefined;
  return demoTo ?? item.projectTo.replace("$projectId", projectId);
}

function TopNav({
  isDemo,
  items,
  pathnameOverride,
  projectId,
}: {
  isDemo: boolean;
  items: DashboardNavItem[];
  pathnameOverride?: string;
  projectId: string;
}) {
  const currentPathname = useRouterState({ select: (state) => state.location.pathname });
  const pathname = pathnameOverride ?? currentPathname;
  const normalizedPathname = pathname.replace(/\/+$/, "");
  const activeIndex = items.findIndex((item) => {
    const resolvedPath = resolveNavPath(item, isDemo, projectId);
    return normalizedPathname === resolvedPath || normalizedPathname.startsWith(`${resolvedPath}/`);
  });

  return (
    <LazyMotion features={domMax}>
      {/* 6px inset on top and sides + 6px tab radius nests concentrically inside
          the container's 12px corner (outer radius = inner radius + gap). */}
      <nav className="flex min-w-0 items-end gap-1 border-b border-border px-1.5 pt-1.5">
        {items.map((item, index) => (
          <TopNavTab
            isActive={index === activeIndex}
            isDemo={isDemo}
            item={item}
            key={item.label}
            projectId={projectId}
          />
        ))}
      </nav>
    </LazyMotion>
  );
}

// Spring timing shared with the tab lab's V1 preview; equal-width tabs keep the
// layout animation a pure translate, so the notch never distorts mid-flight.
const notchTransition = { type: "spring", duration: 0.45, bounce: 0.15 } as const;

function TopNavTab({
  isActive,
  isDemo,
  item,
  projectId,
}: {
  isActive: boolean;
  isDemo: boolean;
  item: DashboardNavItem;
  projectId: string;
}) {
  const demoTo = isDemo ? item.demoTo : undefined;
  const Icon = item.icon;
  // The notch travels the whole row between two tabs. A click is its own
  // confirmation, so reduced motion gets the destination and not the journey —
  // and onboarding drives this same notch across five tabs without a click at
  // all, which is a long unrequested flight to hand someone who asked for none.
  const reduceMotion = useReducedMotion() === true;

  const className = cn(
    "relative -mb-px flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-t-md px-1 py-2.75 text-[13px] text-muted-foreground transition-[color,background-color,gap,font-weight] duration-200 sm:w-28 sm:flex-none sm:gap-2 sm:px-0 sm:py-2.25",
    isActive
      ? "text-[14px] font-medium text-foreground"
      : "hover:gap-2.5 hover:bg-secondary/60 hover:font-medium hover:text-foreground",
  );

  const content = (
    <>
      {isActive && (
        <m.span
          aria-hidden
          className="absolute inset-x-0 -bottom-px top-0 rounded-t-md border border-b-0 border-border bg-surface-4"
          layoutId="top-nav-notch"
          transition={reduceMotion ? { duration: 0 } : notchTransition}
        />
      )}
      {/* Active icon sits on an app-icon plate: deep teal rounded square
          with a lighter rim, dark glyph, soft bloom — the dock-icon glow in the
          calm accent (local tab lab colorway C2, user-tuned darker
          2026-07-18). Inactive tabs keep the same box so labels never shift. */}
      <span
        aria-hidden
        className={cn(
          "relative flex size-[17px] shrink-0 items-center justify-center rounded-[5px]",
          isActive &&
            "bg-[linear-gradient(160deg,color-mix(in_oklab,var(--teal)_92%,black),color-mix(in_oklab,var(--teal)_74%,black))] text-background shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--teal)_70%,white),0_0_8px_-1px_color-mix(in_oklab,var(--teal)_70%,transparent)]",
        )}
      >
        <Icon size={12} strokeWidth={1.75} />
      </span>
      <span className="relative truncate">{item.label}</span>
    </>
  );

  // The date range is dashboard state: tab switches carry an explicit
  // from/to window and drop every page-local search key.
  if (demoTo !== undefined) {
    return (
      <Link
        aria-current={isActive ? "page" : undefined}
        className={className}
        search={carriedDateRangeSearch}
        to={demoTo}
      >
        {content}
      </Link>
    );
  }

  return (
    <Link
      aria-current={isActive ? "page" : undefined}
      className={className}
      params={{ projectId }}
      search={carriedDateRangeSearch}
      to={item.projectTo}
    >
      {content}
    </Link>
  );
}

function useWorkspaceWidthAnimation(isWide: boolean) {
  const mainRef = useRef<HTMLElement>(null);
  const previousWidthRef = useRef<number>(undefined);
  const interruptedWidthRef = useRef<number>(undefined);
  const stopAnimationRef = useRef<(() => void) | undefined>(undefined);

  useLayoutEffect(() => {
    const main = mainRef.current;
    if (main === null) return;

    const nextWidth = main.offsetWidth;
    const previousWidth = previousWidthRef.current;
    previousWidthRef.current = nextWidth;
    const currentAnimation = stopAnimationRef.current;
    const visibleWidth =
      interruptedWidthRef.current ??
      (currentAnimation === undefined || previousWidth === undefined
        ? previousWidth
        : previousWidth * readHorizontalScale(getComputedStyle(main).transform));
    interruptedWidthRef.current = undefined;
    currentAnimation?.();

    const animationAllowed = window.matchMedia(
      "(min-width: 1024px) and (prefers-reduced-motion: no-preference)",
    ).matches;
    if (
      !animationAllowed ||
      previousWidth === undefined ||
      previousWidth <= 0 ||
      nextWidth <= 0 ||
      visibleWidth === undefined
    ) {
      return;
    }

    const startingScale = visibleWidth / nextWidth;
    if (Math.abs(startingScale - 1) < 0.01) return;

    main.style.setProperty("--workspace-width-start-scale", String(startingScale));
    // Reading the width between removing and adding the class restarts the CSS
    // keyframes when users quickly move back and forth.
    void main.offsetWidth;
    main.classList.add("dashboard-main-width-moving");

    let cleanupTimer: number | undefined;
    const stopAnimation = () => {
      main.removeEventListener("animationcancel", finishAnimation);
      main.removeEventListener("animationend", finishAnimation);
      main.classList.remove("dashboard-main-width-moving");
      main.style.removeProperty("--workspace-width-start-scale");
      if (cleanupTimer !== undefined) window.clearTimeout(cleanupTimer);
      if (stopAnimationRef.current === stopAnimation) stopAnimationRef.current = undefined;
    };
    const finishAnimation = (event: AnimationEvent) => {
      if (event.target !== main || event.animationName !== "dashboard-main-width") return;
      stopAnimation();
    };
    main.addEventListener("animationcancel", finishAnimation);
    main.addEventListener("animationend", finishAnimation);
    cleanupTimer = window.setTimeout(stopAnimation, WORKSPACE_WIDTH_ANIMATION.duration + 50);
    stopAnimationRef.current = stopAnimation;

    return () => {
      if (stopAnimationRef.current === stopAnimation) {
        interruptedWidthRef.current =
          nextWidth * readHorizontalScale(getComputedStyle(main).transform);
      }
      stopAnimation();
    };
  }, [isWide]);

  return mainRef;
}

function readHorizontalScale(transform: string): number {
  if (transform === "none") return 1;
  const firstValue = transform
    .slice(transform.indexOf("(") + 1, transform.lastIndexOf(")"))
    .split(",")[0];
  const scale = Number.parseFloat(firstValue ?? "");
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}
