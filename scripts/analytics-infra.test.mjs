import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vite-plus/test";
import { drainAnalyticsExports } from "../apps/worker/src/analytics/exporter.ts";
import {
  buildSetupPlan,
  environmentWithoutSetupTokens,
  loadAnalyticsResources,
  parseSetupArguments,
  readSetupTokens,
  redactSecret,
} from "./analytics/setup-lib.mjs";
import {
  ANALYTICS_OUTBOX_PAYLOAD_MAX_BYTES,
  D1_BACKFILL_READ_SQL_MAX_BYTES,
  D1_OUTBOX_INSERT_SQL_MAX_BYTES,
  buildDurationRecoverySql,
  buildDeletionOutboxRecord,
  buildBackfillCompletionSql,
  buildEventOutboxRecords,
  buildOutboxInsertBatches,
  buildOutboxInsertSql,
  buildSessionEventsQueries,
  buildSessionOutboxRecord,
  classifySession,
  durationRecoveryExportId,
  durationRecoveryDeletionExportId,
  parseBackfillArguments,
  parseManifestInventory,
  recoverManifestSessionFacts,
  usesDefaultAnalyticsCatalog,
  validateManifestText,
} from "./analytics/backfill-lib.mjs";
import { readAnalyticsDeployMode, readAnalyticsSmokeProjectId } from "./analytics/deploy-mode.mjs";
import {
  MAX_STATE_CHECKS,
  STATE_CHECK_WAIT_MS,
  readStatsAfterDeploy,
} from "./analytics/smoke-state.mjs";
import {
  needsAnalyticsCutoverCheck,
  productionAcceptanceArguments,
} from "./analytics/cutover-gate.mjs";
import {
  D1_ROLLBACK_STEPS,
  rollbackStepEnvironment,
  runProductionD1Rollback,
} from "./deploy-prod-rollback.mjs";
import {
  D1_REBUILD_ROLLBACK_STEPS,
  rebuildRollbackStepEnvironment,
} from "./deploy-prod-rebuild-rollback.mjs";
import { productionDeploySteps } from "./deploy-production.mjs";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDirectory, "..");
const resourcePath = path.join(repoRoot, "infra", "analytics", "resources.production.json");
const deletionV2ResourcePath = path.join(
  repoRoot,
  "infra",
  "analytics",
  "deletion-v2",
  "resources.production.json",
);
const durationV2ResourcePath = path.join(
  repoRoot,
  "infra",
  "analytics",
  "duration-v2",
  "resources.production.json",
);

describe("analytics resource setup", () => {
  it("defines one stream and exactly three Data Catalog tables", async () => {
    const resources = await loadAnalyticsResources(resourcePath);
    expect(resources.bucket).toBe("orange-replay-analytics-prod");
    expect(resources.pipeline).toBe("orange_replay_analytics_prod");
    expect(resources.namespace).toBe("default");
    expect(resources.maintenance).toEqual({
      compactionTargetMb: 128,
      snapshotOlderThanDays: 1,
      snapshotRetainLast: 10,
    });
    expect(resources.sinks.map((sink) => sink.table)).toEqual([
      "analytics_sessions",
      "analytics_events",
      "analytics_deletions",
    ]);

    const plan = buildSetupPlan(resources, {
      bucket: true,
      catalog: true,
      pipeline: false,
      sinks: Object.fromEntries(resources.sinks.map((sink) => [sink.name, true])),
      stream: true,
    });
    expect(plan.steps.filter((step) => step.action === "create")).toEqual([
      { action: "create", kind: "pipeline", name: resources.pipeline },
    ]);
    expect(plan.needsCatalogToken).toBe(true);
    expect(plan.needsPipelineCatalogToken).toBe(false);
    expect(plan.steps).toContainEqual({
      action: "configure",
      kind: "catalog_compaction",
      name: resources.bucket,
      targetSizeMb: 128,
    });

    const missingSinkPlan = buildSetupPlan(resources, {
      bucket: true,
      catalog: true,
      pipeline: true,
      sinks: {
        ...Object.fromEntries(resources.sinks.map((sink) => [sink.name, true])),
        [resources.sinks[0].name]: false,
      },
      stream: true,
    });
    expect(missingSinkPlan.needsPipelineCatalogToken).toBe(true);
  });

  it("keeps v1 unchanged and provisions deletion v2 as a separate stream and table", async () => {
    const v1Schema = await readFile(
      path.join(repoRoot, "infra", "analytics", "stream-schema.json"),
      "utf8",
    );
    const v1Pipeline = await readFile(
      path.join(repoRoot, "infra", "analytics", "pipeline.sql"),
      "utf8",
    );
    expect(v1Schema).not.toContain("session_started_at");
    expect(v1Pipeline).not.toContain("session_started_at");
    expect(v1Pipeline).not.toContain("analytics_deletions_v2");

    const resources = await loadAnalyticsResources(deletionV2ResourcePath);
    expect(resources.stream).toBe("orange_replay_analytics_deletion_v2_stream");
    expect(resources.pipeline).toBe("orange_replay_analytics_deletion_v2_prod");
    expect(resources.sinks).toEqual([
      {
        name: "orange_replay_analytics_deletions_v2_sink",
        table: "analytics_deletions_v2",
      },
    ]);
    expect(resources.streamSchema.fields).toContainEqual({
      name: "session_started_at",
      required: false,
      type: "int64",
    });
    expect(resources.pipelineSql).toContain("FROM orange_replay_analytics_deletion_v2_stream");
    expect(resources.pipelineSql).not.toContain("orange_replay_analytics_stream");
  });

  it("defines the duration recovery warehouse as new tables on the existing stream", async () => {
    const resources = await loadAnalyticsResources(durationV2ResourcePath);
    expect(resources.stream).toBe("orange_replay_analytics_stream");
    expect(resources.pipeline).toBe("orange_replay_analytics_duration_v2_prod");
    expect(resources.sinks).toEqual([
      {
        name: "orange_replay_analytics_sessions_duration_v2_sink",
        table: "analytics_sessions_duration_v2",
      },
      {
        name: "orange_replay_analytics_events_duration_v2_sink",
        table: "analytics_events_duration_v2",
      },
      {
        name: "orange_replay_analytics_deletions_duration_v2_sink",
        table: "analytics_deletions_duration_v2",
      },
    ]);
    expect(resources.pipelineSql).toContain("FROM orange_replay_analytics_stream");
    expect(resources.pipelineSql).not.toContain("orange_replay_analytics_sessions_sink");
  });

  it("keeps Pipeline sink and bucket maintenance credentials separate", () => {
    const catalogToken = "c".repeat(40);
    const pipelineCatalogToken = "p".repeat(40);

    expect(
      readSetupTokens(
        { ORANGE_REPLAY_CATALOG_TOKEN: catalogToken },
        { needsCatalogToken: true, needsPipelineCatalogToken: false },
      ),
    ).toEqual({ catalogToken, pipelineCatalogToken: "" });
    expect(() =>
      readSetupTokens(
        { ORANGE_REPLAY_CATALOG_TOKEN: catalogToken },
        { needsCatalogToken: true, needsPipelineCatalogToken: true },
      ),
    ).toThrow("ORANGE_REPLAY_PIPELINE_CATALOG_TOKEN is required");
    expect(
      readSetupTokens(
        {
          ORANGE_REPLAY_CATALOG_TOKEN: catalogToken,
          ORANGE_REPLAY_PIPELINE_CATALOG_TOKEN: pipelineCatalogToken,
        },
        { needsCatalogToken: true, needsPipelineCatalogToken: true },
      ),
    ).toEqual({ catalogToken, pipelineCatalogToken });
    expect(() =>
      readSetupTokens(
        {
          ORANGE_REPLAY_CATALOG_TOKEN: catalogToken,
          ORANGE_REPLAY_PIPELINE_CATALOG_TOKEN: catalogToken,
        },
        { needsCatalogToken: true, needsPipelineCatalogToken: true },
      ),
    ).toThrow("Use different tokens");

    expect(
      environmentWithoutSetupTokens({
        KEEP_ME: "yes",
        ORANGE_REPLAY_CATALOG_TOKEN: catalogToken,
        ORANGE_REPLAY_PIPELINE_CATALOG_TOKEN: pipelineCatalogToken,
      }),
    ).toEqual({ KEEP_ME: "yes" });
  });

  it("uses millisecond ingest time and carries the event count for reconciliation", async () => {
    const schema = JSON.parse(
      await readFile(path.join(repoRoot, "infra", "analytics", "stream-schema.json"), "utf8"),
    );
    const fields = new Map(schema.fields.map((field) => [field.name, field]));
    expect(fields.get("recorded_at")).toMatchObject({
      required: true,
      type: "timestamp",
      unit: "millisecond",
    });
    expect(fields.get("event_count")).toMatchObject({ required: false, type: "int64" });
  });

  it("is dry-run by default and never leaks a provided token", () => {
    expect(parseSetupArguments([], resourcePath)).toMatchObject({
      apply: false,
      offline: false,
    });
    expect(redactSecret("failed with token-secret", ["token-secret"])).toBe("failed with [hidden]");
  });

  it("turns off Wrangler disk logs before passing the sink token", async () => {
    const source = await readFile(path.join(scriptsDirectory, "setup-analytics.mjs"), "utf8");
    expect(source).toContain('WRANGLER_LOG_SANITIZE: "true"');
    expect(source).toContain('WRANGLER_WRITE_LOGS: "false"');
    expect(source).toMatch(/"--catalog-token",\s*tokens\.pipelineCatalogToken/);
    expect(source).toMatch(/"--token",\s*tokens\.catalogToken/);
  });
});

