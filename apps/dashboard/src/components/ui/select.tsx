"use client";

import {
  Children,
  forwardRef,
  isValidElement,
  useRef,
  useEffect,
  useState,
  createContext,
  useContext,
  type ReactNode,
  type HTMLAttributes,
} from "react";
import { AnimatePresence, m, useReducedMotion } from "@/lib/motion";
import { cva, type VariantProps } from "class-variance-authority";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { ChevronDown, ChevronUp, type IconComponent } from "@/lib/icon-map";
import { cn } from "@/lib/utils";
import { spring, exitFallbackMs } from "@/lib/springs";
import { useProximityHover } from "@/hooks/use-proximity-hover";
import { useShape } from "@/lib/shape-context";

// ---------------------------------------------------------------------------
// Select context
//
// Base UI owns positioning, dismissal, keyboard navigation, typeahead, ARIA,
// and the hidden form input. The Fluid layer keeps the existing visuals,
// proximity hover, spring open/close motion, and animated checkmark.
// ---------------------------------------------------------------------------

interface SelectContextValue {
  value: string;
  open: boolean;
  actionsRef: React.RefObject<{ unmount: () => void } | null>;
}

const SelectContext = createContext<SelectContextValue | null>(null);

function useSelectContext() {
  const ctx = useContext(SelectContext);
  if (!ctx) throw new Error("Select compound components must be inside <Select>");
  return ctx;
}

// Content context for proximity hover
interface SelectContentContextValue {
  registerItem: (index: number, element: HTMLElement | null) => void;
  activeIndex: number | null;
  checkedIndex?: number;
}

const SelectContentContext = createContext<SelectContentContextValue | null>(null);

// ---------------------------------------------------------------------------
// Select (root)
// ---------------------------------------------------------------------------

interface SelectProps {
  children: ReactNode;
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  name?: string;
  required?: boolean;
}

/**
 * Give Base UI the item labels before the popup mounts so the closed trigger
 * can show the selected label instead of its raw value.
 */
function collectSelectItems(node: ReactNode, out: { value: string; label: ReactNode }[] = []) {
  Children.forEach(node, (child) => {
    if (!isValidElement(child)) return;

    const props = child.props as { value?: unknown; children?: ReactNode };
    if (typeof props.value === "string") {
      out.push({
        value: props.value,
        label: typeof props.children === "string" ? props.children : props.value,
      });
    } else if (props.children) {
      collectSelectItems(props.children, out);
    }
  });

  return out;
}

function Select({
  children,
  value,
  defaultValue,
  onValueChange,
  disabled = false,
  name,
  required,
}: SelectProps) {
  const [internalValue, setInternalValue] = useState(defaultValue ?? "");
  const [open, setOpen] = useState(false);
  const actionsRef = useRef<{ unmount: () => void } | null>(null);
  const currentValue = value !== undefined ? value : internalValue;
  const items = collectSelectItems(children);

  function handleValueChange(next: string | null): void {
    const nextValue = next ?? "";
    if (value === undefined) setInternalValue(nextValue);
    onValueChange?.(nextValue);
  }

  const ctx = { value: currentValue, open, actionsRef };

  return (
    <SelectContext.Provider value={ctx}>
      <SelectPrimitive.Root
        value={currentValue === "" ? null : currentValue}
        onValueChange={handleValueChange}
        open={open}
        onOpenChange={setOpen}
        actionsRef={actionsRef}
        items={items}
        disabled={disabled}
        name={name}
        required={required}
        modal={false}
        // Fluid's own proximity layer handles pointer hover. Keeping Base
        // UI's highlight for keyboard navigation prevents a pointer-opened
        // menu from showing the amber keyboard focus ring.
        highlightItemOnHover={false}
      >
        {children}
      </SelectPrimitive.Root>
    </SelectContext.Provider>
  );
}

Select.displayName = "Select";

// ---------------------------------------------------------------------------
// SelectTrigger
// ---------------------------------------------------------------------------

