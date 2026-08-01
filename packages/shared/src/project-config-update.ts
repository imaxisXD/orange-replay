import { z } from "zod";
import { readStablePrivacySelectorError } from "./privacy-selector.ts";
import { captureTogglesSchema, maskRuleSchema } from "./schemas.ts";
import type { ProjectConfigUpdate } from "./types.ts";

export const projectConfigExpectedVersionSchema = z.number().int().nonnegative();
export const projectSampleRateSchema = z
  .number()
  .min(0, "Sampling rate must be from 0% to 100%.")
  .max(1, "Sampling rate must be from 0% to 100%.");
export const projectRetentionDaysSchema = z
  .number()
  .int("Retention must be a whole number of days.")
  .min(1, "Retention must be from 1 to 365 days.")
  .max(365, "Retention must be from 1 to 365 days.");

export const httpOriginSchema = z
  .string()
  .trim()
  .max(500)
  .transform((value, context) => {
    const origin = readExactHttpOrigin(value);
    if (origin === null) {
      context.addIssue({
        code: "custom",
        message: "Enter a valid http:// or https:// origin.",
      });
      return z.NEVER;
    }
    return origin;
  });

export const allowedOriginSchema = z
  .string()
  .trim()
  .max(500)
  .transform((value, context) => {
    if (value === "*") return value;
    const origin = readExactHttpOrigin(value);
    if (origin === null) {
      context.addIssue({
        code: "custom",
        message: "Enter * or a valid http:// or https:// origin.",
      });
      return z.NEVER;
    }
    return origin;
  });
export const allowedOriginsSchema = z
  .array(allowedOriginSchema)
  .min(1, "Add at least one allowed origin or use * for wildcard access.")
  .max(100, "You can add up to 100 allowed origins.");

export const projectConfigUpdateMaskRuleSchema = maskRuleSchema
  .extend({ selector: z.string().trim().min(1, "Each masking rule needs a selector.").max(500) })
  .superRefine((rule, context) => {
    const error = readStablePrivacySelectorError(rule.selector);
    if (error !== null) {
      context.addIssue({ code: "custom", message: error, path: ["selector"] });
    }
  });
export const projectConfigUpdateMaskRulesSchema = z
  .array(projectConfigUpdateMaskRuleSchema)
  .max(200, "You can add up to 200 masking rules.");

export const projectConfigUpdateSchema: z.ZodType<ProjectConfigUpdate> = z
  .object({
    expectedVersion: projectConfigExpectedVersionSchema,
    sampleRate: projectSampleRateSchema,
    retentionDays: projectRetentionDaysSchema,
    allowedOrigins: allowedOriginsSchema,
    maskPolicyVersion: z.number().int().nonnegative(),
    maskRules: projectConfigUpdateMaskRulesSchema,
    capture: captureTogglesSchema,
  })
  .strict();

/** A deployment URL is an exact http(s) origin, without a path, query, or hash. */
export const deploymentHttpOriginSchema = httpOriginSchema;

function readExactHttpOrigin(value: string): string | null {
  if (value.length === 0) return null;
  try {
    const url = new URL(value);
    const hasOnlyOrigin =
      url.username.length === 0 &&
      url.password.length === 0 &&
      (url.pathname === "" || url.pathname === "/") &&
      url.search.length === 0 &&
      url.hash.length === 0;
    return (url.protocol === "http:" || url.protocol === "https:") && hasOnlyOrigin
      ? url.origin
      : null;
  } catch {
    return null;
  }
}
