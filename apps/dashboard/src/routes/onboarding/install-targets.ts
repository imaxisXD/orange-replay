import { NextMark, ReactMark, SvelteMark, VueMark } from "@/components/framework-mark";
import { Code2, HtmlFile, TypescriptFile, type IconComponent } from "@/lib/icon-map";
import { buildLoaderScriptTag, buildLoaderSnippet } from "@orange-replay/sdk/loader";

/**
 * The install step's framework targets.
 *
 * The loader is one inline tag, so on most stacks the paste is identical and
 * only the file changes. That file is the whole question a visitor is actually
 * asking on this step ("where does this go in *my* project"), which is why it
 * leads each target instead of being buried in prose. Next.js is the one target
 * whose code genuinely differs: App Router owns script ordering, so the tag goes
 * through `next/script` rather than into markup.
 *
 * Prose fields use markdown-style backticks for inline code. `installProseParts`
 * turns them into segments; nothing here renders itself, so this table stays
 * testable and the component stays presentational.
 */
/** HTML5 vermilion and TypeScript blue, the colours each language ships with. */
const HTML_MARK_CLASS = "text-[#e34c26]";
const TYPESCRIPT_MARK_CLASS = "text-[#3178c6]";

export type InstallTargetId = "html" | "react" | "next" | "vue" | "svelte";

export interface InstallTarget {
  /** Stable id. Also the tab value. */
  id: InstallTargetId;
  /** Tab label. Short: five of these share a 394px column. */
  label: string;
  /** Brand mark, or an in-family glyph where no brand mark exists. */
  mark: IconComponent;
  /** What the visitor is editing. Shown as the code card's own header. */
  site: string;
  /** The language of that file, so the header can carry its file-type mark. */
  siteMark: IconComponent;
  /**
   * The mark's brand colour. These glyphs are in-family outlines drawn in
   * `currentColor`, so the language's own colour is applied here rather than
   * baked into a second copy of the icon.
   */
  siteMarkClass: string;
  /** Where in it, plus the one fact that is only true for this target. */
  instruction: string;
}

/**
 * Plain HTML leads and is the default. It is the only instruction that is true
 * for every visitor, so a stack we do not list still reads correctly; the
 * framework tabs then narrow it to an exact file.
 */
const HTML_TARGET: InstallTarget = {
  id: "html",
  label: "HTML",
  mark: Code2,
  site: "Every page",
  siteMark: HtmlFile,
  siteMarkClass: HTML_MARK_CLASS,
  instruction:
    "Paste it just before `</head>`. Every page you want to record needs the tag, though a shared header include counts as one paste.",
};

export const INSTALL_TARGETS: readonly InstallTarget[] = [
  HTML_TARGET,
  {
    id: "react",
    label: "React",
    mark: ReactMark,
    site: "`index.html`",
    siteMark: HtmlFile,
    siteMarkClass: HTML_MARK_CLASS,
    instruction:
      "Paste it just before `</head>`. Vite and Create React App both ship this file with every build, so one paste covers every route.",
  },
  {
    id: "next",
    label: "Next.js",
    mark: NextMark,
    site: "`app/layout.tsx`",
    siteMark: TypescriptFile,
    siteMarkClass: TYPESCRIPT_MARK_CLASS,
    // Two code spans either side of a full stop rendered as one long mono run
    // on screen, so the strategy name stays in the code where it is visible
    // anyway and the sentence keeps a single chip.
    instruction:
      "Add it to your root layout, inside `<body>`. Next.js runs it before hydration, so the first clicks are already queued.",
  },
  {
    id: "vue",
    label: "Vue",
    mark: VueMark,
    site: "`index.html`",
    siteMark: HtmlFile,
    siteMarkClass: HTML_MARK_CLASS,
    instruction:
      "Paste it just before `</head>`. Vite ships this file with every build, so one paste covers every route.",
  },
  {
    id: "svelte",
    label: "Svelte",
    mark: SvelteMark,
    site: "`src/app.html`",
    siteMark: HtmlFile,
    siteMarkClass: HTML_MARK_CLASS,
    instruction:
      "SvelteKit renders every route through this shell. Paste it just before `%sveltekit.head%`.",
  },
];

export const DEFAULT_INSTALL_TARGET: InstallTargetId = HTML_TARGET.id;

export function findInstallTarget(id: string): InstallTarget {
  return INSTALL_TARGETS.find((target) => target.id === id) ?? HTML_TARGET;
}

/**
 * One run of prose, split on backticked code. Odd segments are code, which is
 * what lets a placement sentence carry `</head>` in mono without the component
 * knowing anything about the sentence.
 */
export interface InstallProsePart {
  code: boolean;
  text: string;
}

export function installProseParts(text: string): InstallProsePart[] {
  const parts: InstallProsePart[] = [];
  for (const [index, segment] of text.split("`").entries()) {
    if (segment.length === 0) continue;
    parts.push({ code: index % 2 === 1, text: segment });
  }
  return parts;
}

