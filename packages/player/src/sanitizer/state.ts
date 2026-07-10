export const SCRIPT_TAG_NAME = "script";
export const STYLE_TAG_NAME = "style";
export const SVG_ANIMATION_TAG_NAMES = new Set([
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
]);

export type ReplaySanitizerState = {
  metaNodeIds: Set<number>;
  nodeTagNames: Map<number, string>;
  safeTextNodeIds: Set<number>;
  scriptNodeIds: Set<number>;
  scriptTextNodeIds: Set<number>;
  svgAnimationNodeIds: Set<number>;
  styleNodeIds: Set<number>;
  styleTextNodeIds: Set<number>;
};

export function createReplaySanitizerState(): ReplaySanitizerState {
  return {
    metaNodeIds: new Set(),
    nodeTagNames: new Map(),
    safeTextNodeIds: new Set(),
    scriptNodeIds: new Set(),
    scriptTextNodeIds: new Set(),
    svgAnimationNodeIds: new Set(),
    styleNodeIds: new Set(),
    styleTextNodeIds: new Set(),
  };
}

export function clearReplaySanitizerState(state: ReplaySanitizerState): void {
  state.metaNodeIds.clear();
  state.nodeTagNames.clear();
  state.safeTextNodeIds.clear();
  state.scriptNodeIds.clear();
  state.scriptTextNodeIds.clear();
  state.svgAnimationNodeIds.clear();
  state.styleNodeIds.clear();
  state.styleTextNodeIds.clear();
}

export function isStyleTextValue(
  value: Record<string, unknown>,
  state: ReplaySanitizerState,
): boolean {
  if (readTagName(value) === STYLE_TAG_NAME) {
    return true;
  }

  if (readNumber(value["type"]) !== 3) {
    return false;
  }

  const textNodeId = readNumber(value["id"]);
  return textNodeId !== undefined && state.styleTextNodeIds.has(textNodeId);
}

export function rememberNodeState(
  state: ReplaySanitizerState,
  nodeId: number | undefined,
  nodeType: number | undefined,
  tagName: string | undefined,
  currentTagName: string | undefined,
): void {
  if (nodeId === undefined) {
    return;
  }

  if (tagName !== undefined && nodeType !== 3) {
    state.nodeTagNames.set(nodeId, tagName);
    if (tagName === STYLE_TAG_NAME) {
      state.styleNodeIds.add(nodeId);
    }
    if (tagName === SCRIPT_TAG_NAME) {
      state.scriptNodeIds.add(nodeId);
    }
    if (tagName === "meta") {
      state.metaNodeIds.add(nodeId);
    }
    if (SVG_ANIMATION_TAG_NAMES.has(tagName)) {
      state.svgAnimationNodeIds.add(nodeId);
    }
  }

  if (nodeType !== 3) {
    return;
  }

  if (currentTagName === STYLE_TAG_NAME) {
    state.safeTextNodeIds.delete(nodeId);
    state.styleTextNodeIds.add(nodeId);
    return;
  }

  if (currentTagName === SCRIPT_TAG_NAME) {
    state.safeTextNodeIds.delete(nodeId);
    state.scriptTextNodeIds.add(nodeId);
    return;
  }

  if (
    currentTagName !== undefined &&
    !state.scriptTextNodeIds.has(nodeId) &&
    !state.styleTextNodeIds.has(nodeId)
  ) {
    state.safeTextNodeIds.add(nodeId);
  }
}

export function shouldBlankTextNode(
  value: Record<string, unknown>,
  state: ReplaySanitizerState,
): boolean {
  const tagName = readTagName(value);
  if (tagName === STYLE_TAG_NAME || tagName === SCRIPT_TAG_NAME) {
    return true;
  }

  const nodeType = readNumber(value["type"]);
  if (nodeType !== 3) {
    return false;
  }

  const textNodeId = readNumber(value["id"]);
  return (
    textNodeId === undefined ||
    state.scriptTextNodeIds.has(textNodeId) ||
    state.styleTextNodeIds.has(textNodeId) ||
    !state.safeTextNodeIds.has(textNodeId)
  );
}

export function readTagName(value: Record<string, unknown>): string | undefined {
  const tagName = value["tagName"];
  return typeof tagName === "string" ? tagName.toLowerCase() : undefined;
}

export function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
