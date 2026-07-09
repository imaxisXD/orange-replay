import type { ComponentType, SVGProps } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import AlertCircleIcon from "@hugeicons/core-free-icons/AlertCircleIcon";
import ArrowLeft01Icon from "@hugeicons/core-free-icons/ArrowLeft01Icon";
import ArrowRight01Icon from "@hugeicons/core-free-icons/ArrowRight01Icon";
import ArrowUp01Icon from "@hugeicons/core-free-icons/ArrowUp01Icon";
import BellIcon from "@hugeicons/core-free-icons/BellIcon";
import BrainIcon from "@hugeicons/core-free-icons/BrainIcon";
import BulbIcon from "@hugeicons/core-free-icons/BulbIcon";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import CheckIcon from "@hugeicons/core-free-icons/CheckIcon";
import ChevronDownIcon from "@hugeicons/core-free-icons/ChevronDownIcon";
import ChevronRightIcon from "@hugeicons/core-free-icons/ChevronRightIcon";
import CircleIcon from "@hugeicons/core-free-icons/CircleIcon";
import Clock01Icon from "@hugeicons/core-free-icons/Clock01Icon";
import CodeIcon from "@hugeicons/core-free-icons/CodeIcon";
import ColorsIcon from "@hugeicons/core-free-icons/ColorsIcon";
import ComputerIcon from "@hugeicons/core-free-icons/ComputerIcon";
import Copy01Icon from "@hugeicons/core-free-icons/Copy01Icon";
import CornerDownRightIcon from "@hugeicons/core-free-icons/CornerDownRightIcon";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import DotIcon from "@hugeicons/core-free-icons/DotIcon";
import DropperIcon from "@hugeicons/core-free-icons/DropperIcon";
import EyeIcon from "@hugeicons/core-free-icons/EyeIcon";
import EyeOffIcon from "@hugeicons/core-free-icons/EyeOffIcon";
import Forward02Icon from "@hugeicons/core-free-icons/Forward02Icon";
import GlobeIcon from "@hugeicons/core-free-icons/GlobeIcon";
import HeartIcon from "@hugeicons/core-free-icons/HeartIcon";
import Home01Icon from "@hugeicons/core-free-icons/Home01Icon";
import Image01Icon from "@hugeicons/core-free-icons/Image01Icon";
import InboxIcon from "@hugeicons/core-free-icons/InboxIcon";
import Key02Icon from "@hugeicons/core-free-icons/Key02Icon";
import LibraryIcon from "@hugeicons/core-free-icons/LibraryIcon";
import Link01Icon from "@hugeicons/core-free-icons/Link01Icon";
import Loading03Icon from "@hugeicons/core-free-icons/Loading03Icon";
import LockIcon from "@hugeicons/core-free-icons/LockIcon";
import Mail01Icon from "@hugeicons/core-free-icons/Mail01Icon";
import Menu01Icon from "@hugeicons/core-free-icons/Menu01Icon";
import MessageCircleReplyIcon from "@hugeicons/core-free-icons/MessageCircleReplyIcon";
import Moon01Icon from "@hugeicons/core-free-icons/Moon01Icon";
import PaintBrush01Icon from "@hugeicons/core-free-icons/PaintBrush01Icon";
import PauseIcon from "@hugeicons/core-free-icons/PauseIcon";
import PencilIcon from "@hugeicons/core-free-icons/PencilIcon";
import PlayIcon from "@hugeicons/core-free-icons/PlayIcon";
import RectangleCircleIcon from "@hugeicons/core-free-icons/RectangleCircleIcon";
import RefreshIcon from "@hugeicons/core-free-icons/RefreshIcon";
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import ServerStack01Icon from "@hugeicons/core-free-icons/ServerStack01Icon";
import Settings01Icon from "@hugeicons/core-free-icons/Settings01Icon";
import Shield01Icon from "@hugeicons/core-free-icons/Shield01Icon";
import StarIcon from "@hugeicons/core-free-icons/StarIcon";
import Sun01Icon from "@hugeicons/core-free-icons/Sun01Icon";
import UserIcon from "@hugeicons/core-free-icons/UserIcon";
import UserMultipleIcon from "@hugeicons/core-free-icons/UserMultipleIcon";

export interface IconComponentProps extends Omit<
  SVGProps<SVGSVGElement>,
  "height" | "strokeWidth" | "width"
> {
  size?: number | string;
  strokeWidth?: number | string;
}

export type IconComponent = ComponentType<IconComponentProps>;
export type IconLibrary = "hugeicons";

