import { betterAuth } from "better-auth";
import { admin, organization } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import type { Env } from "../env.ts";
import {
  getHostedAuthConfig,
  getHostedAuthStatus,
  type HostedAuthConfig,
  type HostedAuthStatus,
} from "./config.ts";

const JSON_SECURITY_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

const OPERATOR_PERMISSIONS = {
  user: ["list", "get", "set-role", "ban"],
  session: ["list", "revoke"],
} as const;
const operatorAccessControl = createAccessControl(OPERATOR_PERMISSIONS);
const operatorRoles = {
  admin: operatorAccessControl.newRole(OPERATOR_PERMISSIONS),
  user: operatorAccessControl.newRole({ user: [], session: [] }),
};

export interface HostedSession {
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    image: string | null;
    role: string | null;
    banned: boolean;
    banReason: string | null;
    banExpires: Date | null;
  };
  session: {
    id: string;
    userId: string;
    expiresAt: Date;
    activeOrganizationId: string | null;
    impersonatedBy: string | null;
  };
}

export function getBetterAuth(env: Env, executionContext?: ExecutionContext) {
  const status = getHostedAuthStatus(env);
  if (status.state !== "ready") throw new HostedAuthConfigurationError(status);
  return createBetterAuth(env, requireHostedAuthConfig(env), executionContext);
}

export async function handleBetterAuthRequest(
  request: Request,
  env: Env,
  executionContext: ExecutionContext,
): Promise<Response> {
  const status = getHostedAuthStatus(env);
  if (status.state === "disabled") {
    return jsonError(
      "hosted_auth_not_enabled",
      "Better Auth is not configured for this install.",
      503,
    );
  }
  if (status.state === "invalid") {
    return jsonError(
      "hosted_auth_configuration_invalid",
      "Hosted sign-in is unavailable because its configuration is incomplete.",
      503,
    );
  }
  const response = await createBetterAuth(
    env,
    requireHostedAuthConfig(env),
    executionContext,
  ).handler(request);
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  addVary(headers, "Cookie");
  addVary(headers, "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function getHostedSession(
  request: Request,
  env: Env,
  executionContext?: ExecutionContext,
): Promise<HostedSession | null> {
  const status = getHostedAuthStatus(env);
  if (status.state !== "ready") return null;

  const value = await createBetterAuth(
    env,
    requireHostedAuthConfig(env),
    executionContext,
  ).api.getSession({
    headers: request.headers,
  });
  if (value === null) return null;

  return {
    user: {
      id: value.user.id,
      name: value.user.name,
      email: value.user.email,
      emailVerified: value.user.emailVerified,
      image: value.user.image ?? null,
      role: value.user.role ?? null,
      banned: value.user.banned ?? false,
      banReason: value.user.banReason ?? null,
      banExpires: value.user.banExpires ?? null,
    },
    session: {
      id: value.session.id,
      userId: value.session.userId,
      expiresAt: value.session.expiresAt,
      activeOrganizationId: value.session.activeOrganizationId ?? null,
      impersonatedBy: value.session.impersonatedBy ?? null,
    },
  };
}

export const getAuthSession = getHostedSession;

export function isGlobalAdmin(session: HostedSession | null, env: Env): boolean {
  if (session === null || session.user.banned) return false;
  const status = getHostedAuthStatus(env);
  if (status.state !== "ready") return false;
  return readRoles(session.user.role).includes("admin");
}

function createBetterAuth(env: Env, config: HostedAuthConfig, executionContext?: ExecutionContext) {
  return betterAuth({
    appName: "Orange Replay",
    baseURL: config.baseUrl,
    basePath: "/api/auth",
    secret: config.secret,
    database: env.IDX_00,
    emailAndPassword: { enabled: false },
    socialProviders: {
      github: {
        clientId: config.githubClientId,
        clientSecret: config.githubClientSecret,
      },
    },
    user: {
      modelName: "users",
      fields: {
        emailVerified: "email_verified",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      deleteUser: { enabled: false },
    },
    session: {
      modelName: "auth_sessions",
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        userId: "user_id",
      },
      cookieCache: { enabled: false },
    },
    account: {
      modelName: "auth_accounts",
      fields: {
        accountId: "account_id",
        providerId: "provider_id",
        userId: "user_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
      accountLinking: {
        disableImplicitLinking: true,
        allowDifferentEmails: false,
        allowUnlinkingAll: false,
      },
      encryptOAuthTokens: true,
    },
    verification: {
      modelName: "auth_verifications",
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    trustedOrigins: [...config.trustedOrigins],
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "auth_rate_limits",
      fields: { lastRequest: "last_request" },
    },
    advanced: {
      useSecureCookies: config.secureCookies,
      cookiePrefix: "orange-replay",
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        secure: config.secureCookies,
      },
      database: { generateId: "uuid" },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      ...(executionContext === undefined
        ? {}
        : {
            backgroundTasks: {
              handler: (promise: Promise<unknown>) => executionContext.waitUntil(promise),
            },
          }),
    },
    logger: { disabled: true },
    plugins: [
      organization({
        allowUserToCreateOrganization: false,
        creatorRole: "owner",
        disableOrganizationDeletion: true,
        requireEmailVerificationOnInvitation: true,
        teams: { enabled: false },
        schema: {
          session: { fields: { activeOrganizationId: "active_org_id" } },
          organization: {
            modelName: "orgs",
            fields: { createdAt: "created_at" },
          },
          member: {
            modelName: "members",
            fields: {
              organizationId: "org_id",
              userId: "user_id",
              createdAt: "created_at",
            },
          },
          invitation: {
            modelName: "invitations",
            fields: {
              organizationId: "org_id",
              inviterId: "inviter_id",
              expiresAt: "expires_at",
              createdAt: "created_at",
            },
          },
        },
      }),
      admin({
        defaultRole: "user",
        adminRoles: ["admin"],
        ac: operatorAccessControl,
        roles: operatorRoles,
        schema: {
          user: {
            fields: {
              role: "role",
              banned: "banned",
              banReason: "ban_reason",
              banExpires: "ban_expires",
            },
          },
          session: { fields: { impersonatedBy: "impersonated_by" } },
        },
      }),
    ],
  });
}

function readRoles(role: string | null): readonly string[] {
  return (
    role
      ?.split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0) ?? []
  );
}

function requireHostedAuthConfig(env: Env): HostedAuthConfig {
  const config = getHostedAuthConfig(env);
  if (config === null) throw new Error("Hosted auth configuration was not validated.");
  return config;
}

function jsonError(error: string, message: string, status: number): Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: JSON_SECURITY_HEADERS,
  });
}

function addVary(headers: Headers, value: string): void {
  const values = headers
    .get("vary")
    ?.split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (values?.some((item) => item.toLowerCase() === value.toLowerCase())) return;
  headers.set("vary", [...(values ?? []), value].join(", "));
}

class HostedAuthConfigurationError extends Error {
  constructor(status: Exclude<HostedAuthStatus, { state: "ready" }>) {
    super(
      status.state === "disabled"
        ? "Hosted auth is not enabled."
        : `Hosted auth configuration is invalid: ${status.problems.join(" ")}`,
    );
    this.name = "HostedAuthConfigurationError";
  }
}
