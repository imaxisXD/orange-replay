import { z } from "zod";

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
