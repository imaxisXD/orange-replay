"use client";

import {
  cloneElement,
  forwardRef,
  isValidElement,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type Ref,
} from "react";
import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cva, type VariantProps } from "class-variance-authority";
import type { IconComponent } from "@/lib/icon-map";
import { cn } from "@/lib/utils";
import { useShape } from "@/lib/shape-context";

const buttonVariants = cva(
  [
    "group relative isolate inline-flex items-center justify-center outline-none cursor-pointer",
    "rounded-lg transition-colors duration-100",
    "disabled:opacity-50 disabled:pointer-events-none",
    "focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring)]",
  ],
  {
    variants: {
      variant: {
        primary: "font-semibold text-background",
        secondary: "border border-border text-foreground font-medium",
        tertiary: "border border-border text-foreground font-medium",
        ghost: "text-muted-foreground hover:text-foreground",
      },
      size: {
        sm: "h-8 px-3.25 text-[12.5px] gap-1.5",
        md: "h-8 px-3.25 text-[12.5px] gap-1.5",
        lg: "h-9 px-5 text-[13px] gap-1.5",
        // before:* extends the pointer target to a 40px hit area without
        // enlarging the visual box (disabled:pointer-events-none covers the
        // pseudo-element too, since it's set on the root).
        "icon-sm":
          "h-8 w-8 p-0 [&_svg]:h-3.5 [&_svg]:w-3.5 before:absolute before:content-[''] before:-inset-1",
        icon: "h-9 w-9 p-0 [&_svg]:h-4 [&_svg]:w-4 before:absolute before:content-[''] before:-inset-0.5",
        "icon-lg": "h-10 w-10 p-0 [&_svg]:h-5 [&_svg]:w-5",
      },
      iconLeft: { true: "" },
      iconRight: { true: "" },
    },
    compoundVariants: [
      { size: "sm", iconLeft: true, className: "pl-1.5" },
      { size: "md", iconLeft: true, className: "pl-2.5" },
      { size: "lg", iconLeft: true, className: "pl-3.5" },
      { size: "sm", iconRight: true, className: "pr-1.5" },
      { size: "md", iconRight: true, className: "pr-2.5" },
      { size: "lg", iconRight: true, className: "pr-3.5" },
    ],
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
  leadingIcon?: IconComponent;
  trailingIcon?: IconComponent;
  /** Force the visual pressed/held state. Useful when the button drives an
   *  external open piece of UI (a popover, dropdown, etc.) so it reads as
   *  engaged while the menu is showing. */
  active?: boolean;
}

const bgVariants: Record<string, string> = {
  primary: "bg-foreground group-hover:bg-foreground/90 group-active:bg-foreground/80",
  secondary: "bg-card group-hover:bg-hover group-active:bg-active",
  tertiary: "bg-card group-hover:bg-hover group-active:bg-active",
  ghost: "bg-transparent",
};

const activeBgVariants: Record<string, string> = {
  primary: "bg-foreground/80",
  secondary: "bg-active",
  tertiary: "bg-active",
  ghost: "bg-transparent",
};

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      loading = false,
      leadingIcon: LeadingIcon,
      trailingIcon: TrailingIcon,
      active = false,
      disabled,
      children,
      style,
      ...props
    },
    ref,
  ) => {
    // asChild: the user's element becomes the root while the button's internal
    // structure survives as its children. Fluid's Base UI version clones links
    // directly so they keep link semantics instead of receiving button roles.
    const asChildElement =
      asChild && isValidElement(children)
        ? (children as ReactElement<{
            children?: ReactNode;
            className?: string;
            style?: CSSProperties;
            ref?: Ref<HTMLButtonElement>;
          }>)
        : null;
    const label = asChildElement ? asChildElement.props.children : children;
    const isIconOnly = size === "icon" || size === "icon-sm" || size === "icon-lg";
    const iconSize = size === "sm" ? 14 : size === "lg" ? 20 : 16;
    // Spinner box tracks the button height (sm is h-7, lg/icon are h-9, …) so
    // the loading glyph stays proportionate across sizes.
    const spinnerSizeClass =
      size === "sm"
        ? "h-7 w-7"
        : size === "lg" || size === "icon"
          ? "h-9 w-9"
          : size === "icon-lg"
            ? "h-10 w-10"
            : "h-8 w-8";
    const shape = useShape();
    const bgClass = active
      ? activeBgVariants[variant ?? "primary"]
      : bgVariants[variant ?? "primary"];

    const internals = (
      <>
        <span
          aria-hidden
          className={cn(
            "absolute inset-0 rounded-[inherit] transition-[background-color,transform] duration-80 group-active:scale-[0.96]",
            bgClass,
          )}
        />
        <span className="relative inline-flex items-center justify-center gap-[inherit]">
          {loading ? (
            <>
              <span className="flex items-center justify-center gap-[inherit] opacity-0">
                {LeadingIcon && !isIconOnly && <LeadingIcon size={iconSize} strokeWidth={2} />}
                {label}
                {TrailingIcon && !isIconOnly && <TrailingIcon size={iconSize} strokeWidth={2} />}
              </span>
              <span className="absolute inset-0 flex items-center justify-center">
                <svg className={spinnerSizeClass} viewBox="0 0 24 24" fill="none">
                  <path
                    d="M 12 12 C 14 8.5 19 8.5 19 12 C 19 15.5 14 15.5 12 12 C 10 8.5 5 8.5 5 12 C 5 15.5 10 15.5 12 12 Z"
                    stroke="currentColor"
                    strokeWidth="1.125"
                    strokeLinecap="round"
                    pathLength="100"
                    style={{
                      strokeDasharray: "15 85",
                      animation:
                        "spinner-move 2s linear infinite, spinner-dash 4s ease-in-out infinite",
                    }}
                  />
                </svg>
              </span>
            </>
          ) : isIconOnly ? (
            <span className="[&_svg]:stroke-[1.5] [&_svg]:transition-[stroke-width] [&_svg]:duration-80 group-hover:[&_svg]:stroke-[2]">
              {label}
            </span>
          ) : (
            <>
              {LeadingIcon && (
                <LeadingIcon
                  size={iconSize}
                  strokeWidth={1.5}
                  className="transition-[stroke-width] duration-80 group-hover:stroke-[2]"
                />
              )}
              {/* text-box only applies to block containers, so the trim lives
                  on the label span (a blockified flex item), not the flex root.
                  The button's height is fixed (h-*), so this doesn't change
                  layout — it just centers the cap-to-baseline box optically. */}
              <span className="[text-box:trim-both_cap_alphabetic]">{label}</span>
              {TrailingIcon && (
                <TrailingIcon
                  size={iconSize}
                  strokeWidth={1.5}
                  className="transition-[stroke-width] duration-80 group-hover:stroke-[2]"
                />
              )}
            </>
          )}
        </span>
      </>
    );

    const rootClassName = cn(
      buttonVariants({
        variant,
        size,
        iconLeft: !isIconOnly && !!LeadingIcon,
        iconRight: !isIconOnly && !!TrailingIcon,
      }),
      shape.button,
      className,
    );

    if (asChildElement) {
      const childProps = asChildElement.props;
      return cloneElement(
        asChildElement,
        {
          ...props,
          ref,
          className: cn(rootClassName, childProps.className),
          style: { ...style, ...childProps.style },
        },
        internals,
      );
    }

    return (
      <ButtonPrimitive
        ref={ref as Ref<HTMLButtonElement>}
        className={rootClassName}
        disabled={disabled || loading}
        style={style}
        {...props}
      >
        {internals}
      </ButtonPrimitive>
    );
  },
);

Button.displayName = "Button";

export { Button };
export type { ButtonProps };
