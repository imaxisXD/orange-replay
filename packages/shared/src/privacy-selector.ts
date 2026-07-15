import { lexer, parse, walk, type CssNode } from "css-tree";

const stablePrivacyPseudoClasses = new Set([
  "empty",
  "first-child",
  "first-of-type",
  "has",
  "is",
  "lang",
  "last-child",
  "last-of-type",
  "not",
  "nth-child",
  "nth-last-child",
  "nth-last-of-type",
  "nth-of-type",
  "only-child",
  "only-of-type",
  "root",
  "scope",
  "where",
]);

const invalidSelectorMessage = "Use a valid CSS selector.";
const unstableSelectorMessage =
  "Use selectors based on document structure, not changing states like :hover.";

/**
 * Privacy rules must be valid CSS and must not change without a DOM mutation.
 * This prevents a rule from silently stopping when browser state changes.
 */
export function readStablePrivacySelectorError(selector: string): string | null {
  if (selector.trim().length === 0) return invalidSelectorMessage;

  let root: CssNode;
  try {
    root = parse(selector, { context: "selectorList" });
  } catch {
    return invalidSelectorMessage;
  }

  if (lexer.matchType("selector-list", root).error !== null) {
    return invalidSelectorMessage;
  }

  let hasUnstableSelector = false;
  walk(root, (node) => {
    if (node.type === "PseudoElementSelector") {
      hasUnstableSelector = true;
      return walk.break;
    }
    if (
      node.type === "PseudoClassSelector" &&
      !stablePrivacyPseudoClasses.has(node.name.toLowerCase())
    ) {
      hasUnstableSelector = true;
      return walk.break;
    }
  });

  return hasUnstableSelector ? unstableSelectorMessage : null;
}

export function isStablePrivacySelector(selector: string): boolean {
  return readStablePrivacySelectorError(selector) === null;
}
