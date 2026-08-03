import { buildLoaderScriptTag, buildLoaderSnippet } from "@orange-replay/sdk/loader";
import { describe, expect, it } from "vite-plus/test";
import { HtmlFile, TypescriptFile } from "../src/lib/icon-map";
import {
  DEFAULT_INSTALL_TARGET,
  INSTALL_TARGETS,
  buildInstallPreviewSummary,
  buildInstallSnippet,
  buildInstallSummary,
  findInstallTarget,
  installProseParts,
} from "../src/routes/onboarding/install-targets";

const loaderConfig = {
  bundleUrl: "https://replay.example.com/or-recorder.js",
  init: { ingestUrl: "https://replay.example.com", key: `or_live_${"a".repeat(32)}` },
};
const loader = {
  body: buildLoaderSnippet(loaderConfig),
  tag: buildLoaderScriptTag(loaderConfig),
};

describe("install targets", () => {
  it("defaults to the instruction that is true on every stack", () => {
    expect(DEFAULT_INSTALL_TARGET).toBe("html");
    expect(INSTALL_TARGETS[0]?.id).toBe("html");
  });

  it("gives every target a mark, a file and a placement", () => {
    for (const target of INSTALL_TARGETS) {
      expect(target.mark, `${target.id} has no mark`).toBeTypeOf("function");
      expect(target.siteMark, `${target.id} has no file-type mark`).toBeTypeOf("function");
      expect(target.site.length, `${target.id} names no file`).toBeGreaterThan(0);
      expect(target.instruction.length, `${target.id} has no placement`).toBeGreaterThan(20);
      // Backticks are the inline-code marker, so an unclosed one would render a
      // whole sentence as a mono chip.
      expect(target.instruction.split("`").length % 2, `${target.id} has an odd backtick`).toBe(1);
      expect(target.site.split("`").length % 2, `${target.id} has an odd backtick`).toBe(1);
    }
  });

  it("keeps voice rules the whole product follows", () => {
    for (const target of INSTALL_TARGETS) {
      // docs/copy-voice.md: never an em dash, no exceptions.
      expect(target.instruction, `${target.id} uses an em dash`).not.toContain("—");
      expect(target.instruction.endsWith("."), `${target.id} is not a sentence`).toBe(true);
    }
  });

  it("marks a .tsx target as TypeScript and the rest as HTML", () => {
    const targets = new Map(INSTALL_TARGETS.map((target) => [target.id, target]));

    // Identity, not name: every `icon-map` glyph is the same wrapped function.
    expect(targets.get("next")?.siteMark).toBe(TypescriptFile);
    expect(targets.get("next")?.siteMarkClass).toContain("#3178c6");
    for (const id of ["html", "react", "vue", "svelte"] as const) {
      expect(targets.get(id)?.siteMark, `${id} does not paste into HTML`).toBe(HtmlFile);
      expect(targets.get(id)?.siteMarkClass).toContain("#e34c26");
    }
  });

  it("falls back to HTML for an unknown stack", () => {
    expect(findInstallTarget("solid").id).toBe("html");
    expect(findInstallTarget("next").label).toBe("Next.js");
  });

  it("pastes the loader tag verbatim everywhere but Next.js", () => {
    for (const target of INSTALL_TARGETS) {
      if (target.id === "next") continue;
      expect(buildInstallSnippet(target.id, loader)).toBe(loader.tag);
    }
  });

  it("wraps Next.js in next/script at beforeInteractive", () => {
    const snippet = buildInstallSnippet("next", loader);

    expect(snippet).toContain('import Script from "next/script"');
    expect(snippet).toContain('strategy="beforeInteractive"');
    // Inline next/script needs an id, and the recorder key still has to survive.
    expect(snippet).toContain('id="orange-replay"');
    expect(snippet).toContain(loaderConfig.init.key);
    // The body goes inside a template literal, never a raw <script> tag.
    expect(snippet).not.toContain("<script>");
  });

  it("escapes the loader body for the template literal it lands in", () => {
    const hostile = { body: "a`b${c}d\\e", tag: "<script></script>" };
    const snippet = buildInstallSnippet("next", hostile);

    expect(snippet).toContain("a\\`b\\${c}d\\\\e");
  });

  it("builds nothing before the key exists", () => {
    expect(buildInstallSnippet("react", { body: "", tag: "" })).toBe("");
    expect(buildInstallSummary("react", 0)).toContain("Your loader tag appears here.");
  });

  it("states the real byte count of what Copy will paste", () => {
    const snippet = buildInstallSnippet("react", loader);
    const summary = buildInstallSummary("react", snippet.length);

    expect(summary).toContain(`${snippet.length.toLocaleString("en-US")} bytes`);
    expect(summary).toContain("<script>");
    // A summary that leaked the key would defeat the point of collapsing it.
    expect(summary).not.toContain(loaderConfig.init.key);
  });

  it("uses the real copied size in the dashboard preview", () => {
    for (const target of INSTALL_TARGETS) {
      const snippet = buildInstallSnippet(target.id, loader);
      expect(buildInstallPreviewSummary(target.id, "https://replay.example.com")).toBe(
        buildInstallSummary(target.id, snippet.length),
      );
    }
  });

  it("summarises Next.js in the shape Next.js pastes", () => {
    const summary = buildInstallSummary("next", 2_048);

    expect(summary).toContain("<Script");
    expect(summary).toContain("{/* Orange Replay loader, 2,048 bytes */}");
  });
});

describe("install prose", () => {
  it("splits backticked code out of a sentence", () => {
    expect(installProseParts("Paste it before `</head>`. Done.")).toEqual([
      { code: false, text: "Paste it before " },
      { code: true, text: "</head>" },
      { code: false, text: ". Done." },
    ]);
  });

  it("reads a bare path as one code part", () => {
    expect(installProseParts("`index.html`")).toEqual([{ code: true, text: "index.html" }]);
  });

  it("passes plain prose through untouched", () => {
    expect(installProseParts("Every page")).toEqual([{ code: false, text: "Every page" }]);
  });
});
