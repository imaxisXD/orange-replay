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

const longSecret = "x".repeat(40);

function validEnvironment() {
  return {
    ORANGE_REPLAY_PROD_API_TOKEN: `${longSecret}api`,
    ORANGE_REPLAY_PROD_API_PROJECT_IDS: "project_one, project_two,project_one",
    ORANGE_REPLAY_PROD_LIVE_TICKET_SECRET: `${longSecret}ticket`,
    ORANGE_REPLAY_PROD_R2_SQL_TOKEN: `${longSecret}r2`,
    ORANGE_REPLAY_PROD_ANALYTICS_PURGE_RUNNER_TOKEN: `${longSecret}purge`,
    ORANGE_REPLAY_PROD_WORKER_URL: "https://replay.example.com",
    CLOUDFLARE_API_TOKEN: "cloudflare-deploy-token",
    CLOUDFLARE_ACCESS_CLIENT_SECRET: "cloudflare-access-secret",
    SAFE_VALUE: "keep",
    ORANGE_REPLAY_PROD_ANALYTICS_READ_BACKEND: "r2_sql",
  };
}

describe("production deploy secret safety", () => {
  it("builds one validated secret file value set", () => {
    const values = readProductionSecretValues(validEnvironment());
    expect(values).toEqual({
      ANALYTICS_PURGE_RUNNER_TOKEN: `${longSecret}purge`,
      DEV_API_PROJECT_IDS: "project_one,project_two",
      DEV_API_TOKEN: `${longSecret}api`,
      LIVE_TICKET_SECRET: `${longSecret}ticket`,
      R2_SQL_TOKEN: `${longSecret}r2`,
    });
  });

  it("rejects short secrets and unsafe project ids", () => {
    expect(() =>
      readProductionSecretValues({
        ...validEnvironment(),
        ORANGE_REPLAY_PROD_R2_SQL_TOKEN: "short",
      }),
    ).toThrow("ORANGE_REPLAY_PROD_R2_SQL_TOKEN must be at least 32 characters");
    expect(() =>
      readProductionSecretValues({
        ...validEnvironment(),
        ORANGE_REPLAY_PROD_API_PROJECT_IDS: "project_one,bad project",
      }),
    ).toThrow("ORANGE_REPLAY_PROD_API_PROJECT_IDS contains an invalid project id");
  });

  it("checks hosted-build smoke credentials before any deploy step", async () => {
    expect(readProductionSmokeValues(validEnvironment())).toEqual({
      apiToken: `${longSecret}api`,
      projectIds: "project_one,project_two",
      smokeProjectId: "project_one",
      workerOrigin: "https://replay.example.com",
    });

    for (const [name, value, error] of [
      [
        "ORANGE_REPLAY_PROD_API_TOKEN",
        "",
        "ORANGE_REPLAY_PROD_API_TOKEN is required before production deploy",
      ],
      [
        "ORANGE_REPLAY_PROD_API_PROJECT_IDS",
        "",
        "ORANGE_REPLAY_PROD_API_PROJECT_IDS is required before production deploy",
      ],
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
      WRANGLER_R2_SQL_AUTH_TOKEN: "wrangler-reader",
      DEV_API_TOKEN: "direct-api",
      DEV_API_PROJECT_IDS: "direct-projects",
      LIVE_TICKET_SECRET: "direct-ticket",
      R2_SQL_TOKEN: "direct-r2",
      ANALYTICS_PURGE_RUNNER_TOKEN: "direct-purge",
    });
    expect(clean.SAFE_VALUE).toBe("keep");
    for (const name of productionSecretEnvironmentNames) expect(clean[name]).toBeUndefined();
    for (const name of productionWorkerSecretNames) expect(clean[name]).toBeUndefined();
    for (const name of [
      "ORANGE_REPLAY_CATALOG_TOKEN",
      "ORANGE_REPLAY_PIPELINE_CATALOG_TOKEN",
      "ORANGE_REPLAY_R2_INVENTORY_TOKEN",
      "ORANGE_REPLAY_R2_SQL_READ_TOKEN",
      "ORANGE_REPLAY_PROD_WRITE_KEY",
      "WRANGLER_R2_SQL_AUTH_TOKEN",
    ]) {
      expect(clean[name]).toBeUndefined();
    }
  });

  it("removes Cloudflare authentication separately from normal values", () => {
    const clean = withoutCloudflareAuth(validEnvironment());
    expect(clean.SAFE_VALUE).toBe("keep");
    for (const name of cloudflareAuthEnvironmentNames) expect(clean[name]).toBeUndefined();
    expect(clean.ORANGE_REPLAY_PROD_API_TOKEN).toBe(`${longSecret}api`);
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
    expect(environment.ORANGE_REPLAY_PROD_API_TOKEN).toBeUndefined();
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
    expect(run.mock.calls[0]?.[2].ORANGE_REPLAY_PROD_API_TOKEN).toBeUndefined();
  });

  it("gives each normal deploy step only the secrets it needs", async () => {
    const environment = {
      ...validEnvironment(),
      DEV_API_TOKEN: "direct-api",
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
      expect(childEnvironment.DEV_API_TOKEN).toBeUndefined();
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

      if (step.kind === "build") {
        expect(childEnvironment.ORANGE_REPLAY_PROD_API_PROJECT_IDS).toBe(
          environment.ORANGE_REPLAY_PROD_API_PROJECT_IDS,
        );
        expect(childEnvironment.ORANGE_REPLAY_PROD_API_TOKEN).toBeUndefined();
      } else if (step.kind === "gate") {
        expect(childEnvironment.ORANGE_REPLAY_PROD_R2_SQL_TOKEN).toBe(
          environment.ORANGE_REPLAY_PROD_R2_SQL_TOKEN,
        );
        expect(childEnvironment.ORANGE_REPLAY_PROD_API_TOKEN).toBeUndefined();
      } else if (step.kind === "deploy" || step.kind === "upload_fallback") {
        for (const name of productionSecretEnvironmentNames) {
          expect(childEnvironment[name]).toBe(environment[name]);
        }
      } else if (step.kind === "smoke") {
        expect(childEnvironment.ORANGE_REPLAY_PROD_API_TOKEN).toBe(
          environment.ORANGE_REPLAY_PROD_API_TOKEN,
        );
        expect(childEnvironment.ORANGE_REPLAY_PROD_API_PROJECT_IDS).toBe(
          environment.ORANGE_REPLAY_PROD_API_PROJECT_IDS,
        );
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
    expect(deployEnvironment.ORANGE_REPLAY_PROD_API_TOKEN).toBeUndefined();
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
});
