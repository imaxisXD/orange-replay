import {
  generate,
  parse,
  walk,
  type Atrule,
  type CssNode,
  type List,
  type ListItem,
  type StringNode,
  type Url,
  type WalkContext,
} from "css-tree";

export type ReplayCssContext = "stylesheet" | "declarationList" | "value";
export type ReplayCssResourceKind = "stylesheet" | "font" | "image";
export type ReplayCssUrlRewriter = (url: string, kind: ReplayCssResourceKind) => string | undefined;

const EMPTY_REPLAY_ASSET_URL = "data:,";
const MAX_INLINE_ASSET_CHARACTERS = 2_000_000;
const BLOCKED_CSS_PROPERTIES = new Set(["behavior", "-moz-binding"]);
const IMAGE_STRING_FUNCTIONS = new Set(["cross-fade", "image", "image-set", "-webkit-image-set"]);

export function sanitizeReplayCss(
  css: string,
  context: ReplayCssContext,
  rewriteUrl?: ReplayCssUrlRewriter,
): string {
  let root: CssNode;
  try {
    root = parse(css, { context });
  } catch {
    const decoded = decodeCssEscapes(css);
    if (decoded !== css) {
      try {
        root = parse(decoded, { context });
      } catch {
        return sanitizeRawCssValue(decoded, rewriteUrl);
      }
    } else {
      return sanitizeRawCssValue(css, rewriteUrl);
    }
  }

  walk(root, {
    enter(this: WalkContext, node: CssNode, item: ListItem<CssNode>, list: List<CssNode>) {
      if (node.type === "Atrule" && decodeCssEscapes(node.name).toLowerCase() === "import") {
        const importTarget = readImportTarget(node);
        const rewritten =
          importTarget === undefined
            ? undefined
            : rewriteReplayUrl(importTarget.value, "stylesheet", rewriteUrl);

        if (importTarget === undefined || rewritten === undefined) {
          list.remove(item);
          return;
        }

        importTarget.value = rewritten;
        return;
      }

      if (node.type === "Declaration") {
        const property = decodeCssEscapes(node.property).toLowerCase();
        if (BLOCKED_CSS_PROPERTIES.has(property) || containsCssExpression(node.value)) {
          list.remove(item);
          return;
        }
      }

      if (node.type === "Raw") {
        const decoded = decodeCssEscapes(node.value);
        node.value = sanitizeRawCssValue(decoded, rewriteUrl);
        return;
      }

      if (node.type === "Url") {
        if (this.atrule?.name.toLowerCase() === "import") {
          return;
        }
        const kind =
          this.atrule?.name.toLowerCase() === "font-face" ||
          this.declaration?.property.toLowerCase() === "src"
            ? "font"
            : "image";
        node.value = rewriteReplayUrl(node.value, kind, rewriteUrl) ?? EMPTY_REPLAY_ASSET_URL;
        return;
      }

      if (
        node.type === "String" &&
        this.function !== null &&
        IMAGE_STRING_FUNCTIONS.has(this.function.name.toLowerCase())
      ) {
        node.value = rewriteReplayUrl(node.value, "image", rewriteUrl) ?? EMPTY_REPLAY_ASSET_URL;
      }
    },
  });

  try {
    return generate(root, { mode: "safe" });
  } catch {
    return css;
  }
}

export function isSafeInlineReplayUrl(url: string, kind: ReplayCssResourceKind): boolean {
  const normalized = url.trim();
  if (normalized === EMPTY_REPLAY_ASSET_URL) {
    return true;
  }

  if (normalized.length > MAX_INLINE_ASSET_CHARACTERS) {
    return false;
  }

  if (kind === "font") {
    return /^data:(?:font\/(?:woff2?|ttf|otf)|application\/(?:font-woff|font-sfnt|vnd\.ms-fontobject));base64,/i.test(
      normalized,
    );
  }

  if (kind === "image") {
    return (
      /^data:image\/(?:avif|gif|jpeg|png|webp);base64,/i.test(normalized) ||
      isSafeInlineSvg(normalized)
    );
  }

  return false;
}

