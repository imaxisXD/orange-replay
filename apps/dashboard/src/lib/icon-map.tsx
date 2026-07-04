import type { ComponentType } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bell,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock,
  Copy,
  CornerDownRight,
  Dot,
  Globe,
  Heart,
  Home,
  ImageIcon,
  Inbox,
  Lightbulb,
  Link,
  Loader,
  Lock,
  Mail,
  Menu,
  MessageCircle,
  Monitor,
  Moon,
  Paintbrush,
  Palette,
  Pause,
  Pencil,
  Pipette,
  Play,
  Plus,
  RectangleHorizontal,
  Rocket,
  RotateCcw,
  Search,
  Settings,
  Shield,
  SkipForward,
  SquareLibrary,
  Star,
  Sun,
  User,
  Users,
  X,
} from "lucide-react";

export interface IconComponentProps {
  className?: string;
  size?: number;
  strokeWidth?: number;
}

export type IconComponent = ComponentType<IconComponentProps>;
export type IconLibrary = "lucide";

export type IconName =
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
  | "copy"
  | "corner-down-right"
  | "dot"
  | "globe"
  | "heart"
  | "home"
  | "image"
  | "inbox"
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
  | "settings"
  | "shield"
  | "skip-forward"
  | "square-library"
  | "star"
  | "sun"
  | "user"
  | "users"
  | "x";

export const iconLibraryOrder: IconLibrary[] = ["lucide"];

export const iconLibraryLabels: Record<IconLibrary, string> = {
  lucide: "Lucide",
};

const lucideMap: Record<IconName, IconComponent> = {
  "arrow-left": ArrowLeft,
  "arrow-right": ArrowRight,
  "arrow-up": ArrowUp,
  bell: Bell,
  brain: Brain,
  check: Check,
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  circle: Circle,
  clock: Clock,
  copy: Copy,
  "corner-down-right": CornerDownRight,
  dot: Dot,
  globe: Globe,
  heart: Heart,
  home: Home,
  image: ImageIcon,
  inbox: Inbox,
  lightbulb: Lightbulb,
  link: Link,
  loader: Loader,
  lock: Lock,
  mail: Mail,
  menu: Menu,
  "message-circle": MessageCircle,
  monitor: Monitor,
  moon: Moon,
  paintbrush: Paintbrush,
  palette: Palette,
  pause: Pause,
  pencil: Pencil,
  pipette: Pipette,
  play: Play,
  plus: Plus,
  "rectangle-horizontal": RectangleHorizontal,
  rocket: Rocket,
  "rotate-ccw": RotateCcw,
  search: Search,
  settings: Settings,
  shield: Shield,
  "skip-forward": SkipForward,
  "square-library": SquareLibrary,
  star: Star,
  sun: Sun,
  user: User,
  users: Users,
  x: X,
};

export const iconMap: Record<IconLibrary, Record<IconName, IconComponent>> = {
  lucide: lucideMap,
};
