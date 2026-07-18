import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { BrandMark } from "@/components/brand-mark";
import { EmberField } from "@/components/ember-field";
import { ArrowUpRight } from "@/lib/icon-map";

/* Demo-banner design lab. Every variant is a full-width strip rendered in the
   position it would occupy in the shell (directly under the tab nav), so the
   comparison is honest. Lab-only keyframes live in the <style> block below,
   prefixed bl- so they can't collide with production CSS. */

interface BannerConcept {
  label: string;
  title: string;
  rationale: string;
  render: () => React.ReactNode;
}

const labKeyframes = `
@media (prefers-reduced-motion: no-preference) {
  .bl-rec-dot { animation: bl-rec-pulse 1.6s ease-in-out infinite; }
  .bl-playhead { animation: bl-playhead-sweep 9s linear infinite; }
  .bl-ghost { animation: bl-ghost-travel 7s ease-in-out infinite; }
  .bl-ghost-ripple { animation: bl-ghost-click 7s ease-out infinite; }
}
@keyframes bl-rec-pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 6px oklch(0.637 0.237 25.331 / 0.7); }
  50% { opacity: 0.35; box-shadow: 0 0 0 oklch(0.637 0.237 25.331 / 0); }
}
@keyframes bl-playhead-sweep {
  0% { left: 0%; }
  100% { left: 100%; }
}
@keyframes bl-ghost-travel {
  0% { transform: translateX(0) translateY(2px); opacity: 0; }
  8% { opacity: 0.9; }
  38% { transform: translateX(31vw) translateY(-3px); }
  56% { transform: translateX(42vw) translateY(4px); }
  60% { transform: translateX(42vw) translateY(4px); }
  92% { opacity: 0.9; }
  100% { transform: translateX(72vw) translateY(-2px); opacity: 0; }
}
@keyframes bl-ghost-click {
  0%, 56% { transform: scale(0.2); opacity: 0; }
  60% { transform: scale(0.2); opacity: 0.8; }
  70% { transform: scale(1); opacity: 0; }
  100% { transform: scale(1); opacity: 0; }
}
@media (prefers-reduced-motion: no-preference) {
  .bl-aurora { animation: bl-aurora-drift 11s ease-in-out infinite alternate; }
}
@keyframes bl-aurora-drift {
  0% { transform: translateX(-15%); }
  100% { transform: translateX(240%); }
}
`;

function StartFreeCta({ inverted = false }: { inverted?: boolean }) {
  return (
    <Link
      className={
        inverted
          ? "demo-cta group ml-auto flex items-center gap-2.5 rounded-[9px] bg-black py-1.25 pl-3.25 pr-1.5 text-[14px] font-[550] tracking-[-0.01em] text-white"
          : "demo-cta group ml-auto flex items-center gap-2.5 rounded-[9px] bg-white py-1.25 pl-3.25 pr-1.5 text-[14px] font-[550] tracking-[-0.01em] text-black"
      }
      to="/login"
    >
      Start free
      <span
        className={
          inverted
            ? "flex size-5.5 items-center justify-center rounded-full bg-white text-black"
            : "flex size-5.5 items-center justify-center rounded-full bg-black text-white"
        }
      >
        <ArrowUpRight
          className="transition-transform duration-200 ease-out group-hover:rotate-45"
          size={13}
          strokeWidth={1.5}
        />
      </span>
    </Link>
  );
}

/* V1 — the shipped banner, verbatim, as the baseline. */
function BannerCurrent() {
  return (
    <div className="demo-banner border-b border-dashed border-amber/25 px-4 py-1.5 sm:px-7">
      <span aria-hidden className="demo-beam" />
      <div className="mx-auto flex max-w-300 items-center gap-3">
        <span aria-hidden className="demo-scan-dot max-sm:hidden" />
        <p className="text-[12.5px] text-muted-foreground max-sm:hidden">
          Our <strong className="font-semibold text-foreground">own</strong> landing page, recorded
          with our <strong className="font-semibold text-foreground">own</strong> product.{" "}
          <span className="text-foreground">
            Look closely — you might{" "}
            <mark className="rounded-[3px] bg-amber/15 px-1 text-amber">spot yourself.</mark>
          </span>
        </p>
        <StartFreeCta />
      </div>
    </div>
  );
}

/* V2 — recording chrome: the banner behaves like a recorder instead of
   describing one. Pulsing REC pill plus a live timecode in tabular mono. */
