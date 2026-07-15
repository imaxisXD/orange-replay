import { describe, expect, it, vi } from "vite-plus/test";
import { exactWorkerR2TokenEnvironment } from "./analytics/cutover-gate.mjs";
import {
  D1_FALLBACK_TAG_PREFIX,
  makeD1FallbackTag,
  readNewestD1FallbackVersion,
} from "./analytics/d1-fallback.mjs";
import {
  buildD1FallbackConfig,
  withoutAnalyticsSecretRequirement,
} from "./analytics/rollback-config.mjs";
import {
  cloudflareAuthEnvironmentNames,
  productionSecretEnvironmentNames,
  productionWorkerSecretNames,
  readProductionR2SqlToken,
  readProductionSecretValues,
  readProductionSmokeValues,
  readWorkerDeploySecrets,
  withoutCloudflareAuth,
  withoutProductionSecrets,
} from "./analytics/production-secrets.mjs";
import { deployNewestD1Fallback } from "./deploy-tagged-d1-fallback.mjs";
import {
  productionDeploySteps,
  productionStepEnvironment,
  runProductionDeploy,
} from "./deploy-production.mjs";
import {
  readRetiredSecretRemovalOptions,
  removeRetiredProductionSecrets,
} from "./remove-retired-prod-secrets.mjs";

const longSecret = "x".repeat(40);
const demoWriteKey = `or_live_${"d".repeat(32)}`;

function validEnvironment() {
  return {
    ORANGE_REPLAY_PROD_PROJECT_ID: "project_one",
    ORANGE_REPLAY_PROD_BETTER_AUTH_SECRET: `${longSecret}auth`,
    ORANGE_REPLAY_PROD_BETTER_AUTH_URL: "https://replay.example.com",
    ORANGE_REPLAY_PROD_BETTER_AUTH_TRUSTED_ORIGINS:
      "https://replay.example.com, https://admin.example.com,https://replay.example.com",
    ORANGE_REPLAY_PROD_GITHUB_CLIENT_ID: "github-client-id-12345",
    ORANGE_REPLAY_PROD_GITHUB_CLIENT_SECRET: `${longSecret}github`,
    ORANGE_REPLAY_PROD_LIVE_TICKET_SECRET: `${longSecret}ticket`,
    ORANGE_REPLAY_DEMO_PROJECT_ID: "demo_project",
    ORANGE_REPLAY_DEMO_WRITE_KEY: demoWriteKey,
    ORANGE_REPLAY_PROD_R2_SQL_TOKEN: `${longSecret}r2`,
    ORANGE_REPLAY_PROD_ANALYTICS_PURGE_RUNNER_TOKEN: `${longSecret}purge`,
    ORANGE_REPLAY_PROD_WORKER_URL: "https://replay.example.com",
    ORANGE_REPLAY_PROD_PUBLIC_PAGE_ORIGIN: "https://public.example.com",
    CLOUDFLARE_API_TOKEN: "cloudflare-deploy-token",
    CLOUDFLARE_ACCESS_CLIENT_SECRET: "cloudflare-access-secret",
    SAFE_VALUE: "keep",
    ORANGE_REPLAY_PROD_ANALYTICS_READ_BACKEND: "r2_sql",
    ORANGE_REPLAY_PROD_ANALYTICS_DELETION_V2_STREAM_ID: "deletion-v2-stream",
    ORANGE_REPLAY_PROD_ANALYTICS_DELETION_READ_VERSION: "v1",
  };
}

