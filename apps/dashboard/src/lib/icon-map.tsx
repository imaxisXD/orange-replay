import type { ComponentType, SVGProps } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import AlertCircleIcon from "@hugeicons/core-free-icons/AlertCircleIcon";
import AiProgrammingIcon from "@hugeicons/core-free-icons/AiProgrammingIcon";
import ArrowLeft01Icon from "@hugeicons/core-free-icons/ArrowLeft01Icon";
import ArrowExpandIcon from "@hugeicons/core-free-icons/ArrowExpandIcon";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import CheckIcon from "@hugeicons/core-free-icons/CheckIcon";
import Clock01Icon from "@hugeicons/core-free-icons/Clock01Icon";
import ChevronDownIcon from "@hugeicons/core-free-icons/ChevronDownIcon";
import ChevronRightIcon from "@hugeicons/core-free-icons/ChevronRightIcon";
import ChevronUpIcon from "@hugeicons/core-free-icons/ChevronUpIcon";
import CodeIcon from "@hugeicons/core-free-icons/CodeIcon";
import CopyIcon from "@hugeicons/core-free-icons/CopyIcon";
import CopyCheckIcon from "@hugeicons/core-free-icons/CopyCheckIcon";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import Alert01Icon from "@hugeicons/core-free-icons/Alert01Icon";
import MinusSignIcon from "@hugeicons/core-free-icons/MinusSignIcon";
import EyeIcon from "@hugeicons/core-free-icons/EyeIcon";
import EyeOffIcon from "@hugeicons/core-free-icons/EyeOffIcon";
import InboxIcon from "@hugeicons/core-free-icons/InboxIcon";
import InformationCircleIcon from "@hugeicons/core-free-icons/InformationCircleIcon";
import HelpCircleIcon from "@hugeicons/core-free-icons/HelpCircleIcon";
import Key02Icon from "@hugeicons/core-free-icons/Key02Icon";
import RefreshIcon from "@hugeicons/core-free-icons/RefreshIcon";
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import ArrowUpRight01Icon from "@hugeicons/core-free-icons/ArrowUpRight01Icon";
import MouseLeftClick06Icon from "@hugeicons/core-free-icons/MouseLeftClick06Icon";
import MouseScroll01Icon from "@hugeicons/core-free-icons/MouseScroll01Icon";
import Tag01Icon from "@hugeicons/core-free-icons/Tag01Icon";
import AngryIcon from "@hugeicons/core-free-icons/AngryIcon";
import AndroidIcon from "@hugeicons/core-free-icons/AndroidIcon";
import AppleFinderIcon from "@hugeicons/core-free-icons/AppleFinderIcon";
import BrowserIcon from "@hugeicons/core-free-icons/BrowserIcon";
import Calendar03Icon from "@hugeicons/core-free-icons/Calendar03Icon";
import ChromeIcon from "@hugeicons/core-free-icons/ChromeIcon";
import ComputerIcon from "@hugeicons/core-free-icons/ComputerIcon";
import DashboardSquare01Icon from "@hugeicons/core-free-icons/DashboardSquare01Icon";
import FilterIcon from "@hugeicons/core-free-icons/FilterIcon";
import Download01Icon from "@hugeicons/core-free-icons/Download01Icon";
import CameraVideoIcon from "@hugeicons/core-free-icons/CameraVideoIcon";
import LiveStreaming02Icon from "@hugeicons/core-free-icons/LiveStreaming02Icon";
import PlayCircleIcon from "@hugeicons/core-free-icons/PlayCircleIcon";
import Settings01Icon from "@hugeicons/core-free-icons/Settings01Icon";
import ComputerSettingsIcon from "@hugeicons/core-free-icons/ComputerSettingsIcon";
import GlobalIcon from "@hugeicons/core-free-icons/GlobalIcon";
import MapsLocation01Icon from "@hugeicons/core-free-icons/MapsLocation01Icon";
import SafariIcon from "@hugeicons/core-free-icons/SafariIcon";
import ServerStack01Icon from "@hugeicons/core-free-icons/ServerStack01Icon";
import SmartPhone01Icon from "@hugeicons/core-free-icons/SmartPhone01Icon";
import WindowsOldIcon from "@hugeicons/core-free-icons/WindowsOldIcon";
import Building02Icon from "@hugeicons/core-free-icons/Building02Icon";
import GithubIcon from "@hugeicons/core-free-icons/GithubIcon";
import HtmlFile01Icon from "@hugeicons/core-free-icons/HtmlFile01Icon";
import Typescript02Icon from "@hugeicons/core-free-icons/Typescript02Icon";
import LogoutCircle01Icon from "@hugeicons/core-free-icons/LogoutCircle01Icon";
import ShieldUserIcon from "@hugeicons/core-free-icons/ShieldUserIcon";
import UserBlock02Icon from "@hugeicons/core-free-icons/UserBlock02Icon";
import UserGroupIcon from "@hugeicons/core-free-icons/UserGroupIcon";

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
/** A coding agent that can make the installation change on the user's behalf. */
export const CodingAgent = createHugeIcon(AiProgrammingIcon);
export const Android = createHugeIcon(AndroidIcon);
/** THE rage-click glyph, app-wide, always amber (see docs/design-language.md). */
export const Angry = createHugeIcon(AngryIcon);
export const BrowserWindow = createHugeIcon(BrowserIcon);
export const Calendar = createHugeIcon(Calendar03Icon);
export const Chrome = createHugeIcon(ChromeIcon);
export const ComputerSettings = createHugeIcon(ComputerSettingsIcon);
export const Filter = createHugeIcon(FilterIcon);
export const Global = createHugeIcon(GlobalIcon);
export const MacOs = createHugeIcon(AppleFinderIcon);
export const MapLocation = createHugeIcon(MapsLocation01Icon);
export const Monitor = createHugeIcon(ComputerIcon);
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
export const Expand = createHugeIcon(ArrowExpandIcon);
export const ArrowUpRight = createHugeIcon(ArrowUpRight01Icon);
export const MousePointer = createHugeIcon(MouseLeftClick06Icon);
export const MouseScroll = createHugeIcon(MouseScroll01Icon);
export const Tag = createHugeIcon(Tag01Icon);
export const Smartphone = createHugeIcon(SmartPhone01Icon);
export const Check = createHugeIcon(CheckIcon);
export const ChevronDown = createHugeIcon(ChevronDownIcon);
export const ChevronRight = createHugeIcon(ChevronRightIcon);
export const ChevronUp = createHugeIcon(ChevronUpIcon);
export const Clock = createHugeIcon(Clock01Icon);
export const Code2 = createHugeIcon(CodeIcon);
/**
 * The copy → copied pair. `CopyCheck` is `Copy` with one extra path, the tick, so
 * a copy control can add the check without its frame shifting or flickering
 * underneath. That shared geometry is why `Copy` is `CopyIcon` and not the
 * `Copy01` squares it used to be: one copy glyph app-wide, and its checked twin.
 */
