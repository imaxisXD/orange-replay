import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;

const TabsList = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof TabsPrimitive.List>>(
  ({ className, children, ...props }, ref) => (
    <TabsPrimitive.List
      className={cn(
        "relative inline-flex items-center gap-0.5 rounded-lg bg-secondary p-1",
        className,
      )}
      ref={ref}
      {...props}
    >
      <TabsPrimitive.Indicator className="pointer-events-none absolute top-0 left-0 h-(--active-tab-height) w-(--active-tab-width) [transform:translate(var(--active-tab-left),var(--active-tab-top))] rounded-md bg-card transition-[transform,width,height] duration-200 ease-in-out motion-reduce:transition-none" />
      {children}
    </TabsPrimitive.List>
  ),
);
TabsList.displayName = "TabsList";

const TabItem = forwardRef<
  HTMLElement,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Tab> & { label: string }
>(({ className, label, ...props }, ref) => (
  <TabsPrimitive.Tab
    className={cn(
      "relative z-10 flex h-8 cursor-pointer items-center rounded-md border-0 bg-transparent px-3 text-[12.5px] font-medium text-muted-foreground outline-none transition-colors duration-150 hover:text-foreground focus-visible:ring-1 focus-visible:ring-amber data-[active]:text-foreground motion-reduce:transition-none",
      className,
    )}
    ref={ref}
    {...props}
  >
    {label}
  </TabsPrimitive.Tab>
));
TabItem.displayName = "TabItem";

const TabPanel = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof TabsPrimitive.Panel>>(
  ({ className, ...props }, ref) => (
    <TabsPrimitive.Panel className={cn("outline-none", className)} ref={ref} {...props} />
  ),
);
TabPanel.displayName = "TabPanel";

export { Tabs, TabsList, TabItem, TabPanel };
