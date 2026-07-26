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
import { LoadingIndicator } from "@/components/ui/loading-indicator";
import type { IconComponent } from "@/lib/icon-map";
import { cn } from "@/lib/utils";
import { useShape } from "@/lib/shape-context";

const buttonVariants = cva(
  [
    "group relative isolate inline-flex items-center justify-center outline-none cursor-pointer",
    "rounded-lg transition-colors duration-100",
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
    const actionName =
      typeof props["aria-label"] === "string"
        ? props["aria-label"]
        : typeof label === "string"
          ? label
          : "Action";
    const shape = useShape();
    const resolvedVariant = variant ?? "primary";
    // Unavailable and in-flight are different states. Unavailable fades out and
    // stops taking the pointer; in-flight keeps full strength (the indicator has
    // to be readable) and keeps the pointer so the cursor can say "not now" —
    // pointer-events-none would hand the cursor to whatever sits underneath.
    const unavailable = disabled === true;
    const inFlight = loading && !unavailable;
    // The primary plate is near-white, and the shared indicator ramp is light,
    // so a loading primary showed an invisible spinner. In flight it borrows the
    // card plate and a border, which the same indicator reads against.
    const darkLoadingPlate = inFlight && resolvedVariant === "primary";
    const bgClass = darkLoadingPlate
      ? "bg-card"
      : active
        ? activeBgVariants[resolvedVariant]
        : bgVariants[resolvedVariant];

    const internals = (
      <>
        <span
          aria-hidden
          className={cn(
            "absolute inset-0 rounded-[inherit] transition-[background-color,transform] duration-80 group-active:scale-[0.96]",
            bgClass,
            // The border lives on the plate, not the root: the root's width is
            // content-driven, so a border there would jog the box by 2px the
            // moment the request starts.
            darkLoadingPlate && "border border-border",
          )}
        />
        {/* The label rides the press with the plate: same 0.96, same 80ms, same
            center origin, so the box and its contents shrink as one piece
            instead of the text floating at full size inside a smaller plate. */}
        <span className="relative inline-flex items-center justify-center gap-[inherit] transition-transform duration-80 group-active:scale-[0.96]">
          {loading ? (
            <>
              <span className="flex items-center justify-center gap-[inherit] opacity-0">
                {LeadingIcon && !isIconOnly && <LeadingIcon size={iconSize} strokeWidth={2} />}
                {label}
                {TrailingIcon && !isIconOnly && <TrailingIcon size={iconSize} strokeWidth={2} />}
              </span>
              <span className="absolute inset-0 flex items-center justify-center">
                <LoadingIndicator label={`${actionName} in progress`} />
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
      unavailable && "opacity-50 pointer-events-none",
      inFlight && "cursor-not-allowed",
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