export const Copy = createHugeIcon(CopyIcon);
export const CopyCheck = createHugeIcon(CopyCheckIcon);
export const Download = createHugeIcon(Download01Icon);
export const LayoutDashboard = createHugeIcon(DashboardSquare01Icon);
export const LiveStreaming = createHugeIcon(LiveStreaming02Icon);
export const CameraVideo = createHugeIcon(CameraVideoIcon);
export const PlayCircle = createHugeIcon(PlayCircleIcon);
export const Settings = createHugeIcon(Settings01Icon);
export const Eye = createHugeIcon(EyeIcon);
export const EyeOff = createHugeIcon(EyeOffIcon);
export const Inbox = createHugeIcon(InboxIcon);
export const Info = createHugeIcon(InformationCircleIcon);
export const HelpCircle = createHugeIcon(HelpCircleIcon);
export const KeyRound = createHugeIcon(Key02Icon);
export const Plus = createHugeIcon(Add01Icon);
export const Minus = createHugeIcon(MinusSignIcon);
export const RotateCcw = createHugeIcon(RefreshIcon);
/** Unwritten edits exist. AlertCircle stays the error glyph; this triangle is
 *  the softer "needs your attention" mark. */
export const AlertTriangle = createHugeIcon(Alert01Icon);
export const Search = createHugeIcon(Search01Icon);
export const Server = createHugeIcon(ServerStack01Icon);
export const Trash2 = createHugeIcon(Delete02Icon);
export const X = createHugeIcon(Cancel01Icon);
export const Building = createHugeIcon(Building02Icon);
export const Github = createHugeIcon(GithubIcon);
/**
 * File-type marks for the install step's paste target. Same family as every
 * other glyph; the brand colour is applied by the caller through `currentColor`
 * (see docs/design-language.md), so these stay one SVG recoloured per context.
 */
export const HtmlFile = createHugeIcon(HtmlFile01Icon);
export const TypescriptFile = createHugeIcon(Typescript02Icon);
export const LogOut = createHugeIcon(LogoutCircle01Icon);
export const ShieldUser = createHugeIcon(ShieldUserIcon);
export const UserBlock = createHugeIcon(UserBlock02Icon);
export const Users = createHugeIcon(UserGroupIcon);
