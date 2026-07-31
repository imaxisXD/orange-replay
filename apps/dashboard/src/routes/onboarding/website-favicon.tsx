import { useState } from "react";
import { cn } from "@/lib/utils";

/** One favicon surface. The Worker always returns either a verified icon or its fallback. */
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
  const hasFailed = source !== null && failedSource === source;
  const isRevealed = source !== null && (loadedSource === source || hasFailed);
  const fallbackLetter = fallbackLabel.trim().charAt(0).toUpperCase() || "?";

  return (
    <span
      aria-hidden="true"
      className={cn(
        "t-skel block size-4 shrink-0 overflow-hidden rounded-[4px]",
        isRevealed && "is-revealed",
        className,
      )}
    >
      {source !== null && (
        <>
          <span className="t-skel-skeleton is-pulsing grid place-items-center">
            <span className="size-full rounded-[4px] bg-surface-8" />
          </span>
          <span className="t-skel-content grid place-items-center">
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
        </>
      )}
    </span>
  );
}
