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

export type AuthMode = z.output<typeof authModeSchema>;
export type AccountProjectRole = z.output<typeof accountProjectRoleSchema>;
export type AuthConfigResponse = z.output<typeof authConfigResponseSchema>;
export type AccountUser = z.output<typeof accountUserSchema>;
export type AccountProject = z.output<typeof accountProjectSchema>;
export type AccountWorkspace = z.output<typeof accountWorkspaceSchema>;
export type AccountResponse = z.output<typeof accountResponseSchema>;

export function decodeAuthConfigResponse(value: unknown): AuthConfigResponse {
  return authConfigResponseSchema.parse(value);
}

export function decodeAccountResponse(value: unknown): AccountResponse {
  return accountResponseSchema.parse(value);
}
