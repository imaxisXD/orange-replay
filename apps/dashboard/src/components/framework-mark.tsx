import type { IconComponentProps } from "@/lib/icon-map";

/**
 * Brand marks for the frameworks the install step can target.
 *
 * `docs/design-language.md` sanctions brand entities as glyphs wherever they
 * appear, because a recognizable mark is read faster than its name. Browsers and
 * operating systems get theirs from the Hugeicons family via `icon-map`;
 * frameworks have none there, so these are the marks `landing/index.html`
 * already ships under "Works with". Copied rather than reinvented so the
 * product and the marketing page show the same five logos.
 *
 * They are the deliberate exception to `currentColor`: a brand mark's colour is
 * the identifying feature, so these carry their own. The install step
 * desaturates the unselected ones in CSS instead, which keeps the tab row from
 * reading as five competing logos while leaving each mark itself untouched.
 *
 * Shaped like `IconComponent` so they drop straight into `TabItem`'s `icon`.
 * `strokeWidth` is accepted and ignored: these are filled paths.
 */
export function ReactMark({ size = 16, strokeWidth: _strokeWidth, ...props }: IconComponentProps) {
  return (
    <svg fill="none" height={size} viewBox="0 0 24 24" width={size} {...props}>
      <circle cx="12" cy="12" fill="#61dafb" r="2" />
      <g fill="none" opacity="0.85" stroke="#61dafb" strokeWidth="1">
        <ellipse cx="12" cy="12" rx="10" ry="4" />
        <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)" />
        <ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)" />
      </g>
    </svg>
  );
}

export function NextMark({ size = 16, strokeWidth: _strokeWidth, ...props }: IconComponentProps) {
  return (
    <svg fill="none" height={size} viewBox="0 0 24 24" width={size} {...props}>
      <circle cx="12" cy="12" fill="#fff" r="11" />
      <path d="M9 7v10M9 7l7 10M16 7v6" stroke="#000" strokeLinecap="round" strokeWidth="1.6" />
    </svg>
  );
}

export function VueMark({ size = 16, strokeWidth: _strokeWidth, ...props }: IconComponentProps) {
  return (
    <svg fill="none" height={size} viewBox="0 0 24 24" width={size} {...props}>
      <path d="M2 3h4l6 10L18 3h4L12 21z" fill="#41b883" />
      <path d="M6 3h3l3 5 3-5h3L12 14z" fill="#35495e" />
    </svg>
  );
}

export function SvelteMark({ size = 16, strokeWidth: _strokeWidth, ...props }: IconComponentProps) {
  return (
    <svg fill="none" height={size} viewBox="0 0 24 24" width={size} {...props}>
      <path
        d="M18.7 4.6c-2-2.9-6-3.8-8.9-2L5 5.5A5.6 5.6 0 0 0 3.3 13a5.3 5.3 0 0 0-.8 2 5.7 5.7 0 0 0 1 4.3c2 2.9 6 3.8 8.9 2l4.8-3a5.6 5.6 0 0 0 1.7-7.4 5.3 5.3 0 0 0 .8-2 5.7 5.7 0 0 0-1-4.3z"
        fill="#ff3e00"
      />
    </svg>
  );
}
