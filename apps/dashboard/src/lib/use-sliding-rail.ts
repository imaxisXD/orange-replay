import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

/**
 * Measures the item at `activeIndex` and returns a style positioning a rail
 * (underline, pill, tab shape) over it, so the rail can slide between items
 * with a CSS transition. Returns no style when the index has no element,
 * which hides the rail. Remeasures on window resize.
 */
export function useSlidingRail<T extends HTMLElement>(activeIndex: number) {
  const itemRefs = useRef<(T | null)[]>([]);
  const [railStyle, setRailStyle] = useState<CSSProperties>();

  useLayoutEffect(() => {
    function measure(): void {
      const item = itemRefs.current[activeIndex];
      if (item === null || item === undefined) {
        setRailStyle(undefined);
        return;
      }
      setRailStyle({ left: item.offsetLeft, width: item.offsetWidth });
    }

    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [activeIndex]);

  return { itemRefs, railStyle };
}
