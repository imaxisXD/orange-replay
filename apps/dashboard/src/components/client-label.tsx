import { Android, Chrome, Linux, MacOs, Safari, Windows, type IconComponent } from "@/lib/icon-map";

/**
 * Browser/OS rendering rule (docs/design-language.md §Icon vocabulary):
 * a recognizable BRAND glyph beats text at scan speed, so render one when the
 * free icon set has it — and honest text when it does not. A generic globe
 * standing in for "Firefox" carries less information than the word.
 */
const browserGlyphs: Record<string, IconComponent> = {
  Chrome: Chrome,
  Safari: Safari,
};

const osGlyphs: Record<string, IconComponent> = {
  Android: Android,
  Linux: Linux,
  macOS: MacOs,
  Windows: Windows,
};

export function ClientLabel({ browser, os }: { browser: string | null; os: string | null }) {
  const parts = [
    { value: browser, glyph: browser === null ? undefined : browserGlyphs[browser] },
    { value: os, glyph: os === null ? undefined : osGlyphs[os] },
  ].filter((part) => part.value !== null && part.value.length > 0);

  if (parts.length === 0) return null;

  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {parts.map((part, index) => {
        const Glyph = part.glyph;
        return (
          <span className="inline-flex min-w-0 items-center gap-1" key={part.value}>
            {index > 0 && <span className="text-dim">·</span>}
            {/* Icon AND name: the mark is the fast read, the word removes doubt. */}
            {Glyph !== undefined && (
              <Glyph
                aria-hidden
                // 14px + heavier stroke: brand marks lose their identity and
                // read as dots at 12px/1.5 in the stroke style.
                className="size-3.5 shrink-0"
                strokeWidth={2}
              />
            )}
            <span className="truncate" title={part.value ?? undefined}>
              {part.value}
            </span>
          </span>
        );
      })}
    </span>
  );
}
