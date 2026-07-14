export {
  getAuthMode,
  getHostedAuthStatus,
  getTrustedOrigins,
  isHostedAuthConfigured,
  isTokenAuthConfigured,
  isTrustedMutationOrigin,
  type AuthMode,
  type HostedAuthStatus,
} from "./config.ts";
export {
  getAuthSession,
  getBetterAuth,
  getHostedSession,
  handleBetterAuthRequest,
  isGlobalAdmin,
  type HostedSession,
} from "./server.ts";
