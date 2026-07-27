import { useEffect, useRef } from "react";
import { LazyMotion, domAnimation } from "framer-motion";
import { AnimatePresence, m, useReducedMotion } from "@/lib/motion";
import {
  CameraVideo,
  Eye,
  EyeOff,
  Global,
  KeyRound,
  PlayCircle,
  Server,
  Settings,
  ShieldUser,
  type IconComponent,
} from "@/lib/icon-map";
import { spring } from "@/lib/springs";
import { useProximityHover } from "@/hooks/use-proximity-hover";
import { cn } from "@/lib/utils";

export type SettingsSectionId =
  | "capture"
  | "masking"
  | "origins"
  | "keys"
  | "public"
  | "environment";

interface SettingsSection {
  icon: IconComponent;
  id: SettingsSectionId;
  label: string;
}

interface SettingsNavGroup {
  // Distinct hue for the group's heading glyph so the three groups read apart
  // at a glance. A CSS color value, applied inline.
  color: string;
  icon: IconComponent;
  label: string;
  // Non-empty: the group heading is a shortcut to its first section.
  sections: [SettingsSection, ...SettingsSection[]];
}

export const settingsNavGroups: SettingsNavGroup[] = [
  {
    label: "Recording",
    icon: CameraVideo,
    color: "var(--danger)",
    sections: [
      { id: "capture", label: "Capture", icon: PlayCircle },
      { id: "masking", label: "Masking", icon: EyeOff },
      { id: "origins", label: "Allowed origins", icon: Global },
    ],
  },
  {
    label: "Access & sharing",
    icon: ShieldUser,
    color: "var(--player-blue)",
    sections: [
      { id: "keys", label: "Write keys", icon: KeyRound },
      { id: "public", label: "Public page", icon: Eye },
    ],
  },
  {
    label: "System",
    icon: Settings,
    color: "var(--success)",
    sections: [{ id: "environment", label: "Environment", icon: Server }],
  },
];

// Flat, render-order list of every section, so the proximity-hover layer can
// address rows by a single index across group boundaries.
const flatSections: SettingsSection[] = settingsNavGroups.flatMap((group) => group.sections);

/**
 * Left nav for the settings page. Highlighting mirrors the combobox popup
 * (`components/ui/select.tsx`): one absolutely positioned plate marks the
 * selected row, a second slides between rows under the pointer, and both are
 * driven by proximity rather than per-row `:hover` so the pill keeps moving
 * across the gutters and group headings instead of blinking out.
 */
