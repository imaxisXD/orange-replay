import { z } from "zod";

export const authModeSchema = z.enum(["github", "unavailable"]);
export const accountProjectRoleSchema = z.enum(["owner", "admin", "member"]);

export const authConfigResponseSchema = z.object({
  mode: authModeSchema,
});

export const accountUserSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  email: z.string().min(1),
  emailVerified: z.boolean(),
  image: z.string().nullable(),
  role: z.string().min(1),
});

export const accountProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: accountProjectRoleSchema,
  /** First Website identity for user-facing Workspace chrome. Optional keeps
   *  dashboard and Worker rollouts compatible in either order. */
  websiteOrigin: z.string().url().nullable().optional(),
  /** Public-suffix-safe domain shared by related HTTPS Websites. Optional
   *  keeps an older Worker compatible with a newer dashboard. */
  journeyDomain: z.string().min(1).max(253).nullable().optional(),
});

export const accountWorkspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().min(1),
  role: accountProjectRoleSchema,
  projects: z.array(accountProjectSchema),
});

export const accountResponseSchema = z.object({
  user: accountUserSchema,
  workspaces: z.array(accountWorkspaceSchema),
  activeWorkspaceId: z.string().min(1).nullable(),
  isAdmin: z.boolean(),
});

export const projectCreateRequestSchema = z
  .object({
    workspaceId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  })
  .strict();

export const projectCreateResponseSchema = z.object({
  project: accountProjectSchema,
  account: accountResponseSchema,
});

const optionalAdminWholeNumber = (fallback: number, min: number, max: number, message: string) =>
  z.preprocess(
    (value) => {
      if (value === undefined || value === null || value === "") return fallback;
      if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) return Number(value);
      return value;
    },
    z.number().int().safe().min(min, message).max(max, message),
  );

export const adminUserSearchSchema = z
  .string()
  .trim()
  .max(100, "Keep the search under 101 characters.");

export const adminUsersQuerySchema = z
  .object({
    limit: optionalAdminWholeNumber(25, 1, 100, "Limit must be from 1 to 100."),
    offset: optionalAdminWholeNumber(0, 0, 100_000, "Offset must be from 0 to 100000."),
    search: z.preprocess(
      (value) => (value === undefined || value === null ? "" : value),
      adminUserSearchSchema,
    ),
  })
  .strict();

export type AdminUsersQuery = z.output<typeof adminUsersQuerySchema>;

export type AuthMode = z.output<typeof authModeSchema>;
export type AccountProjectRole = z.output<typeof accountProjectRoleSchema>;
export type AuthConfigResponse = z.output<typeof authConfigResponseSchema>;
export type AccountUser = z.output<typeof accountUserSchema>;
export type AccountProject = z.output<typeof accountProjectSchema>;
export type AccountWorkspace = z.output<typeof accountWorkspaceSchema>;
export type AccountResponse = z.output<typeof accountResponseSchema>;
export type ProjectCreateRequest = z.output<typeof projectCreateRequestSchema>;
export type ProjectCreateResponse = z.output<typeof projectCreateResponseSchema>;

export function decodeAuthConfigResponse(value: unknown): AuthConfigResponse {
  return authConfigResponseSchema.parse(value);
}

export function decodeAccountResponse(value: unknown): AccountResponse {
  return accountResponseSchema.parse(value);
}

export function decodeProjectCreateResponse(value: unknown): ProjectCreateResponse {
  return projectCreateResponseSchema.parse(value);
}