function BannerRecording() {
  const [seconds, setSeconds] = useState(41);
  useEffect(() => {
    const id = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");

  return (
    <div className="demo-banner border-b border-dashed border-amber/25 px-4 py-1.5 sm:px-7">
      <div className="mx-auto flex max-w-300 items-center gap-3.5">
        <span className="flex items-center gap-2 rounded-full border border-danger/30 bg-danger/10 px-2.5 py-0.75">
          <span aria-hidden className="bl-rec-dot size-1.5 rounded-full bg-danger" />
          <span className="font-mono text-[10px] tracking-[0.08em] text-danger">REC</span>
          <span className="font-mono text-[10.5px] tabular-nums text-foreground/80">
            {mm}:{ss}
          </span>
        </span>
        <p className="text-[12.5px] text-muted-foreground max-sm:hidden">
          This dashboard is recording itself.{" "}
          <span className="text-foreground">
            Open Sessions in a minute — you&apos;ll be in there.
          </span>
        </p>
        <StartFreeCta />
      </div>
    </div>
  );
}

/* V3 — replay timeline: the bottom edge is a miniature session timeline —
   event ticks in event-kind colors, swept by a playhead with a knob. */
function BannerTimeline() {
  const ticks: Array<{ left: string; color: string }> = [
    { left: "7%", color: "var(--amber)" },
    { left: "16%", color: "var(--teal)" },
    { left: "22%", color: "var(--amber)" },
    { left: "37%", color: "var(--player-blue, #60a5fa)" },
    { left: "51%", color: "var(--amber)" },
    { left: "63%", color: "var(--teal)" },
    { left: "72%", color: "var(--amber)" },
    { left: "88%", color: "var(--player-blue, #60a5fa)" },
  ];
  return (
    <div className="demo-banner px-4 pb-2 pt-1.5 sm:px-7">
      <div className="mx-auto flex max-w-300 items-center gap-3">
        <p className="text-[12.5px] text-muted-foreground max-sm:hidden">
          These are real sessions from our landing page —{" "}
          <span className="font-mono text-[11.5px] tabular-nums text-foreground">597</span> in the
          last seven days.{" "}
          <span className="text-foreground">One of the cursors might be yours.</span>
        </p>
        <StartFreeCta />
      </div>
      <div
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-px border-b border-dashed border-amber/25"
      >
        {ticks.map((tick) => (
          <span
            className="absolute bottom-0 h-1.5 w-px"
            key={tick.left}
            style={{ left: tick.left, background: tick.color, opacity: 0.7 }}
          />
        ))}
        <span className="bl-playhead absolute bottom-[-2.5px] h-0 w-0">
          <span className="absolute bottom-0 left-0 h-2.5 w-px bg-amber shadow-[0_0_8px_var(--amber-shadow)]" />
          <span className="absolute bottom-2 left-[-2px] size-1.25 rounded-full bg-amber shadow-[0_0_6px_var(--amber-shadow)]" />
        </span>
      </div>
    </div>
  );
}

/* V4 — ghost cursor: a faint cursor replays across the strip and clicks once.
   The banner shows a replay instead of talking about one. */
function BannerGhostCursor() {
  return (
    <div className="demo-banner border-b border-dashed border-amber/25 px-4 py-1.5 sm:px-7">
      <span
        aria-hidden
        className="bl-ghost pointer-events-none absolute left-6 top-1/2 z-10 -mt-1.5 max-sm:hidden"
      >
        <svg fill="none" height="13" viewBox="0 0 12 13" width="12">
          <path
            d="M1 1l3.2 10.2 2-4.3 4.4-1.6L1 1z"
            fill="oklch(0.92 0.07 85 / 0.75)"
            stroke="oklch(0.165 0.008 285.8)"
            strokeWidth="0.75"
          />
        </svg>
        <span className="bl-ghost-ripple absolute -left-1.5 -top-1.5 size-6 rounded-full border border-amber/60" />
      </span>
      <div className="mx-auto flex max-w-300 items-center gap-3">
        <p className="text-[12.5px] text-muted-foreground max-sm:hidden">
          That cursor was a real visitor.{" "}
          <span className="text-foreground">Yours is being recorded the same way, right now.</span>
        </p>
        <StartFreeCta />
      </div>
    </div>
  );
}

/* V5 — proof counter: the quiet option. No motion gimmick; mono receipts
   carry the whole argument. */
function BannerProof() {
  return (
    <div className="demo-banner border-b border-dashed border-amber/25 px-4 py-1.5 sm:px-7">
      <div className="mx-auto flex max-w-300 items-center gap-3">
        <span className="flex items-center gap-2.5 font-mono text-[10.5px] tabular-nums tracking-[0.04em] text-muted-foreground max-sm:hidden">
          <span>
            <span className="text-foreground">597</span> sessions
          </span>
          <span className="text-divider">·</span>
          <span>
            <span className="text-foreground">7</span> days
          </span>
          <span className="text-divider">·</span>
          <span>
            <span className="text-amber">0</span> code changes
          </span>
        </span>
        <p className="text-[12.5px] text-muted-foreground max-sm:hidden">
          Our landing page, recorded by the snippet you&apos;d install.
        </p>
        <StartFreeCta />
      </div>
    </div>
  );
}

/* V6 — amber ledge: the loud calibration point. The whole strip takes the
   mark treatment and the CTA inverts to black-on-white against it. */
function BannerAmberLedge() {
  return (
    <div className="relative border-b border-amber/40 bg-[linear-gradient(180deg,oklch(0.784_0.159_72.991/0.16),oklch(0.784_0.159_72.991/0.08))] px-4 py-1.5 sm:px-7">
      <span aria-hidden className="absolute inset-x-0 top-0 h-px bg-amber/50" />
      <div className="mx-auto flex max-w-300 items-center gap-3">
        <span aria-hidden className="demo-scan-dot max-sm:hidden" />
        <p className="text-[12.5px] text-foreground/90 max-sm:hidden">
          Our own landing page, recorded with our own product.{" "}
          <span className="font-medium text-foreground">
            Look closely — you might spot yourself.
          </span>
        </p>
        <StartFreeCta />
      </div>
    </div>
  );
}

/* V7 — aurora rail: a floating rounded bar inset from the panel edges, with a
   slow amber-to-teal aurora drifting through the dark surface. Paired actions
   on the right, message anchored by the brand mark on the left. */
function BannerAuroraRail() {
  return (
    <div className="px-3 py-2 sm:px-4">
      <div className="relative flex items-center gap-3 overflow-hidden rounded-xl border border-border bg-[oklch(0.15_0.008_285.8)] px-3.5 py-2 sm:px-4">
        <span
          aria-hidden
          className="bl-aurora pointer-events-none absolute -inset-y-6 left-0 w-2/5 bg-[linear-gradient(90deg,transparent,oklch(0.784_0.159_72.991/0.24),oklch(0.72_0.11_180/0.16),transparent)] blur-2xl"
        />
        <BrandMark className="size-5 shrink-0" />
        <p className="relative text-[12.5px] text-muted-foreground max-sm:hidden">
          <span className="font-mono text-[11.5px] tabular-nums text-foreground">597</span> sessions
          recorded from our landing page this week.{" "}
          <span className="text-foreground">You&apos;re watching them, no login.</span>
        </p>
        <button
          className="relative ml-auto text-[12.5px] text-muted-foreground transition-colors hover:text-foreground"
          type="button"
        >
          Dismiss
        </button>
        <StartFreeCta />
      </div>
    </div>
  );
}

/* V8 — live presence: avatar social proof adapted to a replay product — the
   "community" is whoever is on the landing page right now. */
function BannerPresence() {
  const visitorGradients = [
    "linear-gradient(135deg,var(--teal-soft),var(--teal))",
    "linear-gradient(135deg,oklch(0.85 0.1 85),var(--amber))",
    "linear-gradient(135deg,oklch(0.8 0.08 250),oklch(0.62 0.17 255))",
  ];
  return (
    <div className="demo-banner border-b border-dashed border-amber/25 px-4 py-2 sm:px-7">
      <div className="mx-auto flex max-w-300 items-center gap-3">
        <span className="flex -space-x-1.5 max-sm:hidden">
          {visitorGradients.map((gradient) => (
            <span
              aria-hidden
              className="size-5 rounded-full border-2 border-[oklch(0.165_0.008_285.8)]"
              key={gradient}
              style={{ background: gradient }}
            />
          ))}
        </span>
        <p className="text-[12.5px] text-muted-foreground max-sm:hidden">
          <span className="font-mono text-[11.5px] tabular-nums text-foreground">3</span> people are
          on our landing page right now.{" "}
          <span className="text-foreground">
            Their sessions land here about a minute after they leave.
          </span>
        </p>
        <StartFreeCta />
      </div>
    </div>
  );
}

/* V9 — hero cap: two-line headline + subline hierarchy with an amber contour
   pattern fading in from the right edge — the decorative-cap idea folded into
   a strip instead of stacked above it. */
function BannerHeroCap() {
  return (
    <div className="demo-banner border-b border-dashed border-amber/25 px-4 py-2.5 sm:px-7">
      <svg
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 h-full w-72 [mask-image:linear-gradient(90deg,transparent,black_45%)]"
        fill="none"
        preserveAspectRatio="none"
        viewBox="0 0 280 48"
      >
        <path
          d="M0 36 C 40 8, 82 44, 124 22 S 210 34, 280 10"
          stroke="oklch(0.784 0.159 72.991 / 0.2)"
          strokeWidth="1.5"
        />
        <path
          d="M0 16 C 52 42, 96 2, 148 28 S 232 6, 280 32"
          stroke="oklch(0.784 0.159 72.991 / 0.12)"
          strokeWidth="1.5"
        />
        <path
          d="M120 44 c -14 -26, 28 -32, 22 -8 c -5 20, -34 12, -22 8 Z"
          stroke="oklch(0.72 0.11 180 / 0.16)"
          strokeWidth="1.5"
        />
      </svg>
      <div className="mx-auto flex max-w-300 items-center gap-4">
        <div className="min-w-0 max-sm:hidden">
          <p className="text-[13px] font-medium tracking-[-0.005em] text-foreground">
            Our own landing page, recorded with our own product.
          </p>
          <p className="mt-0.5 text-[12px] text-muted-foreground">
            Every session here was captured by the snippet you&apos;d install — look closely, you
            might spot yourself.
          </p>
        </div>
        <StartFreeCta />
      </div>
    </div>
  );
}

/* V11 — the inverted rail: the maximum-contrast answer. A near-white surface
   on the dark canvas, dark ember dots along its bottom edge, and the CTA
   flipped to black so it stays the strongest object on the strip. */
function BannerInvertedRail() {
  return (
    <div className="px-1.5 py-1.5 sm:px-2">
      <div className="relative flex items-center gap-4 overflow-hidden rounded-xl bg-[oklch(0.96_0.004_285)] px-4 py-2.5 shadow-[0_10px_30px_oklch(0_0_0/0.45)] sm:px-5">
        <span
          aria-hidden
          className="bl-aurora pointer-events-none absolute -inset-y-8 left-0 w-2/5 bg-[linear-gradient(90deg,transparent,oklch(0.784_0.159_72.991/0.25),transparent)] blur-2xl"
        />
        <EmberField className="inset-x-0 bottom-0 h-full w-full text-black" />
        {/* The mark is a white asset — it needs a dark tile to exist on this surface. */}
        <span className="relative flex size-7 shrink-0 items-center justify-center rounded-lg bg-black">
          <BrandMark className="size-4.5" />
        </span>
        <div className="relative min-w-0 max-sm:hidden">
          <p className="text-[13px] font-medium tracking-[-0.005em] text-black">
            <span className="font-mono text-[12px] tabular-nums text-[oklch(0.55_0.14_73)]">
              597
            </span>{" "}
            sessions recorded from our landing page this week.
          </p>
          <p className="mt-0.5 text-[12px] text-black/55">
            You&apos;re watching them right now — no login, nothing staged.
          </p>
        </div>
        <button
          className="relative ml-auto text-[12.5px] text-black/50 transition-colors hover:text-black"
          type="button"
        >
          Dismiss
        </button>
        <StartFreeCta inverted />
      </div>
    </div>
  );
}

/* V10 — teal ember rail: a taller teal rail hugging the panel edges, carrying
   the current banner's copy. One diagonal patch of ember dots at the right,
   fading out toward the edge; text and CTA on top. */
function BannerAuroraEmber() {
  return (
    <div className="px-1.5 py-1.5 sm:px-2">
      <div className="relative flex items-center gap-4 overflow-hidden rounded-xl border border-teal/25 bg-[linear-gradient(90deg,oklch(0.125_0.005_285),oklch(0.17_0.032_205))] px-4 py-4 sm:px-5">
        {/* Layer 2: ember dots owning the whole right end, emerging along a
            diagonal and densest into the corner. */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-2/5 [mask-image:linear-gradient(105deg,transparent_8%,black_55%)]"
        >
          <EmberField
            className="inset-0 h-full w-full text-teal"
            fadePerRow={0.045}
            intensity={3.5}
            pulse={1.8}
          />
        </span>
        {/* Layer 1 (front): text and CTA. */}
        <p className="relative text-[14px] font-medium tracking-[-0.005em] text-foreground max-sm:hidden">
          Our own landing page, recorded with our own product.{" "}
          <span className="text-teal">Look closely — you might spot yourself.</span>
        </p>
        <StartFreeCta />
      </div>
    </div>
  );
}

const concepts: BannerConcept[] = [
  {
    label: "V1",
    title: "Current — playhead beam",
    rationale:
      "The shipped banner: grain strip, amber corner bloom, scan dot, and a beam that sweeps the dashed bottom edge like a playhead. Baseline for every comparison below.",
    render: () => <BannerCurrent />,
  },
  {
    label: "V2",
    title: "Recording chrome",
    rationale:
      "Instead of describing recording, the banner behaves like a recorder: a pulsing REC pill and a live timecode in tabular mono. The proof is that the number is moving.",
    render: () => <BannerRecording />,
  },
  {
    label: "V3",
    title: "Replay timeline",
    rationale:
      "The dashed bottom edge stops suggesting a timeline and becomes one: event ticks in event-kind colors, swept by a playhead with a knob. Borrows the session player's vocabulary verbatim.",
    render: () => <BannerTimeline />,
  },
  {
    label: "V4",
    title: "Ghost cursor",
    rationale:
      "A faint cursor replays across the strip and clicks once — a two-second demo of the product inside the banner. Highest delight, highest distraction risk on a strip that's always visible.",
    render: () => <BannerGhostCursor />,
  },
  {
    label: "V5",
    title: "Proof counter",
    rationale:
      "The quiet option: no motion at all. Mono receipts (597 sessions · 7 days · 0 code changes) do the persuading, per the copy-voice rule that specificity is the personality.",
    render: () => <BannerProof />,
  },
  {
    label: "V6",
    title: "Amber ledge",
    rationale:
      "The loud calibration point: the strip takes an amber tint like an inline <mark> stretched full-width. Almost certainly too much for a persistent surface — here to define the ceiling.",
    render: () => <BannerAmberLedge />,
  },
  {
    label: "V7",
    title: "Aurora rail",
    rationale:
      "A floating rounded bar inset from the panel, with a slow amber→teal aurora drifting through the dark surface. Reads as an announcement object rather than shell chrome — paired ghost + primary actions on the right.",
    render: () => <BannerAuroraRail />,
  },
  {
    label: "V8",
    title: "Live presence",
    rationale:
      "Avatar social proof translated to replay: the community pill becomes whoever is on the landing page right now, with the promise of when their sessions arrive. Wants a real live count to be honest.",
    render: () => <BannerPresence />,
  },
  {
    label: "V9",
    title: "Hero cap",
    rationale:
      "The card-header idea folded into a strip: headline + subline hierarchy gives the banner two lines of presence, and an amber contour pattern fades in from the right edge as the decorative cap.",
    render: () => <BannerHeroCap />,
  },
  {
    label: "V10",
    title: "Teal ember rail",
    rationale:
      "The teal contrast rail with the shipped banner's copy, taller for presence. The toast's ember dots gather into one diagonal patch at the right and dissolve toward the edge; text and CTA sit on top. No dismiss — the demo banner is the signup path.",
    render: () => <BannerAuroraEmber />,
  },
  {
    label: "V11",
    title: "Inverted rail — white",
    rationale:
      "The maximum-contrast answer: a near-white rail floating on the dark canvas, dark ember dots, amber numeral, and the CTA flipped to black so it stays the strongest object on the strip. Nothing on the dashboard competes with it.",
    render: () => <BannerInvertedRail />,
  },
];

export function BannerLabPage() {
  return (
    <div className="flex flex-col gap-5">
      <style>{labKeyframes}</style>
      <header className="flex max-w-2xl flex-col gap-1.5">
        <h1 className="text-[18px] font-semibold leading-[1.1] tracking-[-0.015em]">Banner lab</h1>
        <p className="text-[13px] text-muted-foreground">
          Demo-banner concepts, each rendered full-width in the position it would occupy under the
          tab nav. Judge them as a persistent strip: seen on every demo page, hundreds of times.
        </p>
      </header>

      {concepts.map((concept) => (
        <section className="lit overflow-hidden rounded-lg" key={concept.label}>
          <div className="border-b border-border px-5 py-4">
            <h2 className="flex items-baseline gap-3 text-[13px] font-semibold leading-tight text-foreground">
              <span className="font-mono text-[11px] font-normal text-muted-foreground">
                {concept.label}
              </span>
              {concept.title}
            </h2>
            <p className="mt-1 max-w-2xl text-[13px] text-muted-foreground">{concept.rationale}</p>
          </div>
          {/* Fake tab-nav ledge above the banner so each strip sits in its real context. */}
          <div className="border-b border-border px-5 py-2">
            <span className="inline-block border-b-2 border-amber pb-1 text-[12px] font-medium text-foreground">
              Overview
            </span>
          </div>
          <div className="relative overflow-hidden">{concept.render()}</div>
          <div className="h-10 bg-background/40" />
        </section>
      ))}
    </div>
  );
}
