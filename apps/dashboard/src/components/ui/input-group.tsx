"use client";

import {
  useRef,
  useState,
  useEffect,
  createContext,
  useContext,
  forwardRef,
  type ReactNode,
  type HTMLAttributes,
  type InputHTMLAttributes,
} from "react";
import { Field } from "@base-ui/react/field";
import type { IconComponent } from "@/lib/icon-map";
import { cn } from "@/lib/utils";
import { fontWeights } from "@/lib/font-weight";
import { useProximityHover } from "@/hooks/use-proximity-hover";

interface InputGroupContextValue {
  registerItem: (index: number, element: HTMLElement | null) => void;
  activeIndex: number | null;
}

const InputGroupContext = createContext<InputGroupContextValue | null>(null);

function useInputGroup() {
  const ctx = useContext(InputGroupContext);
  if (!ctx) throw new Error("useInputGroup must be used within an InputGroup");
  return ctx;
}

interface InputGroupProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

const InputGroup = forwardRef<HTMLDivElement, InputGroupProps>(
  ({ children, className, ...props }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);

    const { activeIndex, handlers, registerItem, measureItems } = useProximityHover(containerRef);

    useEffect(() => {
      measureItems();
    }, [measureItems, children]);

    const contextValue = { registerItem, activeIndex };

    return (
      <InputGroupContext.Provider value={contextValue}>
        <div
          ref={(node) => {
            (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
            if (typeof ref === "function") ref(node);
            else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
          }}
          onMouseEnter={handlers.onMouseEnter}
          onMouseMove={handlers.onMouseMove}
          onMouseLeave={handlers.onMouseLeave}
          // `relative` makes this div the fields' offsetParent — the proximity
          // hook measures items via offsetTop and compares against
          // container-relative mouse coords, so the two coordinate spaces must
          // share this origin (same as every other proximity consumer).
          className={cn("relative flex flex-col gap-3 w-72 max-w-full", className)}
          {...props}
        >
          {children}
        </div>
      </InputGroupContext.Provider>
    );
  },
);

InputGroup.displayName = "InputGroup";

interface InputFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "index"
> {
  label: string;
  placeholder?: string;
  icon?: IconComponent;
  index: number;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  disabled?: boolean;
  className?: string;
  endContent?: ReactNode;
  hideLabel?: boolean;
}

const InputField = forwardRef<HTMLDivElement, InputFieldProps>(
  (
    {
      label,
      placeholder,
      icon: Icon,
      index,
      value,
      onChange,
      error,
      disabled,
      className,
      endContent,
      hideLabel = false,
      ...props
    },
    ref,
  ) => {
    const internalRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLElement | null>(null);
    const { registerItem, activeIndex } = useInputGroup();
    const [isFocused, setIsFocused] = useState(false);

    useEffect(() => {
      registerItem(index, internalRef.current);
      return () => registerItem(index, null);
    }, [index, registerItem]);

    const isActive = activeIndex === index;
    const labelActive = isActive || isFocused;

    const handleFocus = () => {
      setIsFocused(true);
    };

    const handleBlur = () => {
      setIsFocused(false);
    };

    const ringClass = error
      ? isFocused || isActive
        ? "ring-danger/70"
        : "ring-danger/40"
      : isFocused
        ? "ring-amber"
        : "ring-transparent";

    return (
      // Base UI Field wires the accessibility plumbing: Field.Label's htmlFor
      // targets the control, Field.Error's generated id lands in the control's
      // aria-describedby, and `invalid` drives aria-invalid / data-invalid.
      <Field.Root
        ref={(node) => {
          (internalRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
          if (typeof ref === "function") ref(node);
          else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
        }}
        invalid={!!error}
        disabled={disabled}
        className={cn(
          "flex flex-col gap-1 cursor-text",
          disabled && "opacity-50 pointer-events-none",
          className,
        )}
      >
        {/* Label */}
        <Field.Label
          className={cn("inline-grid pl-0 text-[13px] font-medium", hideLabel && "sr-only")}
        >
          <span
            className="col-start-1 row-start-1 invisible"
            style={{ fontVariationSettings: fontWeights.semibold }}
            aria-hidden="true"
          >
            {label}
          </span>
          <span
            className={cn("col-start-1 row-start-1", error ? "text-danger" : "text-foreground")}
            style={{
              fontVariationSettings: fontWeights.normal,
            }}
          >
            {label}
          </span>
        </Field.Label>

        {/* Input container */}
        <div
          role="presentation"
          onMouseDown={(e) => {
            // The old wrapper was one big <label>, so a click anywhere (icon,
            // padding) focused the input. Keep that, without disturbing the
            // input's own caret placement.
            if ((e.target as HTMLElement).closest("button")) return;
            if (e.target === inputRef.current) return;
            e.preventDefault();
            inputRef.current?.focus();
          }}
          className={cn(
            `flex items-center gap-2 rounded-[7px] border bg-secondary px-3 py-1.75 ring-1 transition-[border-color,box-shadow] duration-80`,
            error ? "border-danger/50" : "border-border",
            ringClass,
          )}
        >
          {Icon && (
            <Icon
              size={16}
              strokeWidth={labelActive ? 2 : 1.5}
              className={cn(
                "shrink-0 transition-[color,stroke-width] duration-80",
                labelActive ? "text-foreground" : "text-dim",
              )}
            />
          )}
          <Field.Control
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onFocus={handleFocus}
            onBlur={handleBlur}
            placeholder={placeholder}
            className="w-full bg-transparent text-[12px] text-foreground placeholder:text-dim outline-none font-[inherit]"
            style={{ fontVariationSettings: fontWeights.normal }}
            {...props}
          />
          {endContent}
        </div>

        {/* Error message — `match` pins it visible while our controlled
            `error` prop is standing. */}
        {error && (
          <Field.Error
            match
            className="pl-0 text-[13px] text-danger"
            style={{ fontVariationSettings: fontWeights.medium }}
          >
            {error}
          </Field.Error>
        )}
      </Field.Root>
    );
  },
);

InputField.displayName = "InputField";

export { InputGroup, InputField };
export default InputGroup;
