import { z } from "zod";

const generatedRecorderKeyPattern = /^or_live_[A-Za-z0-9_-]{32}$/;

export const projectKeyNameSchema = z
  .string()
  .trim()
  .min(1, "Enter a name for this key.")
  .max(64, "Keep the key name under 65 characters.")
  .refine((name) => !hasControlCharacter(name), {
    message: "Use a key name without control characters.",
  });

export const createProjectKeyRequestSchema = z.object({ name: projectKeyNameSchema }).strict();

export const generatedRecorderKeySchema = z
  .string()
  .trim()
  .regex(generatedRecorderKeyPattern, "Use a generated recorder key that starts with or_live_.");

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

const projectKeyTimestampSchema = z.number().int().safe().nonnegative();

export const projectKeyAuditSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(64),
    keyHashPrefix: z.string().min(1).max(64),
    active: z.boolean(),
    createdAt: projectKeyTimestampSchema,
    createdBy: z.string().min(1).nullable(),
    revokedAt: projectKeyTimestampSchema.nullable(),
    revokedBy: z.string().min(1).nullable(),
  })
  .superRefine((key, context) => {
    if (key.active && (key.revokedAt !== null || key.revokedBy !== null)) {
      context.addIssue({
        code: "custom",
        message: "an active project key cannot have revocation details",
        path: ["active"],
      });
    }
  });

export const projectKeysResponseSchema = z.object({
  keys: z.array(projectKeyAuditSchema),
});

export const createdProjectKeyResponseSchema = z.object({
  key: projectKeyAuditSchema,
  secret: z.string().min(1),
});

export const projectKeyResponseSchema = z.object({
  key: projectKeyAuditSchema,
});

export type ProjectKeyAudit = z.output<typeof projectKeyAuditSchema>;
export type ProjectKeysResponse = z.output<typeof projectKeysResponseSchema>;
export type CreatedProjectKeyResponse = z.output<typeof createdProjectKeyResponseSchema>;
export type ProjectKeyResponse = z.output<typeof projectKeyResponseSchema>;

export function decodeProjectKeysResponse(value: unknown): ProjectKeysResponse {
  return projectKeysResponseSchema.parse(value);
}

export function decodeCreatedProjectKeyResponse(value: unknown): CreatedProjectKeyResponse {
  return createdProjectKeyResponseSchema.parse(value);
}

export function decodeProjectKeyResponse(value: unknown): ProjectKeyResponse {
  return projectKeyResponseSchema.parse(value);
}
