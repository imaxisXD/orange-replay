"use client";

import {
  Children,
  cloneElement,
  createContext,
  forwardRef,
  isValidElement,
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { AnimatePresence, m } from "framer-motion";
import { useProximityHover } from "@/hooks/use-proximity-hover";
import { fontWeights } from "@/lib/font-weight";
import type { IconComponent } from "@/lib/icon-map";
import { useShape } from "@/lib/shape-context";
import { spring } from "@/lib/springs";
import { surfaceClasses } from "@/lib/surface-classes";
import { useSurface } from "@/lib/surface-context-value";
import { cn } from "@/lib/utils";

/* ─────────────────────── Contexts ─────────────────────── */

interface TabsValueOrderContextValue {
  selectedValue: string | undefined;
}

const TabsValueOrderContext = createContext<TabsValueOrderContextValue | null>(null);

interface TabsListContextValue {
  registerTab: (index: number, value: string, element: HTMLElement | null) => void;
  hoveredIndex: number | null;
  selectedValue: string | undefined;
  setOptimisticIndex: (index: number) => void;
}

const TabsListContext = createContext<TabsListContextValue | null>(null);

function useTabsList() {
  const context = useContext(TabsListContext);
  if (!context) throw new Error("TabItem must be used within a TabsList");
  return context;
}

function readTabValues(children: ReactNode): string[] {
  const values: string[] = [];

  function visit(nodes: ReactNode) {
    Children.forEach(nodes, (child) => {
      if (!isValidElement(child)) return;

      const childProps = child.props as {
        children?: ReactNode;
        label?: unknown;
        value?: unknown;
      };
      if (typeof childProps.label === "string" && typeof childProps.value === "string") {
        values.push(childProps.value);
        return;
      }
      visit(childProps.children);
    });
  }

  visit(children);
  return values;
}

/* ─────────────────────── Tabs (Root) ─────────────────────── */

interface TabsProps extends Omit<
  ComponentPropsWithoutRef<typeof TabsPrimitive.Root>,
  "defaultValue" | "onSelect" | "onValueChange" | "value"
> {
  value?: string;
  onValueChange?: (value: string) => void;
  selectedIndex?: number;
  onSelect?: (index: number) => void;
  defaultValue?: string;
}

const Tabs = forwardRef<HTMLDivElement, TabsProps>(
  ({ value, onValueChange, selectedIndex, onSelect, defaultValue, children, ...props }, ref) => {
    const valueOrder = readTabValues(children);
    const [uncontrolledValue, setUncontrolledValue] = useState<string | undefined>(defaultValue);

    const resolvedValue =
      value ??
      (selectedIndex != null ? valueOrder[selectedIndex] : (uncontrolledValue ?? valueOrder[0]));

    function handleValueChange(newValue: unknown) {
      const nextValue = newValue as string;
      if (value === undefined && selectedIndex == null) {
        setUncontrolledValue(nextValue);
      }
      onValueChange?.(nextValue);
      if (onSelect) {
        const index = valueOrder.indexOf(nextValue);
        if (index !== -1) onSelect(index);
      }
    }

    return (
      <TabsValueOrderContext.Provider value={{ selectedValue: resolvedValue }}>
        <TabsPrimitive.Root
          onValueChange={handleValueChange}
          ref={ref}
          value={resolvedValue ?? ""}
          {...props}
        >
          {children}
        </TabsPrimitive.Root>
      </TabsValueOrderContext.Provider>
    );
  },
);

Tabs.displayName = "Tabs";

/* ─────────────────────── TabsList ─────────────────────── */

interface TabsListProps extends ComponentPropsWithoutRef<typeof TabsPrimitive.List> {
  /** Fluid surface level for the selected tab. Uses the current substrate when omitted. */
  surfaceLevel?: number;
}

const TabsList = forwardRef<HTMLDivElement, TabsListProps>(
  ({ children, className, surfaceLevel, ...props }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [isMouseInside, setIsMouseInside] = useState(false);
    const shape = useShape();
    const substrate = useSurface();
    const indicatorLevel = surfaceLevel ?? Math.min(substrate + 3, 8);
    const valueOrderContext = useContext(TabsValueOrderContext);
    const [optimisticSelection, setOptimisticSelection] = useState<{
      index: number;
      selectedValue: string | undefined;
    } | null>(null);

    const values = readTabValues(children);

    const {
      activeIndex: hoveredIndex,
      setActiveIndex: setHoveredIndex,
      itemRects,
      handlers,
      registerItem,
      measureItems,
    } = useProximityHover(containerRef, { axis: "x" });

    function registerTab(index: number, _value: string, element: HTMLElement | null) {
      registerItem(index, element);
    }

    useEffect(() => {
      measureItems();
    }, [children, measureItems]);

    function handleMouseMove(event: React.MouseEvent) {
      setIsMouseInside(true);
      handlers.onMouseMove(event);
    }

    function handleMouseLeave() {
      setIsMouseInside(false);
      handlers.onMouseLeave();
    }

    const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
    const selectedValue = valueOrderContext?.selectedValue;
    const selectedIndex = selectedValue === undefined ? -1 : values.indexOf(selectedValue);
    const activeSelectedIndex =
      optimisticSelection !== null && optimisticSelection.selectedValue === selectedValue
        ? optimisticSelection.index
        : selectedIndex >= 0
          ? selectedIndex
          : null;

    function setOptimisticIndex(index: number) {
      setOptimisticSelection({ index, selectedValue });
    }
    const selectedRect = activeSelectedIndex === null ? null : itemRects[activeSelectedIndex];
    const hoverRect = hoveredIndex === null ? null : itemRects[hoveredIndex];
    const focusRect = focusedIndex === null ? null : itemRects[focusedIndex];
    const isHoveringSelected = hoveredIndex === activeSelectedIndex;
    const isHovering = hoveredIndex !== null && !isHoveringSelected;

    const indexedChildren = Children.map(children, (child, index) => {
      if (isValidElement(child) && typeof child.type !== "string") {
        return cloneElement(child, { _index: index } as Record<string, unknown>);
      }
      return child;
    });

    return (
      <TabsListContext.Provider
        value={{
          registerTab,
          hoveredIndex,
          selectedValue,
          setOptimisticIndex,
        }}
      >
        <TabsPrimitive.List
          activateOnFocus
          className={cn(
            "relative inline-flex items-center gap-0.5 bg-muted p-1 select-none",
            shape.container,
            className,
          )}
          onBlur={(event) => {
            if (containerRef.current?.contains(event.relatedTarget as Node)) return;
            setFocusedIndex(null);
            if (isMouseInside) return;
            setHoveredIndex(null);
          }}
          onFocus={(event) => {
            const trigger = (event.target as HTMLElement).closest('[role="tab"]');
            if (!trigger) return;
            const indexAttribute = trigger.getAttribute("data-proximity-index");
            if (indexAttribute !== null) {
              const index = Number(indexAttribute);
              setHoveredIndex(index);
              setFocusedIndex(
                (event.target as HTMLElement).matches(":focus-visible") ? index : null,
              );
            }
          }}
          onMouseLeave={handleMouseLeave}
          onMouseMove={handleMouseMove}
          ref={(node) => {
            containerRef.current = node;
            if (typeof ref === "function") ref(node);
            else if (ref) ref.current = node;
          }}
          {...props}
        >
          {selectedRect && (
            <m.div
              animate={{
                left: selectedRect.left,
                top: selectedRect.top,
                opacity: isHovering ? 0.85 : 1,
              }}
              className={cn(
                "pointer-events-none absolute",
                surfaceClasses(indicatorLevel),
                shape.bg,
              )}
              initial={false}
              style={{ height: selectedRect.height, width: selectedRect.width }}
              transition={{
                ...spring.moderate,
                opacity: { duration: 0.08 },
              }}
            />
          )}

          <AnimatePresence>
            {hoverRect && !isHoveringSelected && selectedRect && (
              <m.div
                animate={{
                  left: hoverRect.left,
                  top: hoverRect.top,
                  opacity: 0.4,
                }}
                className={cn("pointer-events-none absolute bg-hover", shape.bg)}
                exit={
                  !isMouseInside && selectedRect
                    ? {
                        left: selectedRect.left,
                        top: selectedRect.top,
                        opacity: 0,
                        transition: {
                          ...spring.moderate,
                          opacity: { duration: 0.06 },
                        },
                      }
                    : { opacity: 0, transition: spring.fast.exit }
                }
                initial={{
                  left: selectedRect.left,
                  top: selectedRect.top,
                  opacity: 0,
                }}
                style={{ height: hoverRect.height, width: hoverRect.width }}
                transition={{
                  ...spring.fast,
                  opacity: { duration: 0.08 },
                }}
              />
            )}
          </AnimatePresence>

          <AnimatePresence>
            {focusRect && (
              <m.div
                animate={{
                  left: focusRect.left - 2,
                  top: focusRect.top - 2,
                }}
                className={cn(
                  "pointer-events-none absolute z-20 border border-[color:var(--focus-ring,#6B97FF)]",
                  shape.focusRing,
                )}
                exit={{ opacity: 0, transition: spring.fast.exit }}
                initial={false}
                style={{ height: focusRect.height + 4, width: focusRect.width + 4 }}
                transition={{
                  ...spring.fast,
                  opacity: { duration: 0.08 },
                }}
              />
            )}
          </AnimatePresence>

          {indexedChildren}
        </TabsPrimitive.List>
      </TabsListContext.Provider>
    );
  },
);

TabsList.displayName = "TabsList";

/* ─────────────────────── TabItem ─────────────────────── */

interface TabItemProps extends ComponentPropsWithoutRef<typeof TabsPrimitive.Tab> {
  value: string;
  icon?: IconComponent;
  label: string;
  /** @internal Auto-assigned by TabsList. */
  _index?: number;
}

const TabItem = forwardRef<HTMLButtonElement, TabItemProps>(
  ({ value, icon: Icon, label, _index = 0, className, onClick, ...props }, ref) => {
    const internalRef = useRef<HTMLButtonElement>(null);
    const { registerTab, hoveredIndex, selectedValue, setOptimisticIndex } = useTabsList();

    useEffect(() => {
      registerTab(_index, value, internalRef.current);
      return () => registerTab(_index, value, null);
    }, [_index, registerTab, value]);

    const isSelected = selectedValue === value;
    const isActive = hoveredIndex === _index || isSelected;

    return (
      <TabsPrimitive.Tab
        className={cn(
          "relative z-10 flex h-8 cursor-pointer items-center gap-2 border-none bg-transparent px-3 outline-none",
          className,
        )}
        data-proximity-index={_index}
        onClick={(event) => {
          setOptimisticIndex(_index);
          onClick?.(event);
        }}
        ref={(node) => {
          internalRef.current = node as HTMLButtonElement | null;
          if (typeof ref === "function") ref(node as HTMLButtonElement);
          else if (ref) ref.current = node as HTMLButtonElement | null;
        }}
        value={value}
        {...props}
      >
        {Icon && (
          <Icon
            aria-hidden
            className={cn(
              "transition-[color,stroke-width] duration-80 motion-reduce:transition-none",
              isActive ? "text-foreground" : "text-muted-foreground",
            )}
            size={16}
            strokeWidth={isActive ? 2 : 1.5}
          />
        )}
        <span className="inline-grid text-[13px] whitespace-nowrap">
          <span
            aria-hidden="true"
            className="invisible col-start-1 row-start-1 [text-box:trim-both_cap_alphabetic]"
            style={{ fontVariationSettings: fontWeights.semibold }}
          >
            {label}
          </span>
          <span
            className={cn(
              "col-start-1 row-start-1 transition-[color,font-variation-settings] duration-80 [text-box:trim-both_cap_alphabetic] motion-reduce:transition-none",
              isActive ? "text-foreground" : "text-muted-foreground",
            )}
            style={{
              fontVariationSettings: isSelected ? fontWeights.semibold : fontWeights.normal,
            }}
          >
            {label}
          </span>
        </span>
      </TabsPrimitive.Tab>
    );
  },
);

TabItem.displayName = "TabItem";

/* ─────────────────────── TabPanel ─────────────────────── */

interface TabPanelProps extends ComponentPropsWithoutRef<typeof TabsPrimitive.Panel> {
  value: string;
}

const TabPanel = forwardRef<HTMLDivElement, TabPanelProps>(({ className, ...props }, ref) => (
  <TabsPrimitive.Panel className={cn("outline-none", className)} ref={ref} {...props} />
));

TabPanel.displayName = "TabPanel";

export { Tabs, TabsList, TabItem, TabPanel };
export type { TabItemProps, TabPanelProps, TabsListProps, TabsProps };
