import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();

interface HostedSignOutClient {
  signOut: () => Promise<{ error?: unknown }>;
}

export async function signOutHosted(client: HostedSignOutClient = authClient): Promise<void> {
  const result = await client.signOut();
  if (result.error !== null && result.error !== undefined) {
    throw result.error;
  }
}

export function readAuthClientError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = error.message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return fallback;
}
