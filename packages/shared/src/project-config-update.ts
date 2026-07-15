import { z } from "zod";
import { readStablePrivacySelectorError } from "./privacy-selector.ts";
import { captureTogglesSchema, maskRuleSchema } from "./schemas.ts";
import type { ProjectConfigUpdate } from "./types.ts";

const projectConfigUpdateMaskRuleSchema = maskRuleSchema
  .extend({ selector: z.string().trim().min(1).max(500) })
  .superRefine((rule, context) => {
    const error = readStablePrivacySelectorError(rule.selector);
    if (error !== null) {
      context.addIssue({ code: "custom", message: error, path: ["selector"] });
    }
  });

export const projectConfigUpdateSchema: z.ZodType<ProjectConfigUpdate> = z
  .object({
    expectedVersion: z.number().int().nonnegative(),
    sampleRate: z.number().min(0).max(1),
    retentionDays: z.number().int().min(1).max(365),
    allowedOrigins: z.array(z.string().min(1).max(500)).min(1).max(100),
    maskPolicyVersion: z.number().int().nonnegative(),
    maskRules: z.array(projectConfigUpdateMaskRuleSchema).max(200),
    capture: captureTogglesSchema,
  })
  .strict();