export function SettingsNav({
  active,
  onSelect,
}: {
  active: SettingsSectionId;
  onSelect: (id: SettingsSectionId) => void;
}) {
  const navRef = useRef<HTMLElement>(null);
  const reduce = useReducedMotion();
  const { activeIndex, setActiveIndex, itemRects, sessionKey, handlers, registerItem } =
    useProximityHover(navRef);

  const selectedIndex = flatSections.findIndex((section) => section.id === active);
  const selectedRect = itemRects[selectedIndex];
  const hoverRect = activeIndex !== null ? itemRects[activeIndex] : null;
  const isHoveringOther = activeIndex !== null && activeIndex !== selectedIndex;

  const hoverTransition = reduce ? { duration: 0 } : spring.fast;
  const selectedTransition = reduce ? { duration: 0 } : spring.moderate;

  // Pointer over a group heading resolves to that group's first row. Feeding
  // the row's own center back through the proximity handler (rather than
  // setting the index directly) reuses its rAF, so a still-pending frame from
  // the previous move can't land afterwards and steal the highlight back.
  function handleMouseMove(event: React.MouseEvent) {
    const heading = (event.target as HTMLElement).closest?.("[data-nav-heading-index]");
    const headingIndex = heading?.getAttribute("data-nav-heading-index");

    if (headingIndex != null) {
      const row = navRef.current?.querySelector(`[data-nav-index="${headingIndex}"]`);
      if (row) {
        const rect = row.getBoundingClientRect();
        handlers.onMouseMove({
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        } as React.MouseEvent);
        return;
      }
    }

    handlers.onMouseMove(event);
  }

  return (
    <LazyMotion features={domAnimation}>
      <nav
        aria-label="Settings sections"
        className="relative flex flex-col gap-4 md:sticky md:top-0 md:self-start"
        onBlur={(event) => {
          if (navRef.current?.contains(event.relatedTarget as Node)) return;
          setActiveIndex(null);
        }}
        onFocus={(event) => {
          const target = (event.target as HTMLElement).closest(
            "[data-nav-index],[data-nav-heading-index]",
          );
          const index =
            target?.getAttribute("data-nav-index") ??
            target?.getAttribute("data-nav-heading-index");
          if (index != null) setActiveIndex(Number(index));
        }}
        onMouseEnter={handlers.onMouseEnter}
        onMouseLeave={handlers.onMouseLeave}
        onMouseMove={handleMouseMove}
        ref={navRef}
      >
        {/* Selected plate */}
        {selectedRect && (
          <m.span
            animate={{
              x: selectedRect.left,
              y: selectedRect.top,
              opacity: isHoveringOther ? 0.8 : 1,
            }}
            aria-hidden
            className="absolute left-0 top-0 rounded-lg border border-border bg-surface-4"
            initial={false}
            style={{ height: selectedRect.height, width: selectedRect.width }}
            transition={{ ...selectedTransition, opacity: { duration: 0.08 } }}
          />
        )}

        {/* Hover plate — emerges from the selected row so the first move of a
            hover session reads as the highlight travelling, not appearing. */}
        <AnimatePresence>
          {hoverRect && (
            <m.span
              animate={{ opacity: 1, x: hoverRect.left, y: hoverRect.top }}
              aria-hidden
              className="pointer-events-none absolute left-0 top-0 rounded-lg bg-hover-overlay"
              exit={{ opacity: 0, transition: reduce ? { duration: 0 } : spring.fast.exit }}
              initial={{
                opacity: 0,
                x: selectedRect?.left ?? hoverRect.left,
                y: selectedRect?.top ?? hoverRect.top,
              }}
              key={sessionKey}
              style={{ height: hoverRect.height, width: hoverRect.width }}
              transition={{ ...hoverTransition, opacity: { duration: 0.08 } }}
            />
          )}
        </AnimatePresence>

        {settingsNavGroups.map((group) => {
          const GroupIcon = group.icon;
          const firstSection = group.sections[0];
          const firstIndex = flatSections.indexOf(firstSection);

          return (
            <div className="flex flex-col gap-0.5" key={group.label}>
              {/* The heading is a shortcut into its group: hovering it slides
                  the highlight onto the first row, clicking it selects that
                  row. */}
              <button
                className="group/heading relative flex items-center gap-1.5 rounded px-2.5 pb-1 text-left text-[10.5px] font-medium uppercase tracking-[0.09em] text-dim outline-none transition-colors duration-150 hover:text-muted-foreground focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring)]"
                data-nav-heading-index={firstIndex}
                onClick={() => onSelect(firstSection.id)}
                type="button"
              >
                <GroupIcon aria-hidden size={12} strokeWidth={2} style={{ color: group.color }} />
                {group.label}
              </button>

              {group.sections.map((section) => {
                const index = flatSections.indexOf(section);
                return (
                  <SettingsNavItem
                    index={index}
                    isActive={section.id === active}
                    isHovered={activeIndex === index}
                    key={section.id}
                    onSelect={onSelect}
                    registerItem={registerItem}
                    section={section}
                  />
                );
              })}
            </div>
          );
        })}
      </nav>
    </LazyMotion>
  );
}

function SettingsNavItem({
  index,
  isActive,
  isHovered,
  onSelect,
  registerItem,
  section,
}: {
  index: number;
  isActive: boolean;
  isHovered: boolean;
  onSelect: (id: SettingsSectionId) => void;
  registerItem: (index: number, element: HTMLElement | null) => void;
  section: SettingsSection;
}) {
  const Icon = section.icon;
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    registerItem(index, ref.current);
    return () => registerItem(index, null);
  }, [index, registerItem]);

  return (
    <button
      aria-current={isActive ? "true" : undefined}
      className={cn(
        // ml-3 indents the whole row (highlight + content) beneath its group
        // heading, which stays flush left. z-10 keeps the label above the
        // sliding plates.
        "group relative z-10 ml-3 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] outline-none transition-colors duration-150",
        "focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring)]",
        isActive
          ? "font-medium text-foreground"
          : isHovered
            ? "text-foreground"
            : "text-muted-foreground",
      )}
      data-nav-index={index}
      onClick={() => onSelect(section.id)}
      ref={ref}
      type="button"
    >
      {/* The teal app-icon plate is reserved for the top nav's tabs. Here the
          active glyph simply turns white with the label — no plate, outline, or
          box. The fixed width keeps labels aligned across active/inactive. */}
      <span
        aria-hidden
        className={cn(
          "relative flex w-[18px] shrink-0 items-center justify-center transition-colors",
          isActive ? "text-foreground" : isHovered ? "text-muted-foreground" : "text-dim",
        )}
      >
        <Icon size={15} strokeWidth={1.75} />
      </span>
      <span className="relative">{section.label}</span>
    </button>
  );
}
