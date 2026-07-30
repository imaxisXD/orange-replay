import { z } from "zod";

/** Matches the `projects.name` column width used by account bootstrap. */
export const PROJECT_NAME_MAX_CHARS = 100;

export const projectNameUpdateSchema = z
  .object({ name: z.string().trim().min(1).max(PROJECT_NAME_MAX_CHARS) })
  .strict();

export const projectSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

export type ProjectNameUpdate = z.output<typeof projectNameUpdateSchema>;
export type ProjectSummary = z.output<typeof projectSummarySchema>;

export function decodeProjectSummary(value: unknown): ProjectSummary {
  return projectSummarySchema.parse(value);
}