/**
 * What the Copy button puts on the clipboard for this target.
 *
 * Everything but Next.js pastes the loader tag verbatim. Next.js gets the
 * `next/script` form, because a raw inline tag in an App Router layout is
 * subject to Next's own script ordering, and `beforeInteractive` is the
 * documented way to ask for "before hydration". The loader body goes inside a
 * template literal, so it is escaped for one.
 */
export function buildInstallSnippet(
  id: InstallTargetId,
  loader: { body: string; tag: string },
): string {
  if (loader.tag.length === 0) return "";
  if (id !== "next") return loader.tag;

  return `import Script from "next/script";

<Script id="orange-replay" strategy="beforeInteractive">
  {\`${escapeForTemplateLiteral(loader.body)}\`}
</Script>`;
}

/**
 * A ready-to-paste request for a coding agent.
 *
 * The UI never renders this full text because the loader and its recorder key
 * would turn a short onboarding step into a wall of code. The compact agent row
 * says what is included, while Copy prompt hands this exact text to the user's
 * clipboard. The raw script tag is always present as the source of truth. A
 * Next.js selection also gets the exact framework-safe form so an agent does
 * not put a raw inline script inside JSX.
 */
export function buildAgentInstallPrompt(
  id: InstallTargetId,
  loader: { body: string; tag: string },
): string {
  if (loader.tag.length === 0) return "";

  const target = findInstallTarget(id);
  const lines = [
    "Install Orange Replay in this codebase.",
    "",
    "Inspect the existing app structure before editing. The selected setup is " +
      target.label +
      ".",
    `Suggested file: ${target.site}`,
    `Placement: ${target.instruction}`,
    "",
    "Use this exact script tag:",
    "```html",
    loader.tag,
    "```",
  ];

  if (id === "next") {
    lines.push(
      "",
      "For this Next.js setup, use this framework-safe version instead of putting a raw script tag inside JSX:",
      "```tsx",
      buildInstallSnippet(id, loader),
      "```",
    );
  }

  lines.push(
    "",
    "Requirements:",
    "- Load Orange Replay on every page.",
    "- Keep the loader code and recorder key exactly as provided.",
    "- If Orange Replay is already installed, update the existing install instead of adding a second copy.",
    "- Do not change unrelated files.",
    "- Run the smallest relevant check or build after editing.",
    "- Confirm the installed script appears once in the rendered page and does not add a browser error.",
    "",
    "When you finish, tell me which file you changed and what you verified. Do not repeat the recorder key in your reply.",
  );

  return lines.join("\n");
}

/**
 * Key-safe first view of the coding-agent request.
 *
 * It mirrors the collapsed loader card: enough real structure to identify what
 * Copy contains, without rendering the recorder key before the visitor asks to
 * inspect the full prompt.
 */
export function buildAgentPromptSummary(id: InstallTargetId): string {
  const target = findInstallTarget(id);
  const site = target.site.replaceAll("`", "");
  return [
    "Install Orange Replay in this codebase.",
    `Stack: ${target.label} · ${site}`,
    "Script tag and exact steps included.",
  ].join("\n");
}

/**
 * The collapsed card. The loader is one minified line around 1,800 characters
 * long: shown in full by default it fills the column with noise on a step whose
 * only job is "copy this". So the card states the shape and the real size, and
 * the full text is one click away.
 *
 * The size is the exact byte count of what Copy will paste, not a rounded claim.
 */
export function buildInstallSummary(id: InstallTargetId, bytes: number): string {
  if (bytes <= 0) return "<script>\n  /* Your loader tag appears here. */\n</script>";

  const comment = `Orange Replay loader, ${bytes.toLocaleString("en-US")} bytes`;
  if (id === "next") {
    return `<Script id="orange-replay" strategy="beforeInteractive">\n  {/* ${comment} */}\n</Script>`;
  }
  return `<script>\n  /* ${comment} */\n</script>`;
}

/**
 * The chosen stack's collapsed summary for the dashboard preview.
 *
 * The placeholder is never shown. It has the exact ASCII shape of a generated
 * recorder key, so measuring this snippet gives the same number as the real
 * script without putting the visitor's raw key inside the preview.
 */
export function buildInstallPreviewSummary(id: InstallTargetId, origin: string): string {
  const config = {
    bundleUrl: `${origin}/or-recorder.js`,
    init: { ingestUrl: origin, key: PREVIEW_RECORDER_KEY_FOR_SIZE },
  };
  const snippet = buildInstallSnippet(id, {
    body: buildLoaderSnippet(config),
    tag: buildLoaderScriptTag(config),
  });
  return buildInstallSummary(id, snippet.length);
}

const PREVIEW_RECORDER_KEY_FOR_SIZE = `or_live_${"x".repeat(32)}`;

function escapeForTemplateLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}
