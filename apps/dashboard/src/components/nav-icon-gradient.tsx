/** Amber → teal gradient (the two dashboard accent tokens), exposed as SVG
    stops so `.nav-icon-gradient` (index.css) can paint icon strokes with it.
    Render once next to any nav that uses the class. */
export function NavIconGradientDefs() {
  return (
    <svg aria-hidden className="absolute size-0">
      <defs>
        {/* Hugeicons draw within ~3..21 of the 24px viewBox, so the vector spans
            the glyph bounds (not the full box) and teal lands before the last
            visible stroke instead of past it. */}
        <linearGradient
          gradientUnits="userSpaceOnUse"
          id="nav-icon-gradient-stops"
          x1="3"
          x2="21"
          y1="3"
          y2="21"
        >
          <stop offset="0" style={{ stopColor: "color-mix(in oklab, var(--amber) 82%, black)" }} />
          <stop offset="0.9" style={{ stopColor: "color-mix(in oklab, var(--teal) 82%, black)" }} />
        </linearGradient>
      </defs>
    </svg>
  );
}
