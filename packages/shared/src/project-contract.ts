import * as v from "valibot";
import { sharedSchema } from "./validation.ts";

/** Matches the `projects.name` column width used by account bootstrap. */
export const PROJECT_NAME_MAX_CHARS = 100;

export const projectNameUpdateSchema = sharedSchema(
  v.strictObject({
    name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(PROJECT_NAME_MAX_CHARS)),
  }),
);

export const projectSummarySchema = sharedSchema(
  v.object({
    id: v.pipe(v.string(), v.minLength(1)),
    name: v.pipe(v.string(), v.minLength(1)),
  }),
);

export type ProjectNameUpdate = v.InferOutput<typeof projectNameUpdateSchema>;
export type ProjectSummary = v.InferOutput<typeof projectSummarySchema>;

export function decodeProjectSummary(value: unknown): ProjectSummary {
  return projectSummarySchema.parse(value);
}
