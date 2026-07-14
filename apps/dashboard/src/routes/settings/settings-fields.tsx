import type { ReactNode } from "react";
import { InputField, InputGroup } from "@/components/ui/input-group";
import { LoadingArea } from "@/components/ui/loading-indicator";
import { cn } from "@/lib/utils";

export function CardHeader({
  body,
  right,
  title,
}: {
  body: string;
  right?: ReactNode;
  title: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-[15px] font-medium">{title}</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">{body}</p>
      </div>
      {right}
    </div>
  );
}

export function SettingRow({
  children,
  description,
  label,
}: {
  children: ReactNode;
  description: string;
  label: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-dashed border-dash py-2.25 last:border-b-0">
      <div className="min-w-0">
        <div className="text-[13px] font-medium">{label}</div>
        <div className="mt-0.25 text-[11.5px] text-dim">{description}</div>
      </div>
      <div className="flex-none">{children}</div>
    </div>
  );
}

export function NumberWithSuffix({
  ariaLabel,
  max,
  min,
  onChange,
  suffix,
  value,
}: {
  ariaLabel: string;
  max: number;
  min: number;
  onChange: (value: string) => void;
  suffix: string;
  value: string;
}) {
  return (
    <InputGroup className="w-24 gap-0">
      <InputField
        hideLabel
        className="font-mono"
        endContent={<span className="text-[11.5px] text-dim">{suffix}</span>}
        index={0}
        inputMode="decimal"
        label={ariaLabel}
        max={max}
        min={min}
        onChange={onChange}
        style={{ textAlign: "right" }}
        type="number"
        value={value}
      />
    </InputGroup>
  );
}

export function TextInput({
  ariaLabel,
  className,
  mono = false,
  onChange,
  onEnter,
  placeholder,
  value,
}: {
  ariaLabel: string;
  className?: string;
  mono?: boolean;
  onChange: (value: string) => void;
  onEnter?: () => void;
  placeholder: string;
  value: string;
}) {
  return (
    <InputGroup className={cn("w-full gap-0", className)}>
      <InputField
        hideLabel
        className={cn(mono && "font-mono")}
        index={0}
        label={ariaLabel}
        onChange={onChange}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          onEnter?.();
        }}
        placeholder={placeholder}
        value={value}
      />
    </InputGroup>
  );
}

export function SettingsLoading() {
  return <LoadingArea className="lit min-h-80 rounded-lg" label="Loading project settings" />;
}
