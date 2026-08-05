import * as v from "valibot";
import { sharedSchema } from "./validation.ts";

export const authModeSchema = sharedSchema(v.picklist(["github", "unavailable"]));
export const accountProjectRoleSchema = sharedSchema(v.picklist(["owner", "admin", "member"]));

export const authConfigResponseSchema = sharedSchema(
  v.object({
    mode: authModeSchema,
  }),
);

export const accountUserSchema = sharedSchema(
  v.object({
    id: v.pipe(v.string(), v.minLength(1)),
    name: v.string(),
    email: v.pipe(v.string(), v.minLength(1)),
    emailVerified: v.boolean(),
    image: v.nullable(v.string()),
    role: v.pipe(v.string(), v.minLength(1)),
  }),
);

export const accountProjectSchema = sharedSchema(
  v.object({
    id: v.pipe(v.string(), v.minLength(1)),
    name: v.pipe(v.string(), v.minLength(1)),
    role: accountProjectRoleSchema,
    /** First Website identity for user-facing Workspace chrome. Optional keeps
     *  dashboard and Worker rollouts compatible in either order. */
    websiteOrigin: v.optional(v.nullable(v.pipe(v.string(), v.url()))),
    /** Public-suffix-safe domain shared by related HTTPS Websites. Optional
     *  keeps an older Worker compatible with a newer dashboard. */
    journeyDomain: v.optional(v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(253)))),
  }),
);

export const accountWorkspaceSchema = sharedSchema(
  v.object({
    id: v.pipe(v.string(), v.minLength(1)),
    name: v.pipe(v.string(), v.minLength(1)),
    slug: v.pipe(v.string(), v.minLength(1)),
    role: accountProjectRoleSchema,
    projects: v.array(accountProjectSchema),
  }),
);

export const accountResponseSchema = sharedSchema(
  v.object({
    user: accountUserSchema,
    workspaces: v.array(accountWorkspaceSchema),
    activeWorkspaceId: v.nullable(v.pipe(v.string(), v.minLength(1))),
    isAdmin: v.boolean(),
  }),
);

export const projectCreateRequestSchema = sharedSchema(
  v.strictObject({
    workspaceId: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,64}$/)),
  }),
);

export const projectCreateResponseSchema = sharedSchema(
  v.object({
    project: accountProjectSchema,
    account: accountResponseSchema,
  }),
);

const optionalAdminWholeNumber = (fallback: number, min: number, max: number, message: string) =>
  v.optional(
    v.pipe(
      v.unknown(),
      v.transform((value): unknown => {
        if (value === undefined || value === null || value === "") return fallback;
        if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) return Number(value);
        return value;
      }),
      v.pipe(v.number(), v.safeInteger(), v.minValue(min, message), v.maxValue(max, message)),
    ),
    fallback,
  );

export const adminUserSearchSchema = sharedSchema(
  v.pipe(v.string(), v.trim(), v.maxLength(100, "Keep the search under 101 characters.")),
);

export const adminUsersQuerySchema = sharedSchema(
  v.strictObject({
    limit: optionalAdminWholeNumber(25, 1, 100, "Limit must be from 1 to 100."),
    offset: optionalAdminWholeNumber(0, 0, 100_000, "Offset must be from 0 to 100000."),
    search: v.optional(
      v.pipe(
        v.unknown(),
        v.transform((value): unknown => (value === undefined || value === null ? "" : value)),
        adminUserSearchSchema,
      ),
      "",
    ),
  }),
);

const adminNonnegativeSafeIntegerSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

export const adminStatsResponseSchema = sharedSchema(
  v.object({
    users: adminNonnegativeSafeIntegerSchema,
    newUsers: adminNonnegativeSafeIntegerSchema,
    workspaces: adminNonnegativeSafeIntegerSchema,
    projects: adminNonnegativeSafeIntegerSchema,
    activeKeys: adminNonnegativeSafeIntegerSchema,
  }),
);

export const adminUserSchema = sharedSchema(
  v.object({
    id: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    name: v.pipe(v.string(), v.maxLength(200)),
    email: v.pipe(v.string(), v.minLength(1), v.maxLength(320)),
    image: v.nullable(v.pipe(v.string(), v.maxLength(2_048))),
    role: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
    banned: v.boolean(),
    banReason: v.nullable(v.pipe(v.string(), v.maxLength(1_000))),
    createdAt: adminNonnegativeSafeIntegerSchema,
    lastSignedInAt: v.nullable(adminNonnegativeSafeIntegerSchema),
    workspaceCount: adminNonnegativeSafeIntegerSchema,
  }),
);

export const adminUsersResponseSchema = sharedSchema(
  v.object({
    users: v.pipe(v.array(adminUserSchema), v.maxLength(100)),
    total: adminNonnegativeSafeIntegerSchema,
    limit: v.pipe(adminNonnegativeSafeIntegerSchema, v.minValue(1), v.maxValue(100)),
    offset: v.pipe(adminNonnegativeSafeIntegerSchema, v.maxValue(100_000)),
  }),
);

export type AdminUsersQuery = v.InferOutput<typeof adminUsersQuerySchema>;
export type AdminStatsResponse = v.InferOutput<typeof adminStatsResponseSchema>;
export type AdminUser = v.InferOutput<typeof adminUserSchema>;
export type AdminUsersResponse = v.InferOutput<typeof adminUsersResponseSchema>;

export type AuthMode = v.InferOutput<typeof authModeSchema>;
export type AccountProjectRole = v.InferOutput<typeof accountProjectRoleSchema>;
export type AuthConfigResponse = v.InferOutput<typeof authConfigResponseSchema>;
export type AccountUser = v.InferOutput<typeof accountUserSchema>;
export type AccountProject = v.InferOutput<typeof accountProjectSchema>;
export type AccountWorkspace = v.InferOutput<typeof accountWorkspaceSchema>;
export type AccountResponse = v.InferOutput<typeof accountResponseSchema>;
export type ProjectCreateRequest = v.InferOutput<typeof projectCreateRequestSchema>;
export type ProjectCreateResponse = v.InferOutput<typeof projectCreateResponseSchema>;

export function decodeAuthConfigResponse(value: unknown): AuthConfigResponse {
  return authConfigResponseSchema.parse(value);
}

export function decodeAccountResponse(value: unknown): AccountResponse {
  return accountResponseSchema.parse(value);
}

export function decodeProjectCreateResponse(value: unknown): ProjectCreateResponse {
  return projectCreateResponseSchema.parse(value);
}

export function decodeAdminStatsResponse(value: unknown): AdminStatsResponse {
  return adminStatsResponseSchema.parse(value);
}

export function decodeAdminUsersResponse(value: unknown): AdminUsersResponse {
  return adminUsersResponseSchema.parse(value);
}
