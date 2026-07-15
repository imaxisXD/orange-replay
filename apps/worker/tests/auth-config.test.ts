import { describe, expect, it } from "vite-plus/test";
import { getAuthMode, getHostedAuthStatus, isTrustedMutationOrigin } from "../src/auth/config.ts";
import type { Env } from "../src/env.ts";

const secureSecret = "orange-replay-test-secret-32-characters";

describe("hosted auth configuration", () => {
  it("is unavailable until every Better Auth value is valid", () => {
    expect(getAuthMode(env({}))).toBe("unavailable");
  });

  it("fails closed when hosted auth is only partly configured", () => {
    const value = env({
      BETTER_AUTH_SECRET: secureSecret,
    });

    expect(getAuthMode(value)).toBe("unavailable");
    expect(getHostedAuthStatus(value)).toMatchObject({ state: "invalid" });
  });

  it("uses GitHub when every hosted auth value is valid", () => {
    const value = validHostedEnv();

    expect(getAuthMode(value)).toBe("github");
    expect(getHostedAuthStatus(value)).toMatchObject({ state: "ready" });
  });

  it("accepts only an exact trusted mutation origin", () => {
    const value = validHostedEnv();

    expect(
      isTrustedMutationOrigin(
        new Request("https://replay.example/api/v1/account/bootstrap", {
          method: "POST",
          headers: { origin: "https://replay.example" },
        }),
        value,
      ),
    ).toBe(true);
    expect(
      isTrustedMutationOrigin(
        new Request("https://replay.example/api/v1/account/bootstrap", {
          method: "POST",
          headers: { origin: "https://other.example" },
        }),
        value,
      ),
    ).toBe(false);
    expect(
      isTrustedMutationOrigin(
        new Request("https://replay.example/api/v1/account/bootstrap", { method: "POST" }),
        value,
      ),
    ).toBe(false);
  });

  it("rejects http origins in production", () => {
    const status = getHostedAuthStatus(
      env({
        ...hostedValues("http://replay.example"),
        WORKER_ENV: "production",
      }),
    );

    expect(status.state).toBe("invalid");
    if (status.state === "invalid") {
      expect(status.problems).toContain("BETTER_AUTH_URL must use https in production.");
      expect(status.problems).toContain(
        "BETTER_AUTH_TRUSTED_ORIGINS must use https in production.",
      );
    }
  });
});

function validHostedEnv(): Env {
  return env({
    ...hostedValues("https://replay.example"),
    WORKER_ENV: "production",
  });
}

function hostedValues(origin: string): Partial<Env> {
  return {
    BETTER_AUTH_SECRET: secureSecret,
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_TRUSTED_ORIGINS: origin,
    GITHUB_CLIENT_ID: "github-client-id",
    GITHUB_CLIENT_SECRET: "github-client-secret",
  };
}

function env(values: Partial<Env>): Env {
  return values as Env;
}
