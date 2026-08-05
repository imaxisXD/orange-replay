import * as v from "valibot";
import { schemaCheck, sharedSchema } from "./validation.ts";

const generatedRecorderKeyPattern = /^or_live_[A-Za-z0-9_-]{32}$/;

export const projectKeyNameSchema = sharedSchema(
  v.pipe(
    v.string(),
    v.trim(),
    v.minLength(1, "Enter a name for this key."),
    v.maxLength(64, "Keep the key name under 65 characters."),
    v.check((name) => !hasControlCharacter(name), "Use a key name without control characters."),
  ),
);

export const createProjectKeyRequestSchema = sharedSchema(
  v.strictObject({ name: projectKeyNameSchema }),
);

export const generatedRecorderKeySchema = sharedSchema(
  v.pipe(
    v.string(),
    v.trim(),
    v.regex(generatedRecorderKeyPattern, "Use a generated recorder key that starts with or_live_."),
  ),
);

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

const projectKeyTimestampSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

const projectKeyAuditObjectSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  keyHashPrefix: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  active: v.boolean(),
  createdAt: projectKeyTimestampSchema,
  createdBy: v.nullable(v.pipe(v.string(), v.minLength(1))),
  revokedAt: v.nullable(projectKeyTimestampSchema),
  revokedBy: v.nullable(v.pipe(v.string(), v.minLength(1))),
});

export const projectKeyAuditSchema = sharedSchema(
  v.pipe(
    projectKeyAuditObjectSchema,
    schemaCheck<v.InferOutput<typeof projectKeyAuditObjectSchema>>((key, context) => {
      if (key.active && (key.revokedAt !== null || key.revokedBy !== null)) {
        context.addIssue({
          message: "an active project key cannot have revocation details",
          path: ["active"],
        });
      }
    }),
  ),
);

export const projectKeysResponseSchema = sharedSchema(
  v.object({
    keys: v.array(projectKeyAuditSchema),
  }),
);

export const createdProjectKeyResponseSchema = sharedSchema(
  v.object({
    key: projectKeyAuditSchema,
    secret: v.pipe(v.string(), v.minLength(1)),
  }),
);

export const projectKeyResponseSchema = sharedSchema(
  v.object({
    key: projectKeyAuditSchema,
  }),
);

export type ProjectKeyAudit = v.InferOutput<typeof projectKeyAuditSchema>;
export type ProjectKeysResponse = v.InferOutput<typeof projectKeysResponseSchema>;
export type CreatedProjectKeyResponse = v.InferOutput<typeof createdProjectKeyResponseSchema>;
export type ProjectKeyResponse = v.InferOutput<typeof projectKeyResponseSchema>;

export function decodeProjectKeysResponse(value: unknown): ProjectKeysResponse {
  return projectKeysResponseSchema.parse(value);
}

export function decodeCreatedProjectKeyResponse(value: unknown): CreatedProjectKeyResponse {
  return createdProjectKeyResponseSchema.parse(value);
}

export function decodeProjectKeyResponse(value: unknown): ProjectKeyResponse {
  return projectKeyResponseSchema.parse(value);
}
