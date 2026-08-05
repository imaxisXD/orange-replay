import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";
import "./website-favicon.css";

const FAVICON_STAGE = { empty: 0, loading: 1, revealed: 2 } as const;

const FAVICON_SLOT = {
  size: 16,
  parentGap: 8,
  enterX: 6,
  enterBlur: 2,
  enterDuration: 250,
  enterEase: "cubic-bezier(0.22, 1, 0.36, 1)",
} as const;

const faviconStyle = {
  "--favicon-size": `${FAVICON_SLOT.size}px`,
  "--favicon-parent-gap": `${FAVICON_SLOT.parentGap}px`,
  "--favicon-enter-x": `${FAVICON_SLOT.enterX}px`,
  "--favicon-enter-blur": `${FAVICON_SLOT.enterBlur}px`,
  "--favicon-enter-duration": `${FAVICON_SLOT.enterDuration}ms`,
  "--favicon-enter-ease": FAVICON_SLOT.enterEase,
} as CSSProperties & Record<`--${string}`, string>;

/**
 * Shared Website identity mark. A missing source takes no space; a new source
 * grows into place and reveals either the fetched icon or its safe initial.
 */
export function WebsiteFavicon({
  className,
  fallbackLabel,
  source,
}: {
  className?: string;
  fallbackLabel: string;
  source: string | null;
}) {
  const [loadedSource, setLoadedSource] = useState<string | null>(null);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const previousSource = useRef(source);
  const revealRef = useRef<HTMLSpanElement>(null);
  const hasFailed = source !== null && failedSource === source;
  const isRevealed = source !== null && (loadedSource === source || hasFailed);
  const fallbackLetter = fallbackLabel.trim().charAt(0).toUpperCase() || "?";
  const stage =
    source === null
      ? FAVICON_STAGE.empty
      : isRevealed
        ? FAVICON_STAGE.revealed
        : FAVICON_STAGE.loading;

  // Reset before paint when one Website replaces another. The old icon never
  // flashes while the next image is loading.
  useLayoutEffect(() => {
    const oldSource = previousSource.current;
    previousSource.current = source;
    if (source === null || oldSource === null || oldSource === source) return;

    const reveal = revealRef.current;
    const skeleton = reveal?.querySelector(".website-favicon-skeleton");
    if (reveal === null || !(skeleton instanceof HTMLElement)) return;

    reveal.classList.add("is-resetting");
    reveal.classList.remove("is-revealed");
    skeleton.classList.remove("is-pulsing");
    void skeleton.offsetWidth;
    reveal.classList.remove("is-resetting");
    skeleton.classList.add("is-pulsing");
  }, [source]);

  return (
    <span
      aria-hidden="true"
      className={cn("t-favicon-slot website-favicon-slot", className)}
      data-stage={stage}
      style={faviconStyle}
    >
      {source !== null && (
        <span
          className={cn(
            "t-skel t-favicon-frame website-favicon-frame",
            stage === FAVICON_STAGE.revealed && "is-revealed",
          )}
          ref={revealRef}
        >
          <span className="t-skel-skeleton website-favicon-layer website-favicon-skeleton is-pulsing grid place-items-center">
            <span className="size-full rounded-[4px] bg-surface-8" />
          </span>
          <span className="t-skel-content website-favicon-layer website-favicon-content grid place-items-center">
            {hasFailed ? (
              <span className="grid size-full place-items-center rounded-[4px] bg-surface-8 text-[9px] font-bold text-amber">
                {fallbackLetter}
              </span>
            ) : (
              <img
                alt=""
                className="size-full object-contain"
                decoding="async"
                onError={() => setFailedSource(source)}
                onLoad={() => setLoadedSource(source)}
                referrerPolicy="no-referrer"
                src={source}
              />
            )}
          </span>
        </span>
      )}
    </span>
  );
}
