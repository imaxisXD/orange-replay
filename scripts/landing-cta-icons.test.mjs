import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";

const landingPage = new URL("../landing/index.html", import.meta.url);

describe("landing final CTA icons", () => {
  it("keeps the CTA copy in one left-aligned editorial flow", async () => {
    const html = await readFile(landingPage, "utf8");

    expect(html.match(/class="cta-phrase"/g)).toHaveLength(3);
    expect(html.match(/class="cta-phrase-tail"/g)).toHaveLength(3);
    expect(html).toMatch(/See what happened\.\s*<span class="cta-phrase"/);
    expect(html).toMatch(/and\s*<span class="cta-phrase"\s*>\s*<span class="thumb thumb-tick"/);
    expect(html).toContain('<span class="w">before it becomes a support ticket.</span>');
    expect(html).toMatch(
      /\.cta-band \.bigline \{[^}]*text-align: left;[^}]*text-wrap: balance;[^}]*max-width: 1120px;[^}]*font-size: clamp\(2\.3rem, 5\.6vw, 4\.6rem\);[^}]*line-height: 1\.1;/s,
    );
    expect(html).toMatch(
      /\.bigline \.cta-phrase \{[^}]*display: inline-flex;[^}]*align-items: center;[^}]*white-space: nowrap;[^}]*vertical-align: -0\.12em;/s,
    );
    expect(html).not.toContain('class="cta-action-stack"');
    expect(html).not.toContain('class="cta-action-row"');
    expect(html).not.toContain('class="cta-support"');
  });

  it("uses the requested rounded Hugeicons glyphs", async () => {
    const html = await readFile(landingPage, "utf8");

    expect(html).toMatch(/class="cta-action-label c-blue">Record<\/span\s*>/);
    expect(html).toMatch(/class="cta-action-label c-amber">replay<\/span\s*>/);
    expect(html).toMatch(/class="cta-action-label c-green">fix<\/span\s*>/);
    expect(html).toMatch(
      /\.bigline \.cta-action-label \{[^}]*background: #18181b;[^}]*vertical-align: middle;/s,
    );
    expect(html).toMatch(/\.bigline \.thumb \{[^}]*border-right: 0;[^}]*background: #18181b;/s);

    expect(html.indexOf('class="thumb thumb-camera"')).toBeLessThan(
      html.indexOf('class="cta-action-label c-blue"'),
    );
    expect(html.indexOf('class="thumb thumb-cassette"')).toBeLessThan(
      html.indexOf('class="cta-action-label c-amber"'),
    );
    expect(html.indexOf('class="thumb thumb-tick"')).toBeLessThan(
      html.indexOf('class="cta-action-label c-green"'),
    );

    expect(html).toContain('class="thumb thumb-camera"');
    expect(html).toContain('data-icon="camera-video"');
    expect(html).toContain('d="M4.5 21.5L8.5 17.5M10.5 17.5L14.5 21.5M9.5 17.5L9.5 22.5"');
    expect(html).toContain('<circle cx="12.5" cy="5" r="2.5"');
    expect(html).toMatch(/<circle\s+cx="7"\s+cy="4\.5"\s+r="3"/);

    expect(html).toContain('class="thumb thumb-cassette"');
    expect(html).toContain('data-icon="cassette-tape"');
    expect(html).toContain(
      'd="M15 20H9C5.70017 20 4.05025 20 3.02513 18.9749C2 17.9497 2 16.2998 2 13V11',
    );
    expect(html).toContain('d="M8 12H16M8 8H16"');

    expect(html).toContain('class="thumb thumb-tick"');
    expect(html).toContain('data-icon="tick-04"');
    expect(html).toContain('d="M21.8606 5.39176C22.2875 6.49635 21.6888 7.2526 20.5301 7.99754');

    expect(html).not.toContain('points="4,20 12,14 18,22 26,8 32,18 40,10 48,24 58,12"');
    expect(html).not.toContain('d="M26 10l12 6-12 6z"');
    expect(html).not.toContain('d="M20 17l5 5 12-12"');
  });
});
