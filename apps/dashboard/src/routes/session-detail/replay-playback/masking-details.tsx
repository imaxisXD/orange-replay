import { domMaskingDescription, summarizeDomMasking } from "@orange-replay/shared/dom-masking";
import type { SessionManifest } from "@orange-replay/shared/types";

export function MaskingDetails({ manifest }: { manifest: SessionManifest }) {
  return (
    <p
      className="px-4 pb-3 text-[11.5px] leading-relaxed text-muted-foreground"
      data-slot="masking-details"
    >
      {domMaskingDescription(
        manifest.domMaskingSummary ?? summarizeDomMasking(manifest.domMasking),
      )}
    </p>
  );
}
