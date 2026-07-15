import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { surfaceClasses } from "@/lib/surface-classes";
import { useSurface } from "@/lib/surface-context";
import type { IconComponent } from "@/lib/icon-map";
import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;

interface TabsListProps extends ComponentPropsWithoutRef<typeof TabsPrimitive.List> {
  /** Fluid surface level for the selected tab. Uses the current substrate when omitted. */
  surfaceLevel?: number;
}

const TabsList = forwardRef<HTMLDivElement, TabsListProps>(
  ({ className, children, surfaceLevel, ...props }, ref) => {
    const substrate = useSurface();
    const selectedSurface = surfaceLevel ?? Math.min(substrate + 3, 8);

    return (
      <TabsPrimitive.List
        className={cn(
          "relative inline-flex items-center gap-0.5 rounded-lg bg-secondary p-1",
          className,
        )}
        ref={ref}
        {...props}
      >
        <TabsPrimitive.Indicator
          className={cn(
            "pointer-events-none absolute top-0 left-0 h-(--active-tab-height) w-(--active-tab-width) [transform:translate(var(--active-tab-left),var(--active-tab-top))] rounded-md transition-[transform,width,height] duration-120 ease-out motion-reduce:transition-none",
            surfaceClasses(selectedSurface),
          )}
        />
        {children}
      </TabsPrimitive.List>
    );
  },
);
TabsList.displayName = "TabsList";

interface TabItemProps extends ComponentPropsWithoutRef<typeof TabsPrimitive.Tab> {
  icon?: IconComponent;
  label: string;
}

const TabItem = forwardRef<HTMLElement, TabItemProps>(
  ({ className, icon: Icon, label, ...props }, ref) => (
    <TabsPrimitive.Tab
      className={cn(
        "group relative z-10 flex h-8 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-3 text-[12.5px] font-medium text-muted-foreground outline-none transition-colors duration-100 ease-out hover:text-foreground focus-visible:ring-1 focus-visible:ring-amber data-[active]:text-foreground motion-reduce:transition-none",
        className,
      )}
      ref={ref}
      {...props}
    >
      {Icon && (
        <Icon
          aria-hidden
          className="shrink-0 transition-[color,stroke-width] duration-80 group-hover:text-foreground group-hover:stroke-2 group-data-[active]:text-foreground group-data-[active]:stroke-2 motion-reduce:transition-none"
          size={16}
          strokeWidth={1.5}
        />
      )}
      {label}
    </TabsPrimitive.Tab>
  ),
);
TabItem.displayName = "TabItem";

const TabPanel = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof TabsPrimitive.Panel>>(
  ({ className, ...props }, ref) => (
    <TabsPrimitive.Panel className={cn("outline-none", className)} ref={ref} {...props} />
  ),
);
TabPanel.displayName = "TabPanel";

export { Tabs, TabsList, TabItem, TabPanel };
export type { TabItemProps, TabsListProps };
