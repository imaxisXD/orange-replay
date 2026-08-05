import * as v from "valibot";
import { projectKeyAuditSchema } from "./project-key-contract.ts";
import { SESSION_ID_PATTERN } from "./session-id.ts";
import { sharedSchema } from "./validation.ts";
import { websiteUrlSchema } from "./website-url.ts";

export const MAX_PROJECT_WEBSITE_BODY_BYTES = 4 * 1024;

export const projectWebsiteSchema = sharedSchema(
  v.object({
    id: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
    name: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
    origin: v.pipe(v.string(), v.url()),
    firstEventAt: v.nullable(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  }),
);

export const projectWebsiteIdSchema = sharedSchema(
  v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,100}$/)),
);

const ensureProjectWebsiteRequestInputSchema = v.strictObject({
  website: v.string(),
  websiteId: v.optional(projectWebsiteIdSchema),
});

export const ensureProjectWebsiteRequestSchema = sharedSchema(
  v.pipe(
    ensureProjectWebsiteRequestInputSchema,
    v.rawTransform(({ dataset, addIssue, NEVER }) => {
      const website = websiteUrlSchema.safeParse(dataset.value.website);
      if (!website.success) {
        addIssue({
          message: "invalid_website",
          path: [
            {
              type: "object",
              origin: "value",
              input: dataset.value,
              key: "website",
              value: dataset.value.website,
            },
          ],
        });
        return NEVER;
      }
      return {
        website: website.data,
        ...(dataset.value.websiteId === undefined ? {} : { websiteId: dataset.value.websiteId }),
      };
    }),
  ),
);

export const ensureProjectWebsiteResponseSchema = sharedSchema(
  v.object({
    website: projectWebsiteSchema,
    key: v.nullable(projectKeyAuditSchema),
    secret: v.nullable(v.pipe(v.string(), v.minLength(1))),
    alreadyConnected: v.boolean(),
  }),
);

export const projectWebsitesResponseSchema = sharedSchema(
  v.object({
    websites: v.array(projectWebsiteSchema),
  }),
);

export const projectWebsiteInstallStatusSchema = sharedSchema(
  v.object({
    firstEventAt: v.nullable(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
    // Older Workers can briefly overlap a newer dashboard during a rollout.
    // Defaulting a missing id to null keeps that handoff safe: onboarding waits
    // for its cap instead of accepting an unrelated live session.
    firstSessionId: v.optional(v.nullable(v.pipe(v.string(), v.regex(SESSION_ID_PATTERN))), null),
  }),
);

export type ProjectWebsite = v.InferOutput<typeof projectWebsiteSchema>;
export type EnsureProjectWebsiteResponse = v.InferOutput<typeof ensureProjectWebsiteResponseSchema>;
export type ProjectWebsitesResponse = v.InferOutput<typeof projectWebsitesResponseSchema>;
export type ProjectWebsiteInstallStatus = v.InferOutput<typeof projectWebsiteInstallStatusSchema>;

export function decodeEnsureProjectWebsiteResponse(value: unknown): EnsureProjectWebsiteResponse {
  return ensureProjectWebsiteResponseSchema.parse(value);
}

export function decodeProjectWebsitesResponse(value: unknown): ProjectWebsitesResponse {
  return projectWebsitesResponseSchema.parse(value);
}

export function decodeProjectWebsiteInstallStatus(value: unknown): ProjectWebsiteInstallStatus {
  return projectWebsiteInstallStatusSchema.parse(value);
}
