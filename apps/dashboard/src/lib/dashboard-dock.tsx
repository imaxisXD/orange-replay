import { createContext, useContext, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// Bottom-anchored chrome (the settings save bar and anything like it) renders
// here instead of inside the scroll area. Two reasons, in order:
//
// 1. The scroll viewport is masked (`scroll-fade`). A backdrop-filter anywhere
//    inside that masked layer makes Chromium paint the whole viewport blank, so
//    a glass scrim has to be a sibling of the scroll area, not a descendant.
// 2. Painted after the viewport, the dock's blur samples the scrolled content
//    beneath it, and it stays pinned to the bottom edge no matter how short the
//    page is — sticky positioning only reaches the end of its own container.
const DashboardDockContext = createContext<HTMLElement | null>(null);

export function DashboardDockHost({ children }: { children: ReactNode }) {
  const [dockNode, setDockNode] = useState<HTMLDivElement | null>(null);

  return (
    <DashboardDockContext.Provider value={dockNode}>
      {children}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30" ref={setDockNode} />
    </DashboardDockContext.Provider>
  );
}

export function DashboardDock({ children }: { children: ReactNode }) {
  const dockNode = useContext(DashboardDockContext);
  if (dockNode === null) return null;
  return createPortal(children, dockNode);
}