const triggerVariants = cva(
  [
    "group inline-flex items-center justify-between gap-2 outline-none cursor-pointer",
    "h-8 min-w-40 px-3 text-[12.5px]",
    "transition-colors duration-80",
    "disabled:opacity-50 disabled:pointer-events-none",
    "focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring)]",
  ],
  {
    variants: {
      variant: {
        bordered: "border border-border bg-card text-foreground hover:bg-hover",
        borderless: "border border-transparent bg-transparent text-foreground hover:bg-hover",
      },
    },
    defaultVariants: {
      variant: "bordered",
    },
  },
);

interface SelectTriggerProps
  extends
    Omit<HTMLAttributes<HTMLButtonElement>, "children">,
    VariantProps<typeof triggerVariants> {
  icon?: IconComponent;
  placeholder?: string;
  error?: string;
}

interface SelectChevronProps extends HTMLAttributes<HTMLSpanElement> {
  open: boolean;
  hovered: boolean;
}

const SelectChevron = forwardRef<HTMLSpanElement, SelectChevronProps>(
  ({ className, open, hovered, ...props }, ref) => {
    const reduce = useReducedMotion();
    const distance = hovered ? 4 : 3;
    const transition = reduce ? { duration: 0 } : spring.slow;

    return (
      <span
        ref={ref}
        aria-hidden="true"
        className={cn(
          "relative size-4 shrink-0 text-dim transition-colors duration-80 group-hover:text-foreground",
          className,
        )}
        {...props}
      >
        <m.span
          className="absolute inset-0 grid place-items-center"
          initial={false}
          animate={{ transform: `translateY(${open ? 0 : -distance}px)` }}
          transition={transition}
        >
          <ChevronUp size={14} strokeWidth={2} />
        </m.span>

        <AnimatePresence initial={false}>
          {!open && (
            <m.span
              key="down"
              className="absolute inset-0 grid place-items-center"
              initial={reduce ? false : { opacity: 0, transform: "translateY(0px) scale(0.75)" }}
              animate={{
                opacity: 1,
                transform: `translateY(${distance}px) scale(1)`,
              }}
              exit={{ opacity: 0, transform: "translateY(0px) scale(0.75)" }}
              transition={transition}
            >
              <ChevronDown size={14} strokeWidth={2} />
            </m.span>
          )}
        </AnimatePresence>
      </span>
    );
  },
);

SelectChevron.displayName = "SelectChevron";

const SelectTrigger = forwardRef<HTMLButtonElement, SelectTriggerProps>(
  (
    {
      className,
      variant,
      icon: Icon,
      placeholder = "Select…",
      error,
      onMouseEnter,
      onMouseLeave,
      ...props
    },
    ref,
  ) => {
    const shape = useShape();
    const { open } = useSelectContext();
    const [hovered, setHovered] = useState(false);

    return (
      <div className="flex flex-col gap-1">
        <SelectPrimitive.Trigger
          ref={ref}
          aria-invalid={!!error || undefined}
          className={cn(
            triggerVariants({ variant }),
            shape.input,
            error && "border-destructive/50 hover:border-destructive/50",
            className,
          )}
          {...props}
          onMouseEnter={(event) => {
            setHovered(true);
            onMouseEnter?.(event);
          }}
          onMouseLeave={(event) => {
            setHovered(false);
            onMouseLeave?.(event);
          }}
        >
          <span className="flex items-center gap-2 min-w-0 flex-1">
            {Icon && (
              <Icon
                size={16}
                strokeWidth={1.5}
                className="shrink-0 text-muted-foreground transition-[color,stroke-width] duration-80 group-hover:text-foreground group-hover:stroke-[2]"
              />
            )}
            {/* py-1/-my-1 keeps truncate's overflow:hidden from clipping
                ascenders/descenders outside the trimmed box. */}
            <span className="min-w-0 flex-1 text-left truncate [text-box:trim-both_cap_alphabetic] py-1 -my-1 group-data-[placeholder]:text-muted-foreground">
              <SelectPrimitive.Value placeholder={placeholder} />
            </span>
          </span>

          <SelectPrimitive.Icon render={<SelectChevron open={open} hovered={hovered} />} />
        </SelectPrimitive.Trigger>
        {error && <span className="text-[12px] text-destructive pl-3">{error}</span>}
      </div>
    );
  },
);