describe("production deploy secret safety", () => {
  it("builds one validated secret file value set", () => {
    const values = readProductionSecretValues(validEnvironment());
    expect(values).toEqual({
      ANALYTICS_PURGE_RUNNER_TOKEN: `${longSecret}purge`,
      BETTER_AUTH_SECRET: `${longSecret}auth`,
      BETTER_AUTH_TRUSTED_ORIGINS: "https://replay.example.com,https://admin.example.com",
      BETTER_AUTH_URL: "https://replay.example.com",
      DEMO_PROJECT_ID: "demo_project",
      DEMO_WRITE_KEY: demoWriteKey,
      GITHUB_CLIENT_ID: "github-client-id-12345",
      GITHUB_CLIENT_SECRET: `${longSecret}github`,
      LIVE_TICKET_SECRET: `${longSecret}ticket`,
      R2_SQL_TOKEN: `${longSecret}r2`,
    });
    expect(readWorkerDeploySecrets(validEnvironment())).toEqual(values);
  });

  it("rejects short secrets and invalid hosted values", () => {
    expect(() =>
      readProductionSecretValues({
        ...validEnvironment(),
        ORANGE_REPLAY_PROD_R2_SQL_TOKEN: "short",
      }),
    ).toThrow("ORANGE_REPLAY_PROD_R2_SQL_TOKEN must be at least 32 characters");
    expect(() =>
      readProductionSecretValues({
        ...validEnvironment(),
        ORANGE_REPLAY_PROD_BETTER_AUTH_URL: "https://auth.example.com",
        ORANGE_REPLAY_PROD_BETTER_AUTH_TRUSTED_ORIGINS: "https://auth.example.com",
      }),
    ).toThrow(
      "ORANGE_REPLAY_PROD_BETTER_AUTH_URL must exactly match ORANGE_REPLAY_PROD_WORKER_URL",
    );
    expect(() =>
      readProductionSecretValues({
        ...validEnvironment(),
        ORANGE_REPLAY_DEMO_WRITE_KEY: "or_live_not-a-generated-key",
      }),
    ).toThrow("ORANGE_REPLAY_DEMO_WRITE_KEY must be a generated key that starts with or_live_");
  });

  it("checks the hosted smoke origin before any deploy step", async () => {
    expect(readProductionSmokeValues(validEnvironment())).toEqual({
      workerOrigin: "https://replay.example.com",
    });

    for (const [name, value, error] of [
      [
        "ORANGE_REPLAY_PROD_WORKER_URL",
        "",
        "ORANGE_REPLAY_PROD_WORKER_URL is required before production deploy",
      ],
    ]) {
      const runStep = vi.fn(async () => undefined);
      await expect(
        runProductionDeploy({
          cloudflareBuild: true,
          environment: { ...validEnvironment(), [name]: value },
          runStep,
          report: () => undefined,
        }),
      ).rejects.toThrow(error);
      expect(runStep).not.toHaveBeenCalled();
    }
  });

  it("checks local smoke values before any build or deploy step", async () => {
    for (const workerUrl of ["http://replay.example.com", "https://replay.example.com/path"]) {
      const runStep = vi.fn(async () => undefined);
      await expect(
        runProductionDeploy({
          environment: { ...validEnvironment(), ORANGE_REPLAY_PROD_WORKER_URL: workerUrl },
          runStep,
          report: () => undefined,
        }),
      ).rejects.toThrow("ORANGE_REPLAY_PROD_WORKER_URL must be a clean HTTPS origin");
      expect(runStep).not.toHaveBeenCalled();
    }
  });

  it("removes production secrets from the Wrangler child process", () => {
    const clean = withoutProductionSecrets({
      ...validEnvironment(),
      ORANGE_REPLAY_CATALOG_TOKEN: "catalog",
      ORANGE_REPLAY_PIPELINE_CATALOG_TOKEN: "pipeline",
      ORANGE_REPLAY_R2_INVENTORY_TOKEN: "inventory",
      ORANGE_REPLAY_R2_SQL_READ_TOKEN: "reader",
      ORANGE_REPLAY_PROD_WRITE_KEY: "write-key",
      ORANGE_REPLAY_PROD_API_TOKEN: "retired-prod-token",
      ORANGE_REPLAY_PROD_API_PROJECT_IDS: "retired-prod-projects",
      DEV_API_TOKEN: "retired-dev-token",
      DEV_API_PROJECT_IDS: "retired-dev-projects",
      WRANGLER_R2_SQL_AUTH_TOKEN: "wrangler-reader",
      BETTER_AUTH_SECRET: "direct-auth",
      BETTER_AUTH_URL: "direct-auth-url",
      BETTER_AUTH_TRUSTED_ORIGINS: "direct-trusted-origins",
      GITHUB_CLIENT_ID: "direct-github-id",
      GITHUB_CLIENT_SECRET: "direct-github-secret",
      DEMO_PROJECT_ID: "direct-demo-project",
      DEMO_WRITE_KEY: "direct-demo-write-key",
      LIVE_TICKET_SECRET: "direct-ticket",
      R2_SQL_TOKEN: "direct-r2",
      ANALYTICS_PURGE_RUNNER_TOKEN: "direct-purge",
    });
    expect(clean.SAFE_VALUE).toBe("keep");
    expect(clean.ORANGE_REPLAY_PROD_PUBLIC_PAGE_ORIGIN).toBe("https://public.example.com");
    for (const name of productionSecretEnvironmentNames) expect(clean[name]).toBeUndefined();
    for (const name of productionWorkerSecretNames) expect(clean[name]).toBeUndefined();
    for (const name of [
      "ORANGE_REPLAY_CATALOG_TOKEN",
      "ORANGE_REPLAY_PIPELINE_CATALOG_TOKEN",
      "ORANGE_REPLAY_R2_INVENTORY_TOKEN",
      "ORANGE_REPLAY_R2_SQL_READ_TOKEN",
      "ORANGE_REPLAY_PROD_WRITE_KEY",
      "ORANGE_REPLAY_PROD_API_TOKEN",
      "ORANGE_REPLAY_PROD_API_PROJECT_IDS",
      "DEV_API_TOKEN",
      "DEV_API_PROJECT_IDS",
      "WRANGLER_R2_SQL_AUTH_TOKEN",
    ]) {
      expect(clean[name]).toBeUndefined();
    }
  });

  it("removes Cloudflare authentication separately from normal values", () => {
    const clean = withoutCloudflareAuth(validEnvironment());
    expect(clean.SAFE_VALUE).toBe("keep");
    for (const name of cloudflareAuthEnvironmentNames) expect(clean[name]).toBeUndefined();
    expect(clean.ORANGE_REPLAY_PROD_BETTER_AUTH_URL).toBe(
      validEnvironment().ORANGE_REPLAY_PROD_BETTER_AUTH_URL,
    );
  });

  it("uploads the exact R2 token for Cloudflare compare and R2 modes", () => {
    for (const backend of ["compare", "r2_sql"]) {
      expect(
        readWorkerDeploySecrets(
          { ...validEnvironment(), ORANGE_REPLAY_PROD_ANALYTICS_READ_BACKEND: backend },
          { cloudflareBuild: true },
        ),
      ).toEqual({ R2_SQL_TOKEN: `${longSecret}r2` });
    }
    expect(
      readWorkerDeploySecrets(
        { ...validEnvironment(), ORANGE_REPLAY_PROD_ANALYTICS_READ_BACKEND: "d1" },
        { cloudflareBuild: true },
      ),
    ).toEqual({});
  });

  it("forces the cutover verifier to use the exact Worker R2 token", () => {
    const workerToken = readProductionR2SqlToken(validEnvironment());
    const environment = exactWorkerR2TokenEnvironment(
      withoutProductionSecrets({
        ...validEnvironment(),
        ORANGE_REPLAY_R2_SQL_READ_TOKEN: "different_reader",
        WRANGLER_R2_SQL_AUTH_TOKEN: "different_wrangler_reader",
      }),
      workerToken,
    );

    expect(environment.ORANGE_REPLAY_PROD_R2_SQL_TOKEN).toBe(workerToken);
    expect(environment.ORANGE_REPLAY_R2_SQL_READ_TOKEN).toBeUndefined();
    expect(environment.WRANGLER_R2_SQL_AUTH_TOKEN).toBeUndefined();
    expect(environment.ORANGE_REPLAY_PROD_LIVE_TICKET_SECRET).toBeUndefined();
    expect(environment.ORANGE_REPLAY_PROD_ANALYTICS_PURGE_RUNNER_TOKEN).toBeUndefined();
  });

  it("removes only the analytics secret requirement from a D1 rollback config", () => {
    const secretBlock = `      "secrets": {
        "required": ["R2_SQL_TOKEN", "ANALYTICS_PURGE_RUNNER_TOKEN"],
      },
`;
    const config = `{
  "env": {
    "production": {
${secretBlock}      "vars": { "ANALYTICS_READ_BACKEND": "d1" }
    }
  }
}`;
    const rollbackConfig = withoutAnalyticsSecretRequirement(config);
    expect(rollbackConfig).not.toContain('"secrets"');
    expect(rollbackConfig).toContain('"ANALYTICS_READ_BACKEND": "d1"');
    expect(() =>
      withoutAnalyticsSecretRequirement(
        config.replace('"ANALYTICS_READ_BACKEND": "d1"', '"ANALYTICS_READ_BACKEND": "r2_sql"'),
      ),
    ).toThrow("Emergency rollback config must use the D1 analytics backend");
  });

  it("builds a private D1 config from every selected backend", () => {
    const secretBlock = `      "secrets": {
        "required": ["R2_SQL_TOKEN", "ANALYTICS_PURGE_RUNNER_TOKEN"],
      },
`;
    for (const backend of ["d1", "compare", "r2_sql"]) {
      const config = `${secretBlock}        "ANALYTICS_READ_BACKEND": "${backend}",`;
      const fallback = buildD1FallbackConfig(config, backend);
      expect(fallback).toContain('        "ANALYTICS_READ_BACKEND": "d1",');
      expect(fallback).not.toContain('"secrets"');
    }
  });

  it("selects the newest prepared D1 fallback version", async () => {
    const olderId = "11111111-1111-4111-8111-111111111111";
    const newestId = "22222222-2222-4222-8222-222222222222";
    const output = JSON.stringify([
      {
        id: newestId,
        metadata: { created_on: "2026-07-14T10:00:00.000Z" },
        annotations: { "workers/tag": `${D1_FALLBACK_TAG_PREFIX}2` },
      },
      {
        id: olderId,
        metadata: { created_on: "2026-07-13T10:00:00.000Z" },
        annotations: { "workers/tag": `${D1_FALLBACK_TAG_PREFIX}1` },
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        metadata: { created_on: "2026-07-15T10:00:00.000Z" },
        annotations: { "workers/tag": "unrelated-version" },
      },
    ]);

    expect(makeD1FallbackTag(123)).toBe(`${D1_FALLBACK_TAG_PREFIX}123`);
    expect(readNewestD1FallbackVersion(output)).toMatchObject({ id: newestId });

    const runCapture = vi.fn(async () => output);
    const run = vi.fn(async () => undefined);
    const fallback = await deployNewestD1Fallback({
      environment: validEnvironment(),
      runCapture,
      run,
      report: () => undefined,
    });
    expect(fallback.id).toBe(newestId);
    expect(runCapture.mock.calls[0]?.[1]).toContain("--name");
    expect(runCapture.mock.calls[0]?.[1]).not.toContain("--config");
    expect(run.mock.calls[0]?.[1]).toContain(`${newestId}@100%`);
    expect(run.mock.calls[0]?.[1]).not.toContain("--config");
    expect(run.mock.calls[0]?.[2].CLOUDFLARE_API_TOKEN).toBe("cloudflare-deploy-token");
  });

  it("gives each normal deploy step only the secrets it needs", async () => {
    const environment = {
      ...validEnvironment(),
      ORANGE_REPLAY_CATALOG_TOKEN: "catalog",
      ORANGE_REPLAY_PROD_WRITE_KEY: "write-key",
    };
    const steps = productionDeploySteps(false);
    expect(steps.map((step) => step.kind)).toEqual([
      "prepare",
      "prepare_fallback",
      "build",
      "migrate",
      "gate",
      "upload_fallback",
      "deploy",
      "check_uploaded",
      "smoke",
      "smoke",
    ]);
    expect(steps.find((step) => step.kind === "build")?.args).toEqual([
      "scripts/build-deploy.mjs",
      "--production",
    ]);

    for (const step of steps) {
      const childEnvironment = productionStepEnvironment(step, environment, "r2_sql");
      expect(childEnvironment.ORANGE_REPLAY_PROD_PUBLIC_PAGE_ORIGIN).toBe(
        environment.ORANGE_REPLAY_PROD_PUBLIC_PAGE_ORIGIN,
      );
      expect(childEnvironment.ORANGE_REPLAY_PROD_ANALYTICS_DELETION_V2_STREAM_ID).toBe(
        environment.ORANGE_REPLAY_PROD_ANALYTICS_DELETION_V2_STREAM_ID,
      );
      expect(childEnvironment.ORANGE_REPLAY_PROD_ANALYTICS_DELETION_READ_VERSION).toBe("v1");
      expect(childEnvironment.ORANGE_REPLAY_CATALOG_TOKEN).toBeUndefined();
      expect(childEnvironment.ORANGE_REPLAY_PROD_WRITE_KEY).toBeUndefined();
      const needsCloudflareAuth = new Set([
        "migrate",
        "gate",
        "upload_fallback",
        "deploy",
        "check_uploaded",
      ]).has(step.kind);
      expect(childEnvironment.CLOUDFLARE_API_TOKEN).toBe(
        needsCloudflareAuth ? environment.CLOUDFLARE_API_TOKEN : undefined,
      );
      expect(childEnvironment.CLOUDFLARE_ACCESS_CLIENT_SECRET).toBe(
        needsCloudflareAuth ? environment.CLOUDFLARE_ACCESS_CLIENT_SECRET : undefined,
      );

      if (step.kind === "gate") {
        expect(childEnvironment.ORANGE_REPLAY_PROD_R2_SQL_TOKEN).toBe(
          environment.ORANGE_REPLAY_PROD_R2_SQL_TOKEN,
        );
      } else if (step.kind === "deploy" || step.kind === "upload_fallback") {
        for (const name of productionSecretEnvironmentNames) {
          expect(childEnvironment[name]).toBe(environment[name]);
        }
      } else if (step.kind === "smoke") {
        expect(childEnvironment.ORANGE_REPLAY_PROD_R2_SQL_TOKEN).toBeUndefined();
      } else {
        for (const name of productionSecretEnvironmentNames) {
          expect(childEnvironment[name]).toBeUndefined();
        }
      }
    }

    const runStep = vi.fn(async () => undefined);
    await runProductionDeploy({ environment, runStep, report: () => undefined });
    expect(runStep).toHaveBeenCalledTimes(steps.length);
  });

  it("gives a Cloudflare R2 build only the exact R2 token", async () => {
    const environment = validEnvironment();
    const steps = productionDeploySteps(true);
    expect(steps.map((step) => step.kind)).toEqual([
      "prepare",
      "prepare_fallback",
      "check_uploaded",
      "migrate",
      "gate",
      "upload_fallback",
      "deploy",
      "check_uploaded",
      "smoke",
      "smoke",
    ]);
    const deployStep = steps.find((step) => step.kind === "deploy");
    expect(deployStep?.args).toContain("--cloudflare-build");
    const deployEnvironment = productionStepEnvironment(deployStep, environment, "r2_sql");
    expect(deployEnvironment.ORANGE_REPLAY_PROD_R2_SQL_TOKEN).toBe(
      environment.ORANGE_REPLAY_PROD_R2_SQL_TOKEN,
    );
    expect(deployEnvironment.ORANGE_REPLAY_PROD_LIVE_TICKET_SECRET).toBeUndefined();

    const fallbackStep = steps.find((step) => step.kind === "upload_fallback");
    expect(fallbackStep?.args).toContain("--upload-d1-fallback");
    expect(
      productionStepEnvironment(fallbackStep, environment, "r2_sql")
        .ORANGE_REPLAY_PROD_R2_SQL_TOKEN,
    ).toBe(environment.ORANGE_REPLAY_PROD_R2_SQL_TOKEN);

    const runStep = vi.fn(async () => undefined);
    await runProductionDeploy({
      cloudflareBuild: true,
      environment,
      runStep,
      report: () => undefined,
    });
    expect(runStep).toHaveBeenCalledTimes(steps.length);
  });

  it("removes retired Worker secrets only after listing them and verifies absence", async () => {
    const uploaded = new Set([
      ...productionWorkerSecretNames,
      "DEV_API_TOKEN",
      "DEV_API_PROJECT_IDS",
    ]);
    const removeSecret = vi.fn(async (name) => {
      uploaded.delete(name);
    });

    await expect(
      removeRetiredProductionSecrets({
        listUploaded: async () => new Set(uploaded),
        removeSecret,
      }),
    ).resolves.toEqual(["DEV_API_TOKEN", "DEV_API_PROJECT_IDS"]);
    expect(removeSecret.mock.calls.map(([name]) => name)).toEqual([
      "DEV_API_TOKEN",
      "DEV_API_PROJECT_IDS",
    ]);
    expect(uploaded).toEqual(new Set(productionWorkerSecretNames));
  });

  it("does not retire old secrets when a required Better Auth-era secret is missing", async () => {
    const uploaded = new Set([
      ...productionWorkerSecretNames.filter((name) => name !== "GITHUB_CLIENT_SECRET"),
      "DEV_API_TOKEN",
    ]);
    const removeSecret = vi.fn(async () => undefined);

    await expect(
      removeRetiredProductionSecrets({
        listUploaded: async () => new Set(uploaded),
        removeSecret,
      }),
    ).rejects.toThrow("GITHUB_CLIENT_SECRET");
    expect(removeSecret).not.toHaveBeenCalled();
  });

  it("requires an explicit real-login confirmation before remote secret retirement", () => {
    expect(() => readRetiredSecretRemovalOptions([])).toThrow(
      "Confirm a real production Better Auth login first",
    );
    expect(readRetiredSecretRemovalOptions(["--confirm-better-auth-login"])).toMatchObject({
      confirmedLogin: true,
    });
  });
});
