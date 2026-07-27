import { createContext, use, type ReactNode } from "react";
import { EmberField } from "@/components/ember-field";
import { DashboardDock } from "@/lib/dashboard-dock";
import type { IconComponent } from "@/lib/icon-map";
import { AnimatePresence, m } from "@/lib/motion";
import { spring } from "@/lib/springs";
import { cn } from "@/lib/utils";

/**
 * Bottom-docked chrome for a pending decision: a full-bleed glass scrim, the
 * LED ember field, and a bar that rises over both. Rendered through the shell's
 * dock slot (see lib/dashboard-dock), so it clears the scroll area and reaches
 * the window edge.
 *
 * Composed rather than configured — the caller owns what sits inside the bar
 * and any layout around it, so a second dock does not need a new prop:
 *
 *   <DockBar open={isDirty}>
 *     <DockBar.Bar>
 *       <DockBar.Status icon={AlertTriangle}>Unsaved changes</DockBar.Status>
 *       <Button variant="ghost">Discard</Button>
 *       <Button>Save changes</Button>
 *     </DockBar.Bar>
 *   </DockBar>
 */
const DockBarContext = createContext<boolean | null>(null);

function useDockBarOpen(): boolean {
  const open = use(DockBarContext);
  if (open === null) throw new Error("DockBar.Bar must render inside a DockBar.");
  return open;
}

// Layer geometry is fixed, so the lattice never re-measures mid-animation.
const EMBER_FADE_PER_ROW = 0.055;
const EMBER_INTENSITY = 2.8;
const EMBER_PULSE = 1.6;

function DockBarRoot({
  accentClassName = "text-amber",
  children,
  open,
}: {
  /** Colours the ember lattice. Amber reads as "needs a decision". */
  accentClassName?: string;
  children: ReactNode;
  open: boolean;
}) {
  return (
    <DashboardDock>
      {/* Separate presences, not one wrapper: each layer animates on its own
          terms (scrim and field fade, the bar rises) and AnimatePresence tracks
          direct children only. */}
      <AnimatePresence>
        {open ? (
          <m.div
            animate={{ opacity: 1 }}
            aria-hidden
            className="dock-scrim"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            transition={spring.moderate}
          />
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {open ? (
          <m.div
            animate={{ opacity: 1 }}
            aria-hidden
            // 3px past the edge because the lattice draws its bottom row a
            // cell-height up from the canvas floor.
            className="pointer-events-none absolute inset-x-0 -bottom-[3px] h-24"
            exit={{ opacity: 0 }}
            initial={{ opacity: 0 }}
            transition={spring.moderate}
          >
            <EmberField
              className={cn("inset-0 h-full w-full", accentClassName)}
              fadePerRow={EMBER_FADE_PER_ROW}
              intensity={EMBER_INTENSITY}
              pulse={EMBER_PULSE}
            />
          </m.div>
        ) : null}
      </AnimatePresence>

      {/* The dock spans the window, so it re-adds the shell's frame inset before
          reproducing main's content column — that is what keeps a bar aligned
          with the content it belongs to. */}
      <div className="px-2 pb-2 sm:px-3 sm:pb-3">
        <div className="mx-auto w-full max-w-300 px-4 pb-5 sm:px-7 sm:pb-6">
          <DockBarContext value={open}>{children}</DockBarContext>
        </div>
      </div>
    </DashboardDock>
  );
}

function DockBarSurface({ children, className }: { children: ReactNode; className?: string }) {
  const open = useDockBarOpen();

  return (
    <AnimatePresence>
      {open ? (
        <m.div
          animate={{ opacity: 1, y: 0 }}
          className={cn(
            "lit dock-bar pointer-events-auto relative flex flex-col gap-3 rounded-lg p-3 sm:flex-row sm:items-center sm:justify-end",
            className,
          )}
          exit={{ opacity: 0, y: 24 }}
          initial={{ opacity: 0, y: 24 }}
          transition={spring.slow}
        >
          {children}
        </m.div>
      ) : null}
    </AnimatePresence>
  );
}

/** The bar's own statement, carrying a card row title's weight so it does not
 *  read as a caption under the buttons it belongs to. */
function DockBarStatus({
  children,
  icon: Icon,
  iconClassName = "text-amber",
}: {
  children: ReactNode;
  icon?: IconComponent;
  iconClassName?: string;
}) {
  return (
    <div className="mr-auto flex items-center gap-2 text-[13px] font-medium whitespace-nowrap">
      {Icon === undefined ? null : (
        <Icon aria-hidden className={cn("shrink-0", iconClassName)} size={14} strokeWidth={1.75} />
      )}
      {children}
    </div>
  );
}

/** Secondary line beside the status, capped so a long message wraps instead of
 *  squeezing the actions. */
function DockBarMessage({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("max-w-[46ch] text-[12px] leading-normal text-pretty", className)}>
      {children}
    </p>
  );
}

export const DockBar = Object.assign(DockBarRoot, {
  Bar: DockBarSurface,
  Message: DockBarMessage,
  Status: DockBarStatus,
});