describe("analytics production deploy safety", () => {
  it("requires an explicit backend and maps it to the public analytics state", () => {
    expect(() => readAnalyticsDeployMode({})).toThrow(
      "ORANGE_REPLAY_PROD_ANALYTICS_READ_BACKEND is required",
    );
    expect(() =>
      readAnalyticsDeployMode({ ORANGE_REPLAY_PROD_ANALYTICS_READ_BACKEND: "unknown" }),
    ).toThrow("must be d1, compare, or r2_sql");
    expect(readAnalyticsDeployMode({ ORANGE_REPLAY_PROD_ANALYTICS_READ_BACKEND: "d1" })).toEqual({
      backend: "d1",
      expectedState: "d1_rollback",
    });
    expect(
      readAnalyticsDeployMode({ ORANGE_REPLAY_PROD_ANALYTICS_READ_BACKEND: "compare" }),
    ).toEqual({ backend: "compare", expectedState: "compare" });
    expect(
      readAnalyticsDeployMode({ ORANGE_REPLAY_PROD_ANALYTICS_READ_BACKEND: "r2_sql" }),
    ).toEqual({ backend: "r2_sql", expectedState: "fresh" });
  });

  it("requires one explicit analytics project", () => {
    expect(
      readAnalyticsSmokeProjectId({
        ORANGE_REPLAY_PROD_PROJECT_ID: "project_second",
      }),
    ).toBe("project_second");
    expect(() => readAnalyticsSmokeProjectId({})).toThrow(
      "ORANGE_REPLAY_PROD_PROJECT_ID must include a valid project id",
    );
  });

  it("waits for a previous valid analytics state to change after deploy", async () => {
    const readyStats = { analyticsState: "d1_rollback", sessions: { value: 4 } };
    const readStats = vi
      .fn()
      .mockResolvedValueOnce({ analyticsState: "fresh" })
      .mockResolvedValueOnce(readyStats);
    const wait = vi.fn(async () => undefined);
    const reportRetry = vi.fn();

    await expect(
      readStatsAfterDeploy({
        expectedState: "d1_rollback",
        readStats,
        wait,
        reportRetry,
      }),
    ).resolves.toBe(readyStats);

    expect(readStats).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(STATE_CHECK_WAIT_MS);
    expect(reportRetry).toHaveBeenCalledWith(
      `Analytics state is still fresh; expected d1_rollback. Waiting 2 seconds for Cloudflare deployment (check 1 of ${MAX_STATE_CHECKS}).`,
    );
  });

  it("stops checking after a bounded number of state mismatches", async () => {
    const readStats = vi.fn(async () => ({ analyticsState: "fresh" }));
    const wait = vi.fn(async () => undefined);
    const reportRetry = vi.fn();

    await expect(
      readStatsAfterDeploy({
        expectedState: "d1_rollback",
        readStats,
        wait,
        reportRetry,
      }),
    ).rejects.toThrow(
      `Cloudflare did not reach analytics state d1_rollback after ${MAX_STATE_CHECKS} checks; the last state was fresh.`,
    );

    expect(readStats).toHaveBeenCalledTimes(MAX_STATE_CHECKS);
    expect(wait).toHaveBeenCalledTimes(MAX_STATE_CHECKS - 1);
    expect(reportRetry).toHaveBeenCalledTimes(MAX_STATE_CHECKS - 1);
  });

  it("does not retry a failed stats request", async () => {
    const readStats = vi.fn(async () => {
      throw new Error("Stats request failed.");
    });
    const wait = vi.fn(async () => undefined);

    await expect(readStatsAfterDeploy({ expectedState: "fresh", readStats, wait })).rejects.toThrow(
      "Stats request failed.",
    );
    expect(readStats).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it("does not retry an invalid analytics state", async () => {
    const readStats = vi.fn(async () => ({ analyticsState: undefined }));
    const wait = vi.fn(async () => undefined);

    await expect(readStatsAfterDeploy({ expectedState: "fresh", readStats, wait })).rejects.toThrow(
      "Analytics state is undefined; expected fresh.",
    );
    expect(readStats).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it("keeps the production backend out of the committed config and smokes every deploy", async () => {
    const workerConfig = await readFile(
      path.join(repoRoot, "apps", "worker", "wrangler.jsonc"),
      "utf8",
    );
    const generator = await readFile(
      path.join(scriptsDirectory, "prepare-cloudflare-build-config.mjs"),
      "utf8",
    );
    const deployer = await readFile(
      path.join(scriptsDirectory, "deploy-worker-with-secrets.mjs"),
      "utf8",
    );
    const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
    const workerPackageJson = JSON.parse(
      await readFile(path.join(repoRoot, "apps", "worker", "package.json"), "utf8"),
    );
    const workerNodeVersion = (
      await readFile(path.join(repoRoot, "apps", "worker", ".node-version"), "utf8")
    ).trim();

    expect(workerConfig).toContain(
      '"ANALYTICS_READ_BACKEND": "REPLACE_WITH_PRODUCTION_ANALYTICS_READ_BACKEND"',
    );
    expect(workerConfig).toContain(
      '"ANALYTICS_DELETION_READ_VERSION": "REPLACE_WITH_PRODUCTION_ANALYTICS_DELETION_READ_VERSION"',
    );
    expect(workerConfig).toContain('"binding": "ANALYTICS_DELETION_V2_STREAM"');
    expect(workerConfig).toContain(
      '"stream": "REPLACE_WITH_PRODUCTION_ANALYTICS_DELETION_V2_STREAM_ID"',
    );
    expect(generator).toContain("readAnalyticsDeployMode(environment)");
    expect(generator).toContain("ORANGE_REPLAY_PROD_PUBLIC_PAGE_ORIGIN");
    expect(generator).toContain("readPublicPageConfig(environment)");
    expect(generator).toContain("ORANGE_REPLAY_PROD_ANALYTICS_DELETION_V2_STREAM_ID");
    expect(packageJson.scripts["analytics:smoke:prod"]).toBe(
      "node scripts/smoke-analytics-prod.mjs",
    );
    expect(packageJson.scripts["deploy:prod"]).toBe("node scripts/deploy-production.mjs");
    expect(packageJson.scripts["deploy:cloudflare-build"]).toBe(
      "node scripts/deploy-production.mjs --cloudflare-build",
    );
    expect(packageJson.scripts["build:deploy"]).toBe("node scripts/build-deploy.mjs --production");
    expect(workerPackageJson.scripts["build:deploy"]).toBe(
      "cd ../.. && node scripts/build-deploy.mjs --production",
    );
    expect(workerNodeVersion).toBe("22.18.0");
    expect(deployer).toContain('"--keep-vars"');
    expect(deployer).toContain('"--strict"');
    expect(deployer).toContain('"--secrets-file"');
    expect(packageJson.scripts["deploy:prod:dry-run"]).toContain("--keep-vars");
    expect(packageJson.scripts["deploy:prod:dry-run"]).toContain("build-deploy.mjs --production");
    expect(packageJson.scripts["deploy:prod"]).not.toContain(
      "ORANGE_REPLAY_PROD_ANALYTICS_READ_BACKEND=",
    );
    expect(packageJson.scripts["deploy:prod:d1"]).toContain(
      "ORANGE_REPLAY_PROD_ANALYTICS_READ_BACKEND=d1",
    );
    expect(packageJson.scripts["deploy:prod:compare"]).toContain(
      "ORANGE_REPLAY_PROD_ANALYTICS_READ_BACKEND=compare",
    );
    expect(packageJson.scripts["deploy:prod:r2-sql"]).toContain(
      "ORANGE_REPLAY_PROD_ANALYTICS_READ_BACKEND=r2_sql",
    );
    expect(packageJson.scripts["deploy:prod:rollback"]).toBe(
      "node scripts/deploy-prod-rollback.mjs",
    );
    expect(packageJson.scripts["deploy:prod:rollback:rebuild"]).toBe(
      "node scripts/deploy-prod-rebuild-rollback.mjs",
    );
    for (const cloudflareBuild of [false, true]) {
      const steps = productionDeploySteps(cloudflareBuild);
      const gateIndex = steps.findIndex((step) =>
        step.args.includes("scripts/run-analytics-cutover-gate.mjs"),
      );
      const fallbackIndex = steps.findIndex((step) => step.kind === "upload_fallback");
      const deployIndex = steps.findIndex((step) => step.kind === "deploy");
      expect(gateIndex).toBeGreaterThanOrEqual(0);
      expect(fallbackIndex).toBeGreaterThan(gateIndex);
      expect(deployIndex).toBeGreaterThan(gateIndex);
      expect(deployIndex).toBeGreaterThan(fallbackIndex);
      const buildStep = steps.find((step) => step.kind === "build");
      if (cloudflareBuild) {
        expect(buildStep).toBeUndefined();
      } else {
        expect(buildStep?.args).toEqual(["scripts/build-deploy.mjs", "--production"]);
      }
      expect(steps.some((step) => step.args.includes("scripts/smoke-analytics-prod.mjs"))).toBe(
        true,
      );
    }
    expect(packageJson.scripts["deploy:prod"]).not.toContain("wrangler secret put");
    expect(packageJson.scripts["deploy:cloudflare-build"]).not.toContain("wrangler secret put");
  });

  it("keeps emergency D1 rollback independent from normal deploy work", async () => {
    expect(D1_ROLLBACK_STEPS.map((step) => step.label)).toEqual([
      "Deploy the newest prepared D1 fallback version",
      "Check the production API",
      "Check D1 analytics",
    ]);

    const commandText = D1_ROLLBACK_STEPS.map((step) =>
      [step.command, ...step.args].join(" "),
    ).join("\n");
    for (const forbiddenWork of [
      "build-deploy.mjs",
      "apply-d1-migrations.mjs",
      "check-prod-secret.mjs",
      "run-analytics-cutover-gate.mjs",
      "deploy:prod",
      "--secrets-file",
      "wrangler.cloudflare-build.jsonc",
      "prepare-prod-rollback-config.mjs",
    ]) {
      expect(commandText).not.toContain(forbiddenWork);
    }

    expect(D1_ROLLBACK_STEPS[0]?.args).toEqual(["scripts/deploy-tagged-d1-fallback.mjs"]);
    expect(D1_ROLLBACK_STEPS.slice(1).map((step) => step.args[0])).toEqual([
      "scripts/smoke-prod-api.mjs",
      "scripts/smoke-analytics-prod.mjs",
    ]);

    const runStep = vi.fn(async () => undefined);
    const report = vi.fn();
    await runProductionD1Rollback({
      environment: {
        KEEP_REMOTE_SETTINGS: "yes",
        ORANGE_REPLAY_PROD_ANALYTICS_READ_BACKEND: "r2_sql",
        ORANGE_REPLAY_PROD_PROJECT_ID: "p1",
        CLOUDFLARE_API_TOKEN: "cloudflare-secret",
        ORANGE_REPLAY_PROD_ANALYTICS_PURGE_RUNNER_TOKEN: "purge-secret",
        ORANGE_REPLAY_PROD_LIVE_TICKET_SECRET: "ticket-secret",
        ORANGE_REPLAY_PROD_R2_SQL_TOKEN: "r2-secret",
      },
      runStep,
      report,
    });

    expect(runStep).toHaveBeenCalledTimes(D1_ROLLBACK_STEPS.length);
    for (const call of runStep.mock.calls) {
      expect(call[1]).toMatchObject({
        KEEP_REMOTE_SETTINGS: "yes",
        ORANGE_REPLAY_PROD_ANALYTICS_READ_BACKEND: "d1",
      });
      expect(call[1].ORANGE_REPLAY_PROD_ANALYTICS_PURGE_RUNNER_TOKEN).toBeUndefined();
      expect(call[1].ORANGE_REPLAY_PROD_LIVE_TICKET_SECRET).toBeUndefined();
      expect(call[1].ORANGE_REPLAY_PROD_R2_SQL_TOKEN).toBeUndefined();
    }
    expect(runStep.mock.calls[0]?.[1].CLOUDFLARE_API_TOKEN).toBe("cloudflare-secret");
    for (const call of runStep.mock.calls.slice(1)) {
      expect(call[1].CLOUDFLARE_API_TOKEN).toBeUndefined();
    }
    expect(report).toHaveBeenLastCalledWith(
      "The prepared D1 rollback passed the production API and analytics smoke checks.",
    );
  });

  it("keeps the source rebuild rollback as a clearly separate second choice", () => {
    expect(D1_REBUILD_ROLLBACK_STEPS.map((step) => step.kind)).toEqual([
      "prepare",
      "prepare",
      "deploy_rebuild",
      "smoke",
      "smoke",
    ]);
    const environment = {
      CLOUDFLARE_API_TOKEN: "cloudflare-secret",
      ORANGE_REPLAY_PROD_PROJECT_ID: "p1",
    };
    expect(
      rebuildRollbackStepEnvironment(D1_REBUILD_ROLLBACK_STEPS[0], environment)
        .CLOUDFLARE_API_TOKEN,
    ).toBeUndefined();
    expect(
      rebuildRollbackStepEnvironment(D1_REBUILD_ROLLBACK_STEPS[2], environment)
        .CLOUDFLARE_API_TOKEN,
    ).toBe("cloudflare-secret");
    expect(rebuildRollbackStepEnvironment(D1_REBUILD_ROLLBACK_STEPS[3], environment)).toMatchObject(
      {
        ORANGE_REPLAY_PROD_PROJECT_ID: "p1",
      },
    );
  });

  it("does not give rollback smoke checks private dashboard credentials", () => {
    const environment = {
      ORANGE_REPLAY_PROD_PROJECT_ID: "p1",
      ORANGE_REPLAY_PROD_R2_SQL_TOKEN: "r2-secret",
    };
    expect(rollbackStepEnvironment(D1_ROLLBACK_STEPS[0], environment)).toMatchObject({
      ORANGE_REPLAY_PROD_PROJECT_ID: "p1",
    });
    expect(rollbackStepEnvironment(D1_ROLLBACK_STEPS[1], environment)).toMatchObject({
      ORANGE_REPLAY_PROD_PROJECT_ID: "p1",
    });
  });

  it("requires the full verifier for compare and R2 while keeping D1 open", () => {
    expect(needsAnalyticsCutoverCheck("r2_sql")).toBe(true);
    expect(needsAnalyticsCutoverCheck("compare")).toBe(true);
    expect(needsAnalyticsCutoverCheck("d1")).toBe(false);
    expect(productionAcceptanceArguments).toEqual([
      "--database",
      "orange-replay-idx-00-prod",
      "--bucket",
      "orange-replay-analytics-prod",
      "--config",
      "apps/worker/wrangler.cloudflare-build.jsonc",
      "--env",
      "production",
    ]);
  });

  it("protects the purge job and pins every GitHub action to a full commit", async () => {
    const workflow = await readFile(
      path.join(repoRoot, ".github", "workflows", "analytics-purge.yml"),
      "utf8",
    );
    expect(workflow).toMatch(/\n  purge:\n    environment: production-analytics\n/);

    const actionReferences = [...workflow.matchAll(/uses:\s+(actions\/[A-Za-z0-9_-]+)@([^\s]+)/g)];
    expect(actionReferences.map((match) => match[1])).toEqual([
      "actions/checkout",
      "actions/setup-java",
      "actions/setup-python",
    ]);
    for (const reference of actionReferences) {
      expect(reference[2]).toMatch(/^[a-f0-9]{40}$/);
    }
  });
});

describe("analytics backfill", () => {
  it("requires an explicit local or production source", () => {
    expect(() =>
      parseBackfillArguments(
        [
          "--database",
          "orange-replay",
          "--recordings-bucket",
          "recordings",
          "--inventory",
          "objects.json",
        ],
        {},
      ),
    ).toThrow("--source must be local or production");
    expect(
      parseBackfillArguments(
        [
          "--source",
          "production",
          "--database",
          "orange-replay-prod",
          "--recordings-bucket",
          "recordings-prod",
          "--inventory",
          "objects.json",
          "--recover-durations",
        ],
        {},
      ),
    ).toMatchObject({ apply: false, recoverDurations: true, source: "production" });
  });

  it("reads JSON and newline inventories without double-counting keys", () => {
    expect(
      parseManifestInventory(
        JSON.stringify({
          objects: [
            { key: "p/project/session/manifest.json" },
            { key: "p/project/session/manifest.json" },
          ],
        }),
      ),
    ).toEqual(["p/project/session/manifest.json"]);
    expect(parseManifestInventory("b\na\n")).toEqual(["a", "b"]);
  });

  it("validates manifest identity without reading replay segments", () => {
    const key = "p/project_1/session_1/manifest.json";
    expect(
      validateManifestText(
        key,
        JSON.stringify({
          projectId: "project_1",
          segments: [],
          sessionId: "session_1",
          timeline: [],
          v: 1,
        }),
        new Set(),
      ),
    ).toEqual({ ok: true });
    expect(
      validateManifestText(
        key,
        JSON.stringify({
          projectId: "another_project",
          segments: [],
          sessionId: "session_1",
          timeline: [],
          v: 1,
        }),
        new Set(),
      ),
    ).toEqual({ ok: false, reason: "invalid_manifest_shape" });
  });

  it("proves every manifest segment exists in the complete inventory", () => {
    const manifestKey = "p/project_1/session_1/manifest.json";
    const segmentKey = "p/project_1/session_1/seg-000001.ors";
    const manifest = JSON.stringify({
      projectId: "project_1",
      segments: [{ key: segmentKey }],
      sessionId: "session_1",
      timeline: [],
      v: 1,
    });

    expect(validateManifestText(manifestKey, manifest, new Set([segmentKey]))).toEqual({
      ok: true,
    });
    expect(validateManifestText(manifestKey, manifest, new Set())).toEqual({
      ok: false,
      reason: "missing_segment_objects",
      missingSegmentCount: 1,
    });
  });

  it("recovers recorded duration and checkpoint truth from manifest metadata", () => {
    expect(
      recoverManifestSessionFacts(
        JSON.stringify({
          segments: [
            { checkpoints: [], t0: 1_000, t1: 1_200 },
            { checkpoints: [{ t: 1_300 }], t0: 1_250, t1: 1_900 },
          ],
        }),
      ),
    ).toEqual({ durationMs: 900, hasCheckpoint: 1 });
    expect(
      recoverManifestSessionFacts(
        JSON.stringify({ segments: [{ checkpoints: [], t0: 1_000, t1: 1_000 }] }),
      ),
    ).toEqual({ durationMs: 0, hasCheckpoint: 0 });
    expect(
      recoverManifestSessionFacts(JSON.stringify({ segments: [{ t0: 1_000, t1: 1_500 }] })),
    ).toEqual({ durationMs: 500, hasCheckpoint: null });
  });

  it("uses disjoint skip reasons and keeps deletion first", () => {
    const inventory = new Set(["p/project_1/session_1/manifest.json"]);
    const checks = new Map([["p/project_1/session_1/manifest.json", { ok: true }]]);
    expect(
      classifySession(
        {
          expires_at: 1,
          is_deleted: 1,
          manifest_key: "p/project_1/session_1/manifest.json",
        },
        inventory,
        checks,
        2,
      ),
    ).toBe("deleted");
    expect(
      classifySession(
        {
          expires_at: 1,
          is_deleted: 0,
          manifest_key: "p/project_1/session_1/manifest.json",
        },
        inventory,
        checks,
        2,
      ),
    ).toBe("expired");
  });

  it("builds stable sparse records and safely quotes their D1 outbox SQL", () => {
    const session = sampleSession();
    const sessionRecord = buildSessionOutboxRecord(session, 2);
    const eventRecords = buildEventOutboxRecords(session, [
      { detail: "Can't load", kind: "error", t: 50 },
      { detail: null, kind: "custom", t: 20 },
    ]);

    expect(sessionRecord.payload.event_coverage).toBe("sparse");
    expect(sessionRecord.payload.event_count).toBe(2);
    expect(sessionRecord.payload.analytics_sidecar_key).toBeNull();
    expect(sessionRecord.payload.recorded_at).toBe(session.ended_at);
    expect(eventRecords.map((record) => record.payload.event_index)).toEqual([0, 1]);
    expect(eventRecords.every((record) => record.payload.event_coverage === "sparse")).toBe(true);
    expect(eventRecords[0]?.payload.recorded_at).toBe(20);
    expect(eventRecords[1]?.payload.event_detail).toBe("Can't load");
    expect(Object.keys(eventRecords[0]?.payload ?? {}).sort()).toEqual(
      [
        "event_coverage",
        "event_detail",
        "event_index",
        "event_kind",
        "event_time",
        "export_id",
        "project_id",
        "record_kind",
        "recorded_at",
        "schema_version",
        "session_id",
      ].sort(),
    );

    const orderedRecords = [...eventRecords, sessionRecord];
    expect(orderedRecords.map((record) => record.recordKind)).toEqual([
      "event",
      "event",
      "session",
    ]);

    const sql = buildOutboxInsertSql(orderedRecords, 1_700_000_000_000);
    expect(sql).toContain("INSERT OR IGNORE INTO analytics_export_outbox");
    expect(sql).toContain("Can''t load");
    expect(sql).not.toContain("export_sequence");
    expect(sql).toContain("project.jurisdiction IS NULL");
    expect(sql).toContain("FROM session_deletions deletion");
    expect(sql).not.toContain("event_meta_json");
  });

  it("builds a versioned duration correction and guarded D1 update", () => {
    const session = { ...sampleSession(), duration_ms: 900 };
    const exportId = durationRecoveryExportId(session.project_id, session.session_id);
    const record = buildSessionOutboxRecord(session, 2, { exportId });
    expect(record.exportId).toBe("session:duration-recovery-v1:project_1:session_1");
    expect(record.payload.duration_ms).toBe(900);

    const completeRecord = buildSessionOutboxRecord(session, 2, {
      analyticsSidecarKey: "p/project_1/session_1/analytics.ndjson",
      eventCoverage: "complete",
      exportId,
    });
    expect(completeRecord.payload).toMatchObject({
      analytics_sidecar_key: "p/project_1/session_1/analytics.ndjson",
      event_count: 2,
      event_coverage: "complete",
    });

    const recoveryEvents = buildEventOutboxRecords(
      session,
      [{ detail: "saved", kind: "custom", t: 1_700_000_000_100 }],
      { durationRecovery: true },
    );
    expect(recoveryEvents[0]?.exportId).toBe(
      "event:duration-recovery-v1:project_1:session_1:0:1700000000100:custom",
    );

    const deletion = buildDeletionOutboxRecord(
      {
        delete_reason: "retention_expired",
        deleted_at: 1_700_000_010_000,
        project_id: "project_1",
        session_id: "deleted_session",
      },
      { durationRecovery: true },
    );
    expect(deletion.exportId).toBe(
      durationRecoveryDeletionExportId("project_1", "deleted_session"),
    );

    const sql = buildDurationRecoverySql([
      {
        currentDurationMs: 5_000,
        currentHasCheckpoint: null,
        projectId: "project_1",
        recoveredDurationMs: 900,
        recoveredHasCheckpoint: 1,
        sessionId: "session_1",
      },
    ]);
    expect(sql).toContain("SET duration_ms = 900, has_checkpoint = 1");
    expect(sql).toContain("AND duration_ms = 5000");
    expect(sql).toContain("AND has_checkpoint IS NULL");

    const database = new DatabaseSync(":memory:");
    try {
      database.exec(
        "CREATE TABLE sessions (project_id TEXT, session_id TEXT, duration_ms INTEGER, has_checkpoint INTEGER, PRIMARY KEY (project_id, session_id));",
      );
      database
        .prepare(
          "INSERT INTO sessions (project_id, session_id, duration_ms, has_checkpoint) VALUES (?, ?, ?, NULL)",
        )
        .run("project_1", "session_1", 5_000);
      database.exec(sql);
      expect(
        database
          .prepare(
            "SELECT duration_ms, has_checkpoint FROM sessions WHERE project_id = ? AND session_id = ?",
          )
          .get("project_1", "session_1"),
      ).toEqual({ duration_ms: 900, has_checkpoint: 1 });
      database.exec(sql);
      expect(database.prepare("SELECT changes() AS count").get().count).toBe(0);
    } finally {
      database.close();
    }
  });

  it("builds session and sparse event records that the runtime exporter accepts", async () => {
    const eventKinds = ["click", "rage", "error", "nav", "custom", "input", "scroll", "vital"];
    const session = {
      ...sampleSession(),
      activity_hist: "a".repeat(65),
      city: "c".repeat(513),
      entry_url: `https://example.com/${"e".repeat(2_100)}`,
    };
    const records = buildEventOutboxRecords(
      session,
      eventKinds.map((kind, index) => ({
        detail: index === 0 ? "x".repeat(201) : `${kind} detail`,
        kind,
        t: 1_700_000_000_000 + index,
      })),
    );
    const sessionRecord = buildSessionOutboxRecord(session, eventKinds.length);
    const allRecords = [...records, sessionRecord];
    const rows = allRecords.map((record, index) => ({
      attemptCount: 0,
      createdAt: 1_700_000_010_000,
      exportId: record.exportId,
      exportSequence: index + 1,
      lastError: null,
      payloadJson: JSON.stringify(record.payload),
      projectId: record.projectId,
      quarantinedAt: null,
      quarantineReason: null,
      recordKind: record.recordKind,
      sentAt: null,
      sessionId: record.sessionId,
      sidecarEventOffset: 0,
    }));
    const accepted = [];
    const sent = [];
    const quarantined = [];
    const store = {
      async listPending() {
        return rows;
      },
      async canSendRecord() {
        return true;
      },
      async markFailed() {},
      async markQuarantined(sequences) {
        quarantined.push(...sequences);
      },
      async markSent(sequences) {
        sent.push(...sequences);
      },
    };

    const result = await drainAnalyticsExports(
      store,
      {
        async send(runtimeRecords) {
          accepted.push(...runtimeRecords);
        },
      },
      { now: 1_700_000_020_000 },
    );

    expect(result).toMatchObject({
      failed: 0,
      selected: allRecords.length,
      sent: allRecords.length,
    });
    expect(quarantined).toEqual([]);
    expect(sent).toEqual(allRecords.map((_, index) => index + 1));
    expect(accepted.map(({ export_sequence: _exportSequence, ...payload }) => payload)).toEqual(
      allRecords.map((record) => record.payload),
    );
    expect(records[0]?.payload.event_detail).toHaveLength(200);
    expect(sessionRecord.payload.city).toHaveLength(512);
    expect(sessionRecord.payload.entry_url).toHaveLength(2_048);
    expect(sessionRecord.payload.activity_hist).toHaveLength(64);
  });

  it("rejects sparse event values that the runtime exporter cannot accept", () => {
    const session = sampleSession();

    expect(() =>
      buildEventOutboxRecords({ ...session, project_id: "p".repeat(65) }, [
        { detail: null, kind: "error", t: 1 },
      ]),
    ).toThrow("project_id must be 1 to 64");
    expect(() =>
      buildEventOutboxRecords(session, [{ detail: null, kind: "unknown", t: 1 }]),
    ).toThrow('event_kind "unknown" is not supported');
    expect(() =>
      buildEventOutboxRecords(session, [{ detail: null, kind: "error", t: -1 }]),
    ).toThrow("event_time cannot be negative");
  });

  it("rejects session values that the runtime exporter would quarantine", () => {
    const session = sampleSession();

    expect(() => buildSessionOutboxRecord({ ...session, org_id: "" }, 0)).toThrow(
      "org_id must be between 1 and 200",
    );
    expect(
      buildSessionOutboxRecord({ ...session, duration_ms: 4_999 }, 0).payload.duration_ms,
    ).toBe(4_999);
    expect(() => buildSessionOutboxRecord({ ...session, clicks: -1 }, 0)).toThrow(
      "clicks cannot be negative",
    );
    expect(() => buildSessionOutboxRecord({ ...session, max_scroll_depth: 101 }, 0)).toThrow(
      "max_scroll_depth must be between 0 and 100",
    );
    expect(() =>
      buildSessionOutboxRecord({ ...session, expires_at: session.ended_at - 1 }, 0),
    ).toThrow("expires_at cannot be before ended_at");
  });

  it("rechecks deletion and exact default residency inside every outbox insert", () => {
    expect(runGuardedOutboxInsert({ jurisdiction: null })).toBe(1);
    expect(runGuardedOutboxInsert({ deleted: true, jurisdiction: null })).toBe(0);
    expect(runGuardedOutboxInsert({ jurisdiction: "" })).toBe(0);
    expect(runGuardedOutboxInsert({ jurisdiction: "unknown" })).toBe(0);
    expect(runGuardedOutboxInsert({ jurisdiction: "eu" })).toBe(0);
    expect(runGuardedOutboxInsert({ includeProject: false })).toBe(0);
  });

  it("requeues a versioned deletion only while its durable tombstone job still exists", () => {
    expect(runGuardedDeletionOutboxInsert({})).toBe(1);
    expect(runGuardedDeletionOutboxInsert({ includeDeletion: false })).toBe(0);
    expect(runGuardedDeletionOutboxInsert({ includeJob: false })).toBe(0);
    expect(runGuardedDeletionOutboxInsert({ requiresTombstone: false })).toBe(0);
  });

  it("splits 25 maximum-size payloads by actual UTF-8 SQL bytes", () => {
    const records = Array.from({ length: 25 }, (_, index) => maximumSizeRecord(index));
    const batches = buildOutboxInsertBatches(records, 1_700_000_000_000);

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flatMap((batch) => batch.records.map((record) => record.exportId))).toEqual(
      records.map((record) => record.exportId),
    );
    for (const batch of batches) {
      expect(new TextEncoder().encode(batch.sql).byteLength).toBe(batch.sqlBytes);
      expect(batch.sqlBytes).toBeLessThanOrEqual(D1_OUTBOX_INSERT_SQL_MAX_BYTES);
      expect(batch.sqlBytes).toBeLessThan(100_000);
    }
    for (const record of records) {
      expect(new TextEncoder().encode(JSON.stringify(record.payload)).byteLength).toBe(
        ANALYTICS_OUTBOX_PAYLOAD_MAX_BYTES,
      );
    }
  });

  it("rejects an outbox payload over 32 KiB before it reaches D1", () => {
    const record = maximumSizeRecord(1);
    record.payload.padding += "x";

    expect(() => buildOutboxInsertBatches([record], 1_700_000_000_000)).toThrow(
      "is larger than 32 KiB",
    );
  });

  it("splits a 500-session event read with maximum-length ids below the D1 SQL cap", () => {
    const sessions = Array.from({ length: 500 }, (_, index) => ({
      project_id: `p${String(index).padStart(127, "0")}`,
      session_id: `s${String(index).padStart(127, "0")}`,
    }));
    const batches = buildSessionEventsQueries(sessions);

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flatMap((batch) => batch.sessions)).toEqual(sessions);
    for (const batch of batches) {
      expect(new TextEncoder().encode(batch.sql).byteLength).toBe(batch.sqlBytes);
      expect(batch.sqlBytes).toBeLessThanOrEqual(D1_BACKFILL_READ_SQL_MAX_BYTES);
      expect(batch.sqlBytes).toBeLessThan(100_000);
    }
  });

  it("builds a clear per-project backfill completion receipt", () => {
    const sql = buildBackfillCompletionSql({
      activeDeletionCount: 0,
      completedAt: 1_700_000_000_100,
      projectId: "project_1",
      reportId: "report_can't_mix",
      requiredSequence: 44,
      sourceCutoffMs: 1_700_000_000_000,
      sourceSessionCount: 12,
    });

    expect(sql).toContain("INSERT INTO analytics_backfill_completions");
    expect(sql).toContain("source_session_count");
    expect(sql).toContain("source_cutoff_ms");
    expect(sql).toContain("required_sequence");
    expect(sql).toContain("44");
    expect(sql).toContain("report_can''t_mix");
    expect(sql).toContain("completed_at");
    expect(sql).toContain("project.jurisdiction IS NULL");
    expect(sql).toContain("FROM session_deletions deletion");
    expect(sql).toContain("session.ended_at <= 1700000000000");
  });

  it("does not write a completion receipt after a deletion or residency race", () => {
    expect(runGuardedCompletion({})).toBe(1);
    expect(runGuardedCompletion({ deletedAfterReadback: true })).toBe(0);
    expect(runGuardedCompletion({ jurisdictionAfterReadback: "" })).toBe(0);
    expect(runGuardedCompletion({ jurisdictionAfterReadback: "fedramp" })).toBe(0);
    expect(runGuardedCompletion({ removeProjectAfterReadback: true })).toBe(0);
    expect(runGuardedCompletion({ addSourceSessionAfterReadback: true })).toBe(0);
  });

  it("writes completion markers only inside the apply guard", async () => {
    const source = await readFile(path.join(scriptsDirectory, "backfill-analytics.mjs"), "utf8");
    expect(source).toMatch(/if \(options\.apply\) \{\s+writeBackfillCompletions\(/);
  });

  it("fails closed for restricted or missing project residency", () => {
    expect(usesDefaultAnalyticsCatalog(null)).toBe(true);
    expect(usesDefaultAnalyticsCatalog("")).toBe(false);
    expect(usesDefaultAnalyticsCatalog("unknown")).toBe(false);
    expect(usesDefaultAnalyticsCatalog("eu")).toBe(false);
    expect(usesDefaultAnalyticsCatalog("fedramp")).toBe(false);
    expect(usesDefaultAnalyticsCatalog(undefined)).toBe(false);
  });

  it("reports and excludes restricted projects from default-catalog backfill", async () => {
    const source = await readFile(path.join(scriptsDirectory, "backfill-analytics.mjs"), "utf8");
    expect(source).toContain("report.totals.residencySkipped += 1");
    expect(source).toContain("WHERE jurisdiction IS NULL");
    expect(source).toContain("if (!isDefaultCatalogSession(session))");
    expect(source).toContain('activeReport.status = "aborted"');
    expect(source).toContain("concurrentDeletionSkipped");
    expect(source).toContain("concurrentResidencySkipped");
  });

  it("contains no replay decompression path", async () => {
    const source = await readFile(path.join(scriptsDirectory, "backfill-analytics.mjs"), "utf8");
    expect(source).not.toMatch(/DecompressionStream|gunzip|inflateRaw|\.ors/);
  });
});

function runGuardedOutboxInsert({ includeProject = true, jurisdiction, deleted = false }) {
  const database = createGuardDatabase();
  try {
    if (includeProject) {
      database
        .prepare("INSERT INTO projects (id, jurisdiction) VALUES (?, ?)")
        .run("project_1", jurisdiction);
    }
    if (deleted) {
      database
        .prepare("INSERT INTO session_deletions (project_id, session_id) VALUES (?, ?)")
        .run("project_1", "session_1");
    }

    const record = buildSessionOutboxRecord(sampleSession(), 0);
    const sql = buildOutboxInsertSql([record], 1_700_000_010_000);
    if (sql === undefined) throw new Error("Expected one guarded outbox statement.");
    database.exec(sql);
    return database.prepare("SELECT COUNT(*) AS count FROM analytics_export_outbox").get().count;
  } finally {
    database.close();
  }
}

function runGuardedDeletionOutboxInsert({
  includeDeletion = true,
  includeJob = true,
  requiresTombstone = true,
}) {
  const database = createGuardDatabase();
  try {
    if (includeDeletion) {
      database
        .prepare("INSERT INTO session_deletions (project_id, session_id) VALUES (?, ?)")
        .run("project_1", "deleted_session");
    }
    if (includeJob) {
      database
        .prepare(
          "INSERT INTO analytics_deletion_jobs (project_id, session_id, requires_warehouse_tombstone) VALUES (?, ?, ?)",
        )
        .run("project_1", "deleted_session", requiresTombstone ? 1 : 0);
    }
    const record = buildDeletionOutboxRecord(
      {
        delete_reason: "delete_requested",
        deleted_at: 1_700_000_010_000,
        project_id: "project_1",
        session_id: "deleted_session",
      },
      { durationRecovery: true },
    );
    const sql = buildOutboxInsertSql([record], 1_700_000_010_000);
    if (sql === undefined) throw new Error("Expected one guarded deletion outbox statement.");
    database.exec(sql);
    return database.prepare("SELECT COUNT(*) AS count FROM analytics_export_outbox").get().count;
  } finally {
    database.close();
  }
}

function runGuardedCompletion({
  deletedAfterReadback = false,
  jurisdictionAfterReadback,
  removeProjectAfterReadback = false,
  addSourceSessionAfterReadback = false,
}) {
  const database = createGuardDatabase();
  try {
    database.prepare("INSERT INTO projects (id, jurisdiction) VALUES (?, NULL)").run("project_1");
    database
      .prepare("INSERT INTO sessions (project_id, session_id, ended_at) VALUES (?, ?, ?)")
      .run("project_1", "session_1", 1_700_000_005_000);

    if (deletedAfterReadback) {
      database
        .prepare("INSERT INTO session_deletions (project_id, session_id) VALUES (?, ?)")
        .run("project_1", "session_1");
    }
    if (jurisdictionAfterReadback !== undefined) {
      database
        .prepare("UPDATE projects SET jurisdiction = ? WHERE id = ?")
        .run(jurisdictionAfterReadback, "project_1");
    }
    if (removeProjectAfterReadback) {
      database.prepare("DELETE FROM projects WHERE id = ?").run("project_1");
    }
    if (addSourceSessionAfterReadback) {
      database
        .prepare("INSERT INTO sessions (project_id, session_id, ended_at) VALUES (?, ?, ?)")
        .run("project_1", "session_2", 1_700_000_006_000);
    }

    database.exec(
      buildBackfillCompletionSql({
        activeDeletionCount: 0,
        completedAt: 1_700_000_020_000,
        projectId: "project_1",
        reportId: "backfill_guard_test",
        requiredSequence: 1,
        sourceCutoffMs: 1_700_000_010_000,
        sourceSessionCount: 1,
      }),
    );
    return database.prepare("SELECT COUNT(*) AS count FROM analytics_backfill_completions").get()
      .count;
  } finally {
    database.close();
  }
}

function createGuardDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      jurisdiction TEXT
    );
    CREATE TABLE sessions (
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      ended_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, session_id)
    );
    CREATE TABLE session_deletions (
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      PRIMARY KEY (project_id, session_id)
    );
    CREATE TABLE analytics_deletion_jobs (
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      requires_warehouse_tombstone INTEGER NOT NULL,
      PRIMARY KEY (project_id, session_id)
    );
    CREATE TABLE analytics_export_outbox (
      export_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      export_id TEXT NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      record_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE analytics_export_ledger (
      export_id TEXT PRIMARY KEY
    );
    CREATE TABLE analytics_backfill_completions (
      project_id TEXT PRIMARY KEY,
      source_session_count INTEGER NOT NULL,
      source_cutoff_ms INTEGER NOT NULL,
      required_sequence INTEGER NOT NULL,
      report_id TEXT NOT NULL,
      completed_at INTEGER NOT NULL
    );
  `);
  return database;
}

function sampleSession() {
  return {
    activity_hist: null,
    analytics_version: 2,
    browser: "Chrome",
    bytes: 900,
    city: "Delhi",
    clicks: 4,
    country: "IN",
    device: "desktop",
    duration_ms: 5_000,
    ended_at: 1_700_000_005_000,
    entry_url: "https://example.com/it's-here",
    errors: 1,
    expires_at: 1_800_000_000_000,
    flags: 0,
    interaction_time_ms: 2_000,
    manifest_key: "p/project_1/session_1/manifest.json",
    max_scroll_depth: 75,
    navs: 1,
    org_id: "org_1",
    os: "macOS",
    page_count: 2,
    project_id: "project_1",
    quick_backs: 0,
    rages: 0,
    region: "DL",
    segment_count: 1,
    session_id: "session_1",
    started_at: 1_700_000_000_000,
    url_count: 2,
  };
}

function maximumSizeRecord(index) {
  const exportId = `event:project_1:session_${String(index)}:0:1:error`;
  const payload = {
    event_coverage: "sparse",
    event_detail: "failed",
    event_index: 0,
    event_kind: "error",
    event_time: 1,
    export_id: exportId,
    padding: "",
    project_id: "project_1",
    record_kind: "event",
    recorded_at: 1,
    schema_version: 1,
    session_id: `session_${String(index)}`,
  };
  const emptyBytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  payload.padding = "x".repeat(ANALYTICS_OUTBOX_PAYLOAD_MAX_BYTES - emptyBytes);
  return {
    exportId,
    payload,
    projectId: payload.project_id,
    recordKind: payload.record_kind,
    sessionId: payload.session_id,
  };
}
