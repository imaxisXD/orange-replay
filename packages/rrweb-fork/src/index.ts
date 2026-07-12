import record from "./vendor/rrweb/record/index.ts";

export { record };
export const addCustomEvent = record.addCustomEvent;
export const freezePage = record.freezePage;
export const takeFullSnapshot = record.takeFullSnapshot;
export const mirror = record.mirror;

export type { ErrorHandler, recordOptions } from "./vendor/rrweb/types.ts";
export {
  EventType,
  IncrementalSource,
  MouseInteractions,
  NodeType,
} from "./vendor/rrweb-types/index.ts";
export type {
  eventWithTime,
  eventWithoutTime,
  fullSnapshotEvent,
  incrementalSnapshotEvent,
  inputData,
  mutationData,
  serializedNodeWithId,
} from "./vendor/rrweb-types/index.ts";
export {
  cleanupSnapshot,
  classMatchesRegex,
  genId,
  getSnapshotEstimatedBytes,
  ignoreAttribute,
  IGNORED_NODE,
  needMaskingText,
  serializeNodeWithId,
  slimDOMDefaults,
  snapshot,
  transformAttribute,
  visitSnapshot,
  yieldForPaint,
} from "./vendor/rrweb-snapshot/index.ts";
export type {
  MaskInputFn,
  MaskInputOptions,
  MaskTextFn,
  SlimDOMOptions,
} from "./vendor/rrweb-snapshot/index.ts";
export { createMirror, maskInputValue, Mirror } from "./vendor/rrweb-snapshot/index.ts";
export { estimateEventBytes } from "./vendor/rrweb/record/event-size.ts";
