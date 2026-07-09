import type { ComponentType, SVGProps } from "react";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import AlertCircleIcon from "@hugeicons/core-free-icons/AlertCircleIcon";
import ArrowLeft01Icon from "@hugeicons/core-free-icons/ArrowLeft01Icon";
import Cancel01Icon from "@hugeicons/core-free-icons/Cancel01Icon";
import CheckIcon from "@hugeicons/core-free-icons/CheckIcon";
import ChevronRightIcon from "@hugeicons/core-free-icons/ChevronRightIcon";
import CodeIcon from "@hugeicons/core-free-icons/CodeIcon";
import Copy01Icon from "@hugeicons/core-free-icons/Copy01Icon";
import Delete02Icon from "@hugeicons/core-free-icons/Delete02Icon";
import EyeIcon from "@hugeicons/core-free-icons/EyeIcon";
import EyeOffIcon from "@hugeicons/core-free-icons/EyeOffIcon";
import InboxIcon from "@hugeicons/core-free-icons/InboxIcon";
import Key02Icon from "@hugeicons/core-free-icons/Key02Icon";
import RefreshIcon from "@hugeicons/core-free-icons/RefreshIcon";
import Search01Icon from "@hugeicons/core-free-icons/Search01Icon";
import ServerStack01Icon from "@hugeicons/core-free-icons/ServerStack01Icon";

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
export const ArrowLeft = createHugeIcon(ArrowLeft01Icon);
export const Check = createHugeIcon(CheckIcon);
export const ChevronRight = createHugeIcon(ChevronRightIcon);
export const Code2 = createHugeIcon(CodeIcon);
export const Copy = createHugeIcon(Copy01Icon);
export const Eye = createHugeIcon(EyeIcon);
export const EyeOff = createHugeIcon(EyeOffIcon);
export const Inbox = createHugeIcon(InboxIcon);
export const KeyRound = createHugeIcon(Key02Icon);
export const Plus = createHugeIcon(Add01Icon);
export const RotateCcw = createHugeIcon(RefreshIcon);
export const Search = createHugeIcon(Search01Icon);
export const Server = createHugeIcon(ServerStack01Icon);
export const Trash2 = createHugeIcon(Delete02Icon);
export const X = createHugeIcon(Cancel01Icon);
