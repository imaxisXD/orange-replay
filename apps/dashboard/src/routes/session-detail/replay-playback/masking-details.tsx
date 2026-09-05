import { domMaskingDescription, summarizeDomMasking } from "@orange-replay/shared/dom-masking";
import type { SessionManifest } from "@orange-replay/shared/types";

export function MaskingDetails({
  manifest,
}: {
  manifest: Pick<SessionManifest, "domMasking" | "domMaskingSummary">;
}) {
  return (
    <details className="mt-2 text-[12px] leading-relaxed text-muted-foreground">
      <summary className="cursor-pointer rounded-sm py-2 hover:text-foreground">
        Masking details
      </summary>
      <p className="pb-2" data-slot="masking-details">
        {domMaskingDescription(
          manifest.domMaskingSummary ?? summarizeDomMasking(manifest.domMasking),
        )}
      </p>
    </details>
  );
}
