import { describe, expect, it } from "vite-plus/test";
import { sanitizeReplayCss } from "../src/css.ts";

describe("replay CSS sanitizer", () => {
  it("keeps layout, variables, media queries, and animation rules", () => {
    const css = `
      :root { --brand: #f59e0b; }
      .card { display: grid; gap: 12px; color: var(--brand); }
      @media (min-width: 800px) { .card { grid-template-columns: 1fr 1fr; } }
      @keyframes enter { from { opacity: 0; } to { opacity: 1; } }
    `;

    const sanitized = sanitizeReplayCss(css, "stylesheet");

    expect(sanitized).toContain(":root{--brand: #f59e0b}");
    expect(sanitized).toContain("display:grid");
    expect(sanitized).toContain("@media (min-width:800px)");
    expect(sanitized).toContain("@keyframes enter");
  });

  it("removes imports and neutralizes external image URLs", () => {
    const sanitized = sanitizeReplayCss(
      '@import "https://private.example/app.css"; .hero { background: url(https://private.example/hero.png) }',
      "stylesheet",
    );

    expect(sanitized).toBe(".hero{background:url(data:,)}");
  });

  it("decodes escaped URL function names before cleaning them", () => {
    const escapedUrl = String.raw`\75rl(https://private.example/hero.png)`;

    expect(sanitizeReplayCss(escapedUrl, "value")).toBe("url(data:,)");
  });

  it("rewrites captured stylesheets, fonts, and images to local blob URLs", () => {
    const rewrittenKinds: string[] = [];
    const sanitized = sanitizeReplayCss(
      '@import "https://cdn.example/app.css"; @font-face { src: url(https://cdn.example/font.woff2) } .hero { background: url(https://cdn.example/hero.webp) }',
      "stylesheet",
      (_url, kind) => {
        rewrittenKinds.push(kind);
        return `blob:https://replay.local/${kind}`;
      },
    );

    expect(sanitized).toContain('@import "blob:https://replay.local/stylesheet"');
    expect(sanitized).toContain("url(blob:https://replay.local/font)");
    expect(sanitized).toContain("url(blob:https://replay.local/image)");
    expect(rewrittenKinds).toEqual(["stylesheet", "font", "image"]);
  });

  it("keeps safe inline images and same-document SVG references", () => {
    const safeSvg =
      "data:image/svg+xml,%3Csvg%20xmlns='http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%3E%3Cpath%20d='M0%200h1v1z'%2F%3E%3C%2Fsvg%3E";

    expect(sanitizeReplayCss(`url(${safeSvg})`, "value")).toBe(`url(${safeSvg})`);
    expect(sanitizeReplayCss("url(#card-shadow)", "value")).toBe("url(#card-shadow)");
  });

  it("rejects active inline SVG and old executable CSS", () => {
    const activeSvg =
      "data:image/svg+xml,%3Csvg%20xmlns='http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg'%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E%3C%2Fsvg%3E";
    const sanitized = sanitizeReplayCss(
      `.image { background: url(${activeSvg}); behavior: url(run.htc); width: expression(alert(1)); color: red; }`,
      "stylesheet",
    );

    expect(sanitized).toBe(".image{background:url(data:,);color:red}");
  });

  it("preserves unknown CSS when parsing fails because the frame policy blocks network access", () => {
    expect(sanitizeReplayCss("}", "stylesheet")).toBe("}");
  });
});
