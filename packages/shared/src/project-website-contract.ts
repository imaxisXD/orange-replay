import { z } from "zod";
import { projectKeyAuditSchema } from "./project-key-contract.ts";
import { websiteUrlSchema } from "./website-url.ts";

export const MAX_PROJECT_WEBSITE_BODY_BYTES = 4 * 1024;

export const projectWebsiteSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  origin: z.string().url(),
  firstEventAt: z.number().int().safe().nonnegative().nullable(),
});

export const ensureProjectWebsiteRequestSchema = z
  .object({ website: z.string() })
  .strict()
  .transform((value, context) => {
    const website = websiteUrlSchema.safeParse(value.website);
    if (!website.success) {
      context.addIssue({ code: "custom", message: "invalid_website", path: ["website"] });
      return z.NEVER;
    }
    return { website: website.data };
  });

export const ensureProjectWebsiteResponseSchema = z.object({
  website: projectWebsiteSchema,
  key: projectKeyAuditSchema.nullable(),
  secret: z.string().min(1).nullable(),
  alreadyConnected: z.boolean(),
});

export const projectWebsiteInstallStatusSchema = z.object({
  firstEventAt: z.number().int().safe().nonnegative().nullable(),
});

export type ProjectWebsite = z.output<typeof projectWebsiteSchema>;
export type EnsureProjectWebsiteResponse = z.output<typeof ensureProjectWebsiteResponseSchema>;
export type ProjectWebsiteInstallStatus = z.output<typeof projectWebsiteInstallStatusSchema>;

export function decodeEnsureProjectWebsiteResponse(value: unknown): EnsureProjectWebsiteResponse {
  return ensureProjectWebsiteResponseSchema.parse(value);
}

export function decodeProjectWebsiteInstallStatus(value: unknown): ProjectWebsiteInstallStatus {
  return projectWebsiteInstallStatusSchema.parse(value);
}
