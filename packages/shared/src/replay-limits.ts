import { REPLAY_DATA_LIMITS } from "./constants.ts";

export type ReplayValueCounter = (value: unknown, depth?: number, remaining?: number) => number;

const counterLimits = [
  REPLAY_DATA_LIMITS.depth,
  REPLAY_DATA_LIMITS.fields,
  REPLAY_DATA_LIMITS.arrayItems,
  REPLAY_DATA_LIMITS.values,
] as const;

// Keep this factory self-contained: the same code runs in both browser workers.
function createReplayValueCounter(
  maxDepth: number,
  maxFields: number,
  maxArrayItems: number,
  maxValues: number,
): ReplayValueCounter {
  const fail = (message: string): never => {
    const error = new Error(message);
    error.name = "ReplayDataError";
    throw error;
  };
  return function countReplayValues(value, depth = 0, remaining = maxValues) {
    // Recursion cannot exceed the shared depth limit; never walk an arbitrary
    // recorded tree without checking this boundary before descending.
    if (remaining < 1) fail("Replay batch is too complex.");
    if (depth > maxDepth) fail("Replay event is too deeply nested.");
    let count = 0;
    if (typeof value === "object" && value !== null) {
      const array = Array.isArray(value);
      const children: unknown[] = array ? value : Object.values(value);
      if (!array && children.length > maxFields) fail("Replay event has too many fields.");
      if ((array && children.length > maxArrayItems) || children.length >= remaining) {
        fail("Replay batch is too complex.");
      }
      for (const child of children)
        count += countReplayValues(child, depth + 1, remaining - count - 1);
    }
    return count + 1;
  };
}

export const countReplayValues = createReplayValueCounter(...counterLimits);
export const REPLAY_VALUE_COUNTER_SOURCE = `
const countReplayValues = (${createReplayValueCounter.toString()})(${counterLimits.join(",")});
`;
