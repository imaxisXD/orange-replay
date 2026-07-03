import snapshot, {
  cleanupSnapshot,
  classMatchesRegex,
  genId,
  ignoreAttribute,
  IGNORED_NODE,
  needMaskingText,
  serializeNodeWithId,
  slimDOMDefaults,
  transformAttribute,
  visitSnapshot,
} from "./snapshot.ts";

export * from "./types.ts";
export {
  createMirror,
  getInputType,
  is2DCanvasBlank,
  isElement,
  isNativeShadowDom,
  isShadowRoot,
  maskInputValue,
  Mirror,
  stringifyRule,
  stringifyStylesheet,
  toLowerCase,
} from "./utils.ts";
export {
  cleanupSnapshot,
  classMatchesRegex,
  genId,
  ignoreAttribute,
  IGNORED_NODE,
  needMaskingText,
  serializeNodeWithId,
  slimDOMDefaults,
  snapshot,
  transformAttribute,
  visitSnapshot,
};
export default snapshot;
