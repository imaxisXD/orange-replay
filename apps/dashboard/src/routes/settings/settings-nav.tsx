import { LazyMotion, domMax } from "framer-motion";
import { m } from "@/lib/motion";
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
  sections: SettingsSection[];
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

// Spring shared with the top nav notch: equal-height rows keep the sliding
// active plate a pure translate so it never distorts mid-flight.
const activeTransition = { type: "spring", duration: 0.4, bounce: 0.15 } as const;

export function SettingsNav({
  active,
  onSelect,
}: {
  active: SettingsSectionId;
  onSelect: (id: SettingsSectionId) => void;
}) {
  return (
    <LazyMotion features={domMax}>
      <nav
        aria-label="Settings sections"
        className="flex flex-col gap-4 md:sticky md:top-0 md:self-start"
      >
        {settingsNavGroups.map((group) => {
          const GroupIcon = group.icon;
          return (
            <div className="flex flex-col gap-0.5" key={group.label}>
              <p className="flex items-center gap-1.5 px-2.5 pb-1 text-[10.5px] font-medium uppercase tracking-[0.09em] text-dim">
                <GroupIcon aria-hidden size={12} strokeWidth={2} style={{ color: group.color }} />
                {group.label}
              </p>
              {group.sections.map((section) => (
                <SettingsNavItem
                  isActive={section.id === active}
                  key={section.id}
                  onSelect={onSelect}
                  section={section}
                />
              ))}
            </div>
          );
        })}
      </nav>
    </LazyMotion>
  );
}

function SettingsNavItem({
  isActive,
  onSelect,
  section,
}: {
  isActive: boolean;
  onSelect: (id: SettingsSectionId) => void;
  section: SettingsSection;
}) {
  const Icon = section.icon;

  return (
    <button
      aria-current={isActive ? "true" : undefined}
      className={cn(
        // ml-3 indents the whole pill (highlight + content) beneath its group
        // heading, which stays flush left.
        "group relative ml-3 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors duration-150",
        isActive
          ? "font-medium text-foreground"
          : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
      )}
      onClick={() => onSelect(section.id)}
      type="button"
    >
      {isActive && (
        <m.span
          aria-hidden
          className="absolute inset-0 rounded-lg border border-border bg-surface-4"
          layoutId="settings-nav-active"
          transition={activeTransition}
        />
      )}
      {/* The teal app-icon plate is reserved for the top nav's tabs. Here the
          active glyph simply turns white with the label — no plate, outline, or
          box. The fixed width keeps labels aligned across active/inactive. */}
      <span
        aria-hidden
        className={cn(
          "relative flex w-[18px] shrink-0 items-center justify-center transition-colors",
          isActive ? "text-foreground" : "text-dim group-hover:text-muted-foreground",
        )}
      >
        <Icon size={15} strokeWidth={1.75} />
      </span>
      <span className="relative">{section.label}</span>
    </button>
  );
}