SelectTrigger.displayName = "SelectTrigger";

// ---------------------------------------------------------------------------
// SelectContent
// ---------------------------------------------------------------------------

interface SelectContentProps {
  className?: string;
  children: ReactNode;
}

const SelectContent = forwardRef<HTMLDivElement, SelectContentProps>(
  ({ className, children }, ref) => {
    const { open, value, actionsRef } = useSelectContext();
    const shape = useShape();
    const reduce = useReducedMotion();
    const containerRef = useRef<HTMLDivElement>(null);

    const {
      activeIndex,
      setActiveIndex,
      itemRects,
      sessionKey,
      handlers,
      registerItem,
      measureItems,
    } = useProximityHover(containerRef);

    const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
    const [checkedIndex, setCheckedIndex] = useState<number | undefined>(undefined);

    // Release Base UI's deferred mount once the exit tween has played.
    // onAnimationComplete on the motion.div is the primary signal; this
    // timeout is a fallback for throttled/background tabs where rAF-driven
    // animation callbacks can stall. The popup exits with spring.fast, so the
    // fallback tracks that tier's exit duration plus a safety buffer.
    useEffect(() => {
      if (open) return;
      const id = setTimeout(() => actionsRef.current?.unmount(), exitFallbackMs(spring.fast));
      return () => clearTimeout(id);
    }, [actionsRef, open]);

    // Measure items + detect the checked row once the popup has mounted.
    useEffect(() => {
      if (!open) return;
      // Double rAF: first waits for React commit, second for layout
      let inner: number;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => {
          measureItems();
          const container = containerRef.current;
          if (container) {
            const items = Array.from(
              container.querySelectorAll("[data-proximity-index]"),
            ) as HTMLElement[];
            const idx = items.findIndex((el) => el.getAttribute("data-value") === value);
            setCheckedIndex(idx !== -1 ? idx : undefined);
          }
        });
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }, [open, measureItems, value]);

    const activeRect = activeIndex !== null ? itemRects[activeIndex] : null;
    const checkedRect = checkedIndex != null ? itemRects[checkedIndex] : null;
    const focusRect = focusedIndex !== null ? itemRects[focusedIndex] : null;
    const isHoveringOther = activeIndex !== null && activeIndex !== checkedIndex;

    // Inset the hover/selected pills within their row so adjacent highlights
    // keep a visible gutter instead of butting edge-to-edge.
    const PILL_INSET = 2;

    const contentCtx = { registerItem, activeIndex, checkedIndex };

    return (
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
          side="bottom"
          align="start"
          sideOffset={6}
          alignItemWithTrigger={false}
          className="z-50 outline-none"
        >
          <m.div
            initial={
              reduce ? { opacity: 0 } : { opacity: 0, transform: "translateY(-4px) scaleY(0.96)" }
            }
            animate={
              open
                ? reduce
                  ? { opacity: 1 }
                  : { opacity: 1, transform: "translateY(0px) scaleY(1)" }
                : reduce
                  ? { opacity: 0 }
                  : { opacity: 0, transform: "translateY(-4px) scaleY(0.96)" }
            }
            transition={open ? spring.fast : spring.fast.exit}
            style={{ transformOrigin: "var(--transform-origin)" }}
            // Base UI keeps the popup mounted while actionsRef is set. Release
            // it after the exit spring so the close motion can finish.
            onAnimationComplete={() => {
              if (!open) actionsRef.current?.unmount();
            }}
          >
            <SelectContentContext.Provider value={contentCtx}>
              <SelectPrimitive.Popup
                ref={(node: HTMLDivElement | null) => {
                  (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
                  if (typeof ref === "function") ref(node);
                  else if (ref)
                    (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
                }}
                onMouseEnter={() => {
                  handlers.onMouseEnter();
                  setFocusedIndex(null);
                }}
                onMouseMove={handlers.onMouseMove}
                onMouseLeave={handlers.onMouseLeave}
                onFocus={(event) => {
                  const item = (event.target as HTMLElement).closest("[data-proximity-index]");
                  const indexValue = item?.getAttribute("data-proximity-index");
                  if (indexValue == null) return;

                  const nextIndex = Number(indexValue);
                  setActiveIndex(nextIndex);
                  setFocusedIndex(
                    (event.target as HTMLElement).matches(":focus-visible") ? nextIndex : null,
                  );
                }}
                onBlur={(event) => {
                  if (containerRef.current?.contains(event.relatedTarget as Node)) return;
                  setFocusedIndex(null);
                  setActiveIndex(null);
                }}
                className={cn(
                  `relative flex flex-col gap-0.5 min-w-[var(--anchor-width)] max-h-[min(300px,var(--available-height))] overflow-y-auto ${shape.container} border border-border bg-popover p-1 shadow-surface-3 select-none outline-none`,
                  className,
                )}
              >
                {/* Selected background */}
                <AnimatePresence>
                  {checkedRect && (
                    <m.div
                      className={`absolute ${shape.bg} bg-active-overlay pointer-events-none`}
                      style={{
                        height: checkedRect.height - PILL_INSET * 2,
                        left: 0,
                        top: 0,
                        width: checkedRect.width,
                      }}
                      initial={false}
                      animate={{
                        x: checkedRect.left,
                        y: checkedRect.top + PILL_INSET,
                        opacity: isHoveringOther ? 0.8 : 1,
                      }}
                      exit={{ opacity: 0, transition: spring.moderate.exit }}
                      transition={{
                        ...spring.moderate,
                        opacity: { duration: 0.08 },
                      }}
                    />
                  )}
                </AnimatePresence>

                {/* Hover background */}
                <AnimatePresence>
                  {activeRect && (
                    <m.div
                      key={sessionKey}
                      className={`absolute ${shape.bg} bg-hover-overlay pointer-events-none`}
                      style={{
                        height: activeRect.height - PILL_INSET * 2,
                        left: 0,
                        top: 0,
                        width: activeRect.width,
                      }}
                      initial={{
                        opacity: 0,
                        x: checkedRect?.left ?? activeRect.left,
                        y: (checkedRect?.top ?? activeRect.top) + PILL_INSET,
                      }}
                      animate={{
                        opacity: 1,
                        x: activeRect.left,
                        y: activeRect.top + PILL_INSET,
                      }}
                      exit={{ opacity: 0, transition: spring.fast.exit }}
                      transition={{
                        ...spring.fast,
                        opacity: { duration: 0.08 },
                      }}
                    />
                  )}
                </AnimatePresence>

                {/* Focus ring */}
                <AnimatePresence>
                  {focusRect && (
                    <m.div
                      className={`absolute ${shape.focusRing} pointer-events-none z-20 border border-[color:var(--focus-ring)]`}
                      style={{
                        height: focusRect.height + 4,
                        left: 0,
                        top: 0,
                        width: focusRect.width + 4,
                      }}
                      initial={false}
                      animate={{
                        x: focusRect.left - 2,
                        y: focusRect.top - 2,
                      }}
                      exit={{ opacity: 0, transition: spring.fast.exit }}
                      transition={{
                        ...spring.fast,
                        opacity: { duration: 0.08 },
                      }}
                    />
                  )}
                </AnimatePresence>

                {children}
              </SelectPrimitive.Popup>
            </SelectContentContext.Provider>
          </m.div>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    );
  },
);

SelectContent.displayName = "SelectContent";

// ---------------------------------------------------------------------------
// SelectItem
// ---------------------------------------------------------------------------

interface SelectItemProps extends HTMLAttributes<HTMLDivElement> {
  icon?: IconComponent;
  index: number;
  value: string;
  disabled?: boolean;
}

const SelectItem = forwardRef<HTMLDivElement, SelectItemProps>(
  ({ className, children, icon: Icon, value, index, disabled = false, ...props }, ref) => {
    const selectCtx = useSelectContext();
    const contentCtx = useContext(SelectContentContext);
    const internalRef = useRef<HTMLDivElement>(null);
    const shape = useShape();

    // Register with proximity hover
    useEffect(() => {
      contentCtx?.registerItem(index, internalRef.current);
      return () => contentCtx?.registerItem(index, null);
    }, [index, contentCtx]);

    const isActive = contentCtx?.activeIndex === index;
    const isChecked = selectCtx.value === value;

    return (
      <SelectPrimitive.Item
        value={value}
        disabled={disabled}
        label={typeof children === "string" ? children : undefined}
        render={
          <div
            ref={(node: HTMLDivElement | null) => {
              (internalRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
              if (typeof ref === "function") ref(node);
              else if (ref) (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
            }}
            data-proximity-index={index}
            data-value={value}
            className={cn(
              // Fixed height (was py-2 around a 19.5px line box ≈ 35.5px) so
              // the text-box trim on the item text doesn't shrink the row.
              `relative z-10 flex h-9 items-center gap-2 ${shape.item} px-2 text-[13px] cursor-pointer outline-none select-none`,
              "transition-[color] duration-80",
              isActive || isChecked ? "text-foreground" : "text-foreground/75",
              disabled && "opacity-50 pointer-events-none",
              className,
            )}
            {...props}
          />
        }
      >
        {Icon && (
          <Icon
            size={16}
            strokeWidth={isActive || isChecked ? 2 : 1.5}
            className="shrink-0 transition-[color,stroke-width] duration-80"
          />
        )}

        {/* py-1/-my-1 keeps truncate's overflow:hidden from clipping
            ascenders/descenders outside the trimmed box. */}
        <SelectPrimitive.ItemText
          render={
            <span className="flex-1 min-w-0 truncate [text-box:trim-both_cap_alphabetic] py-1 -my-1" />
          }
        >
          {children}
        </SelectPrimitive.ItemText>

        <AnimatePresence initial={false}>
          {isChecked && (
            <m.svg
              key="check"
              width={16}
              height={16}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0 text-foreground"
              initial={{ opacity: 1 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 1 }}
            >
              <m.path
                d="M4 12L9 17L20 6"
                initial={{ pathLength: 0 }}
                animate={{
                  pathLength: 1,
                  transition: { duration: 0.08, ease: "easeOut" },
                }}
                exit={{
                  pathLength: 0,
                  transition: { duration: 0.04, ease: "easeOut" },
                }}
              />
            </m.svg>
          )}
        </AnimatePresence>
      </SelectPrimitive.Item>
    );
  },
);

SelectItem.displayName = "SelectItem";

// ---------------------------------------------------------------------------
// SelectGroup + SelectLabel + SelectSeparator
// ---------------------------------------------------------------------------

function SelectGroup({ children, className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div role="group" className={className} {...props}>
      {children}
    </div>
  );
}

SelectGroup.displayName = "SelectGroup";

const SelectLabel = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("px-2 py-1.5 text-[11px] text-muted-foreground", className)}
      {...props}
    />
  ),
);

SelectLabel.displayName = "SelectLabel";

const SelectSeparator = forwardRef<HTMLHRElement, HTMLAttributes<HTMLHRElement>>(
  ({ className, ...props }, ref) => (
    <hr ref={ref} className={cn("my-1 -mx-1 h-px bg-border/60", className)} {...props} />
  ),
);

SelectSeparator.displayName = "SelectSeparator";

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectLabel,
  SelectSeparator,
};

export type { SelectProps, SelectTriggerProps, SelectContentProps, SelectItemProps };