function isSafeInlineSvg(value: string): boolean {
  const match = /^data:image\/svg\+xml(?:;charset=[^;,]+)?,(.*)$/is.exec(value);
  if (match === null) {
    return false;
  }

  let svg: string;
  try {
    svg = decodeURIComponent(match[1] ?? "");
  } catch {
    return false;
  }

  if (svg.length > 200_000) {
    return false;
  }

  return !(
    /<\s*(?:script|foreignObject|iframe|object|embed)\b/i.test(svg) ||
    /\son[a-z]+\s*=/i.test(svg) ||
    /@import\b/i.test(svg) ||
    /\b(?:href|xlink:href)\s*=\s*["'](?!#)/i.test(svg) ||
    /url\(\s*["']?(?!#|data:)/i.test(svg)
  );
}

function rewriteReplayUrl(
  url: string,
  kind: ReplayCssResourceKind,
  rewriteUrl: ReplayCssUrlRewriter | undefined,
): string | undefined {
  const normalized = url.trim();
  if (normalized.startsWith("#")) {
    return normalized;
  }

  if (isSafeInlineReplayUrl(normalized, kind)) {
    return normalized;
  }

  const rewritten = rewriteUrl?.(normalized, kind)?.trim();
  if (rewritten === undefined || rewritten.length === 0) {
    return undefined;
  }

  return rewritten.startsWith("blob:") || isSafeInlineReplayUrl(rewritten, kind)
    ? rewritten
    : undefined;
}

function readImportTarget(node: Atrule): StringNode | Url | undefined {
  if (node.prelude === null || node.prelude.type !== "AtrulePrelude") {
    return undefined;
  }

  const first = node.prelude.children.first;
  return first?.type === "String" || first?.type === "Url" ? first : undefined;
}

function containsCssExpression(node: CssNode): boolean {
  let found = false;
  walk(node, (child) => {
    if (
      (child.type === "Function" && decodeCssEscapes(child.name).toLowerCase() === "expression") ||
      (child.type === "Raw" && /(?:^|[^a-z-])expression\s*\(/i.test(decodeCssEscapes(child.value)))
    ) {
      found = true;
    }
  });
  return found;
}

function decodeCssEscapes(value: string): string {
  return value.replace(
    /\\(?:([0-9a-f]{1,6})[ \t\r\n\f]?|(\r\n|[\n\r\f])|(.))/gis,
    (_match, hex: string | undefined, newline: string | undefined, escaped: string | undefined) => {
      if (hex !== undefined) {
        const codePoint = Number.parseInt(hex, 16);
        if (
          codePoint === 0 ||
          codePoint > 0x10ffff ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) {
          return "�";
        }
        return String.fromCodePoint(codePoint);
      }

      return newline === undefined ? (escaped ?? "") : "";
    },
  );
}

function sanitizeRawCssValue(value: string, rewriteUrl: ReplayCssUrlRewriter | undefined): string {
  let result = "";
  let cursor = 0;

  while (cursor < value.length) {
    const urlStart = findUrlFunction(value, cursor);
    if (urlStart === -1) {
      result += value.slice(cursor);
      break;
    }

    result += value.slice(cursor, urlStart);
    const close = findFunctionClose(value, urlStart + 4);
    if (close === -1) {
      result += value.slice(urlStart);
      break;
    }

    const rawUrl = stripMatchingQuotes(value.slice(urlStart + 4, close).trim());
    const rewritten = rewriteReplayUrl(rawUrl, "image", rewriteUrl) ?? EMPTY_REPLAY_ASSET_URL;
    result += `url(${rewritten})`;
    cursor = close + 1;
  }

  return result;
}

function findUrlFunction(value: string, from: number): number {
  for (let index = from; index <= value.length - 4; index += 1) {
    if (value.slice(index, index + 4).toLowerCase() !== "url(") {
      continue;
    }

    const previous = value[index - 1];
    if (previous === undefined || !/[a-z0-9_-]/i.test(previous)) {
      return index;
    }
  }

  return -1;
}

function findFunctionClose(value: string, from: number): number {
  let depth = 1;
  let quote: '"' | "'" | undefined;
  let escaped = false;

  for (let index = from; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(") {
      depth += 1;
      continue;
    }
    if (character === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function stripMatchingQuotes(value: string): string {
  const first = value[0];
  return value.length >= 2 && (first === '"' || first === "'") && value.at(-1) === first
    ? value.slice(1, -1)
    : value;
}
