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
        <h2 className="text-[15px] font-medium leading-tight">{title}</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">{body}</p>
      </div>
      {right}
    </div>
  );
}

/**
 * Every settings card is a `.lit` card whose heading and body sit on the card
 * itself, with the controls in an inset panel — the Public page card's shape,
 * applied across Settings. The panel is one step up the surface ladder from the
 * card it sits on (`--surface-3` is `--popover`, which `bg-secondary` also
 * resolves to), held at 45% so the card's grain still reads through it.
 */
export function SettingsCard({
  body,
  children,
  className,
  header,
  right,
  title,
}: {
  body: string;
  children: ReactNode;
  className?: string;
  /** Extra content between the heading and the panel, such as an alert. */
  header?: ReactNode;
  right?: ReactNode;
  title: string;
}) {
  return (
    <section className="lit rounded-lg p-5">
      <CardHeader body={body} right={right} title={title} />
      {header}
      <div
        className={cn(
          "mt-4 divide-y divide-border rounded-lg border border-border bg-surface-3/45",
          className,
        )}
      >
        {children}
      </div>
    </section>
  );
}

/** A row inside a `SettingsCard` panel. The panel's `divide-y` draws the rule
 *  between rows, so the row itself only owns its padding. */
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
    <div className="flex items-center justify-between gap-4 px-4 py-3.5">
      <div className="min-w-0">
        <div className="text-[13px] font-medium">{label}</div>
        <div className="mt-1 text-[12px] leading-normal text-muted-foreground">{description}</div>
      </div>
      <div className="flex-none">{children}</div>
    </div>
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