export type IconName =
  | "alert-circle"
  | "arrow-left"
  | "arrow-right"
  | "arrow-up"
  | "bell"
  | "brain"
  | "check"
  | "chevron-down"
  | "chevron-right"
  | "circle"
  | "clock"
  | "code"
  | "copy"
  | "corner-down-right"
  | "dot"
  | "eye"
  | "eye-off"
  | "globe"
  | "heart"
  | "home"
  | "image"
  | "inbox"
  | "key"
  | "lightbulb"
  | "link"
  | "loader"
  | "lock"
  | "mail"
  | "menu"
  | "message-circle"
  | "monitor"
  | "moon"
  | "paintbrush"
  | "palette"
  | "pause"
  | "pencil"
  | "pipette"
  | "play"
  | "plus"
  | "rectangle-horizontal"
  | "rocket"
  | "rotate-ccw"
  | "search"
  | "server"
  | "settings"
  | "shield"
  | "skip-forward"
  | "square-library"
  | "star"
  | "sun"
  | "trash"
  | "user"
  | "users"
  | "x";

export const iconLibraryOrder: IconLibrary[] = ["hugeicons"];

export const iconLibraryLabels: Record<IconLibrary, string> = {
  hugeicons: "Hugeicons",
};

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

const hugeiconsMap: Record<IconName, IconComponent> = {
  "alert-circle": createHugeIcon(AlertCircleIcon),
  "arrow-left": createHugeIcon(ArrowLeft01Icon),
  "arrow-right": createHugeIcon(ArrowRight01Icon),
  "arrow-up": createHugeIcon(ArrowUp01Icon),
  bell: createHugeIcon(BellIcon),
  brain: createHugeIcon(BrainIcon),
  check: createHugeIcon(CheckIcon),
  "chevron-down": createHugeIcon(ChevronDownIcon),
  "chevron-right": createHugeIcon(ChevronRightIcon),
  circle: createHugeIcon(CircleIcon),
  clock: createHugeIcon(Clock01Icon),
  code: createHugeIcon(CodeIcon),
  copy: createHugeIcon(Copy01Icon),
  "corner-down-right": createHugeIcon(CornerDownRightIcon),
  dot: createHugeIcon(DotIcon),
  eye: createHugeIcon(EyeIcon),
  "eye-off": createHugeIcon(EyeOffIcon),
  globe: createHugeIcon(GlobeIcon),
  heart: createHugeIcon(HeartIcon),
  home: createHugeIcon(Home01Icon),
  image: createHugeIcon(Image01Icon),
  inbox: createHugeIcon(InboxIcon),
  key: createHugeIcon(Key02Icon),
  lightbulb: createHugeIcon(BulbIcon),
  link: createHugeIcon(Link01Icon),
  loader: createHugeIcon(Loading03Icon),
  lock: createHugeIcon(LockIcon),
  mail: createHugeIcon(Mail01Icon),
  menu: createHugeIcon(Menu01Icon),
  "message-circle": createHugeIcon(MessageCircleReplyIcon),
  monitor: createHugeIcon(ComputerIcon),
  moon: createHugeIcon(Moon01Icon),
  paintbrush: createHugeIcon(PaintBrush01Icon),
  palette: createHugeIcon(ColorsIcon),
  pause: createHugeIcon(PauseIcon),
  pencil: createHugeIcon(PencilIcon),
  pipette: createHugeIcon(DropperIcon),
  play: createHugeIcon(PlayIcon),
  plus: createHugeIcon(Add01Icon),
  "rectangle-horizontal": createHugeIcon(RectangleCircleIcon),
  rocket: createHugeIcon(ArrowUp01Icon),
  "rotate-ccw": createHugeIcon(RefreshIcon),
  search: createHugeIcon(Search01Icon),
  server: createHugeIcon(ServerStack01Icon),
  settings: createHugeIcon(Settings01Icon),
  shield: createHugeIcon(Shield01Icon),
  "skip-forward": createHugeIcon(Forward02Icon),
  "square-library": createHugeIcon(LibraryIcon),
  star: createHugeIcon(StarIcon),
  sun: createHugeIcon(Sun01Icon),
  trash: createHugeIcon(Delete02Icon),
  user: createHugeIcon(UserIcon),
  users: createHugeIcon(UserMultipleIcon),
  x: createHugeIcon(Cancel01Icon),
};

export const iconMap: Record<IconLibrary, Record<IconName, IconComponent>> = {
  hugeicons: hugeiconsMap,
};

export const AlertCircle = hugeiconsMap["alert-circle"];
export const ArrowLeft = hugeiconsMap["arrow-left"];
export const Check = hugeiconsMap.check;
export const ChevronRight = hugeiconsMap["chevron-right"];
export const Code2 = hugeiconsMap.code;
export const Copy = hugeiconsMap.copy;
export const Eye = hugeiconsMap.eye;
export const EyeOff = hugeiconsMap["eye-off"];
export const Inbox = hugeiconsMap.inbox;
export const KeyRound = hugeiconsMap.key;
export const Plus = hugeiconsMap.plus;
export const RotateCcw = hugeiconsMap["rotate-ccw"];
export const Search = hugeiconsMap.search;
export const Server = hugeiconsMap.server;
export const Trash2 = hugeiconsMap.trash;
export const X = hugeiconsMap.x;
