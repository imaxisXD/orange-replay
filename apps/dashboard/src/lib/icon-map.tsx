import type { ComponentType, SVGProps } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import AlertCircleIcon from "@hugeicons/core-free-icons/AlertCircleIcon";
import ArrowLeft01Icon from "@hugeicons/core-free-icons/ArrowLeft01Icon";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import CheckIcon from "@hugeicons/core-free-icons/CheckIcon";
import Clock01Icon from "@hugeicons/core-free-icons/Clock01Icon";
import FingerPrintIcon from "@hugeicons/core-free-icons/FingerPrintIcon";
import HashIcon from "@hugeicons/core-free-icons/HashIcon";
import ChevronDownIcon from "@hugeicons/core-free-icons/ChevronDownIcon";
import ChevronRightIcon from "@hugeicons/core-free-icons/ChevronRightIcon";
import ChevronUpIcon from "@hugeicons/core-free-icons/ChevronUpIcon";
import CodeIcon from "@hugeicons/core-free-icons/CodeIcon";
import Copy01Icon from "@hugeicons/core-free-icons/Copy01Icon";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import EyeIcon from "@hugeicons/core-free-icons/EyeIcon";
import EyeOffIcon from "@hugeicons/core-free-icons/EyeOffIcon";
import InboxIcon from "@hugeicons/core-free-icons/InboxIcon";
import InformationCircleIcon from "@hugeicons/core-free-icons/InformationCircleIcon";
import Key02Icon from "@hugeicons/core-free-icons/Key02Icon";
import Loading03Icon from "@hugeicons/core-free-icons/Loading03Icon";
import RefreshIcon from "@hugeicons/core-free-icons/RefreshIcon";
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import ArrowUpRight01Icon from "@hugeicons/core-free-icons/ArrowUpRight01Icon";
import MouseLeftClick06Icon from "@hugeicons/core-free-icons/MouseLeftClick06Icon";
import AngryIcon from "@hugeicons/core-free-icons/AngryIcon";
import AndroidIcon from "@hugeicons/core-free-icons/AndroidIcon";
import AppleFinderIcon from "@hugeicons/core-free-icons/AppleFinderIcon";
import ChromeIcon from "@hugeicons/core-free-icons/ChromeIcon";
import SafariIcon from "@hugeicons/core-free-icons/SafariIcon";
import ServerStack01Icon from "@hugeicons/core-free-icons/ServerStack01Icon";
import SmartPhone01Icon from "@hugeicons/core-free-icons/SmartPhone01Icon";
import WindowsOldIcon from "@hugeicons/core-free-icons/WindowsOldIcon";

export interface IconComponentProps extends Omit<
  SVGProps<SVGSVGElement>,
  "height" | "strokeWidth" | "width"
> {
  size?: number | string;
  strokeWidth?: number | string;
}

export type IconComponent = ComponentType<IconComponentProps>;

function createHugeIcon(icon: IconSvgElement): IconComponent {
  function HugeIcon({ size = 16, strokeWidth = 1.5, ...props }: IconComponentProps) {
    const numericStrokeWidth =
      typeof strokeWidth === "number" ? strokeWidth : Number.parseFloat(strokeWidth);

    return (
      <HugeiconsIcon
        icon={icon}
        size={size}
        strokeWidth={Number.isFinite(numericStrokeWidth) ? numericStrokeWidth : undefined}
        {...props}
      />
    );
  }

  return HugeIcon;
}

export const AlertCircle = createHugeIcon(AlertCircleIcon);
export const Android = createHugeIcon(AndroidIcon);
/** THE rage-click glyph, app-wide, always amber (see docs/design-language.md). */
export const Angry = createHugeIcon(AngryIcon);
export const Chrome = createHugeIcon(ChromeIcon);
export const MacOs = createHugeIcon(AppleFinderIcon);
export const Safari = createHugeIcon(SafariIcon);
export const Windows = createHugeIcon(WindowsOldIcon);

/**
 * Linux has no glyph in the Hugeicons free set; user-approved penguin mark
 * (2026-07-11). Filled path, so strokeWidth is ignored.
 */
export function Linux({ size = 16, strokeWidth: _strokeWidth, ...props }: IconComponentProps) {
  return (
    <svg fill="currentColor" height={size} viewBox="0 0 256 256" width={size} {...props}>
      <path d="M229,214.25A8,8,0,0,1,217.76,213C216.39,211.27,184,169.86,184,88A56,56,0,0,0,72,88c0,81.86-32.37,123.27-33.75,125a8,8,0,0,1-12.51-10c.15-.2,7.69-9.9,15.13-28.74C47.77,156.8,56,127.64,56,88a72,72,0,0,1,144,0c0,39.64,8.23,68.8,15.13,86.28,7.48,18.94,15.06,28.64,15.14,28.74A8,8,0,0,1,229,214.25ZM100,88a12,12,0,1,0,12,12A12,12,0,0,0,100,88Zm68,12a12,12,0,1,0-12,12A12,12,0,0,0,168,100ZM99.58,128.84a8,8,0,0,0-7.15,14.31l32,16a7.94,7.94,0,0,0,7.15,0l32-16a8,8,0,0,0-7.16-14.31L128,143.05ZM128,176a54.07,54.07,0,0,0-47,28.11,8,8,0,1,0,14,7.78,37.35,37.35,0,0,1,66,0,8,8,0,0,0,14-7.78A54.07,54.07,0,0,0,128,176Z" />
    </svg>
  );
}
export const ArrowLeft = createHugeIcon(ArrowLeft01Icon);
export const ArrowUpRight = createHugeIcon(ArrowUpRight01Icon);
export const MousePointer = createHugeIcon(MouseLeftClick06Icon);
export const Smartphone = createHugeIcon(SmartPhone01Icon);
export const Check = createHugeIcon(CheckIcon);
export const ChevronDown = createHugeIcon(ChevronDownIcon);
export const ChevronRight = createHugeIcon(ChevronRightIcon);
export const ChevronUp = createHugeIcon(ChevronUpIcon);
export const Clock = createHugeIcon(Clock01Icon);
export const Fingerprint = createHugeIcon(FingerPrintIcon);
export const Hash = createHugeIcon(HashIcon);
export const Code2 = createHugeIcon(CodeIcon);
export const Copy = createHugeIcon(Copy01Icon);
export const Eye = createHugeIcon(EyeIcon);
export const EyeOff = createHugeIcon(EyeOffIcon);
export const Inbox = createHugeIcon(InboxIcon);
export const Info = createHugeIcon(InformationCircleIcon);
export const KeyRound = createHugeIcon(Key02Icon);
export const Loader = createHugeIcon(Loading03Icon);
export const Plus = createHugeIcon(Add01Icon);
export const RotateCcw = createHugeIcon(RefreshIcon);
export const Search = createHugeIcon(Search01Icon);
export const Server = createHugeIcon(ServerStack01Icon);
export const Trash2 = createHugeIcon(Delete02Icon);
export const X = createHugeIcon(Cancel01Icon);
