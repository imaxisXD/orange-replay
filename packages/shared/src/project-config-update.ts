import * as v from "valibot";
import { readStablePrivacySelectorError } from "./privacy-selector.ts";
import { captureTogglesSchema, maskRuleSchema } from "./schemas.ts";
import type { ProjectConfigUpdate } from "./types.ts";
import { schemaCheck, sharedSchema, type SharedSchema } from "./validation.ts";

export const projectConfigExpectedVersionSchema = sharedSchema(
  v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
);
export const projectSampleRateSchema = sharedSchema(
  v.pipe(
    v.number(),
    v.finite(),
    v.minValue(0, "Sampling rate must be from 0% to 100%."),
    v.maxValue(1, "Sampling rate must be from 0% to 100%."),
  ),
);
export const projectRetentionDaysSchema = sharedSchema(
  v.pipe(
    v.number(),
    v.safeInteger("Retention must be a whole number of days."),
    v.minValue(1, "Retention must be from 1 to 365 days."),
    v.maxValue(365, "Retention must be from 1 to 365 days."),
  ),
);

export const httpOriginSchema = sharedSchema(
  v.pipe(
    v.string(),
    v.trim(),
    v.maxLength(500),
    v.rawTransform<string, string>(({ dataset, addIssue, NEVER }) => {
      const origin = readExactHttpOrigin(dataset.value);
      if (origin === null) {
        addIssue({ message: "Enter a valid http:// or https:// origin." });
        return NEVER;
      }
      return origin;
    }),
  ),
);

export const allowedOriginSchema = sharedSchema(
  v.pipe(
    v.string(),
    v.trim(),
    v.maxLength(500),
    v.rawTransform<string, string>(({ dataset, addIssue, NEVER }) => {
      if (dataset.value === "*") return dataset.value;
      const origin = readExactHttpOrigin(dataset.value);
      if (origin === null) {
        addIssue({ message: "Enter * or a valid http:// or https:// origin." });
        return NEVER;
      }
      return origin;
    }),
  ),
);
export const allowedOriginsSchema = sharedSchema(
  v.pipe(
    v.array(allowedOriginSchema),
    v.minLength(1, "Add at least one allowed origin or use * for wildcard access."),
    v.maxLength(100, "You can add up to 100 allowed origins."),
  ),
);

export const projectConfigUpdateMaskRuleSchema = sharedSchema(
  v.pipe(
    v.strictObject({
      ...maskRuleSchema.entries,
      selector: v.pipe(
        v.string(),
        v.trim(),
        v.minLength(1, "Each masking rule needs a selector."),
        v.maxLength(500),
      ),
    }),
    schemaCheck<{ selector: string; action: "mask" | "block" }>((rule, context) => {
      const error = readStablePrivacySelectorError(rule.selector);
      if (error !== null) {
        context.addIssue({ message: error, path: ["selector"] });
      }
    }),
  ),
);
export const projectConfigUpdateMaskRulesSchema = sharedSchema(
  v.pipe(
    v.array(projectConfigUpdateMaskRuleSchema),
    v.maxLength(200, "You can add up to 200 masking rules."),
  ),
);

export const projectConfigUpdateSchema: SharedSchema<
  v.GenericSchema<ProjectConfigUpdate, ProjectConfigUpdate>
> = sharedSchema(
  v.strictObject({
    expectedVersion: projectConfigExpectedVersionSchema,
    sampleRate: projectSampleRateSchema,
    retentionDays: projectRetentionDaysSchema,
    allowedOrigins: allowedOriginsSchema,
    maskPolicyVersion: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    maskRules: projectConfigUpdateMaskRulesSchema,
    capture: captureTogglesSchema,
  }),
);

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
