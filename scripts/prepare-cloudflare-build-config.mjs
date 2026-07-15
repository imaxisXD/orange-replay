#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  readAnalyticsDeletionReadVersion,
  requireDistinctAnalyticsStreamIds,
} from "./analytics/deletion-v2-config.mjs";
import { readAnalyticsDeployMode } from "./analytics/deploy-mode.mjs";
import { readPrivateRegularFile, writePrivateFileAtomically } from "./private-file.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceConfig = path.join(repoRoot, "apps", "worker", "wrangler.jsonc");
const buildConfig = path.join(repoRoot, "apps", "worker", "wrangler.cloudflare-build.jsonc");
const primaryAnalyticsStreamReplacement = {
  envName: "ORANGE_REPLAY_PROD_ANALYTICS_STREAM_ID",
  placeholder: "REPLACE_WITH_PRODUCTION_ANALYTICS_STREAM_ID",
  pattern: /^[A-Za-z0-9_-]{1,200}$/,
  label: "production analytics stream id",
};
const deletionV2StreamReplacement = {
  envName: "ORANGE_REPLAY_PROD_ANALYTICS_DELETION_V2_STREAM_ID",
  placeholder: "REPLACE_WITH_PRODUCTION_ANALYTICS_DELETION_V2_STREAM_ID",
  pattern: /^[A-Za-z0-9_-]{1,200}$/,
  label: "production analytics deletion v2 stream id",
};
const resourceReplacements = [
  {
    envName: "ORANGE_REPLAY_PROD_KV_ID",
    placeholder: "REPLACE_WITH_PRODUCTION_KV_ID",
    pattern: /^[a-f0-9]{32}$/i,
    label: "production KV namespace id",
  },
  {
    envName: "ORANGE_REPLAY_PROD_D1_ID",
    placeholder: "REPLACE_WITH_PRODUCTION_D1_ID",
    pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    label: "production D1 database id",
  },
  {
    envName: "CLOUDFLARE_ACCOUNT_ID",
    placeholder: "REPLACE_WITH_PRODUCTION_ACCOUNT_ID",
    pattern: /^[a-f0-9]{32}$/i,
    label: "Cloudflare account id",
  },
  primaryAnalyticsStreamReplacement,
  deletionV2StreamReplacement,
];

export async function prepareCloudflareBuildConfig({
  environment = process.env,
  sourceConfigPath = sourceConfig,
  buildConfigPath = buildConfig,
} = {}) {
  let config = await readPrivateRegularFile(sourceConfigPath);
  const analyticsMode = readAnalyticsDeployMode(environment);
  const publicPage = readPublicPageConfig(environment);
  const replacements = [
    ...resourceReplacements,
    {
      envName: "ORANGE_REPLAY_PROD_PUBLIC_PAGE_ORIGIN",
      placeholder: "https://public-page-origin.invalid",
      value: publicPage.origin,
    },
    {
      envName: "ORANGE_REPLAY_PROD_PUBLIC_PAGE_ORIGIN",
      placeholder: "public-page-origin.invalid",
      value: publicPage.hostname,
    },
  ];

  requireDistinctAnalyticsStreamIds(
    readBuildValue(primaryAnalyticsStreamReplacement, environment),
    readBuildValue(deletionV2StreamReplacement, environment),
  );

  for (const replacement of replacements) {
    const value = readBuildValue(replacement, environment);
    if (!config.includes(replacement.placeholder)) {
      throw new Error(`${replacement.placeholder} was not found in apps/worker/wrangler.jsonc.`);
    }
    config = config.replaceAll(replacement.placeholder, value);
  }

  const analyticsBackendPlaceholder = "REPLACE_WITH_PRODUCTION_ANALYTICS_READ_BACKEND";
  if (!config.includes(analyticsBackendPlaceholder)) {
    throw new Error(`${analyticsBackendPlaceholder} was not found in apps/worker/wrangler.jsonc.`);
  }
  config = config.replaceAll(analyticsBackendPlaceholder, analyticsMode.backend);

  const deletionReadVersionPlaceholder = "REPLACE_WITH_PRODUCTION_ANALYTICS_DELETION_READ_VERSION";
  if (!config.includes(deletionReadVersionPlaceholder)) {
    throw new Error(
      `${deletionReadVersionPlaceholder} was not found in apps/worker/wrangler.jsonc.`,
    );
  }
  config = config.replaceAll(
    deletionReadVersionPlaceholder,
    readAnalyticsDeletionReadVersion(environment),
  );

  await writePrivateFileAtomically(buildConfigPath, config);
}

function readBuildValue({ envName, pattern, label, value: preparedValue }, environment) {
  if (preparedValue !== undefined) return preparedValue;
  const value = environment[envName]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${envName} is required for the ${label}.`);
  }
  if (!pattern.test(value)) {
    throw new Error(`${envName} is not a valid ${label}.`);
  }
  return value;
}

function readPublicPageConfig(environment) {
  const envName = "ORANGE_REPLAY_PROD_PUBLIC_PAGE_ORIGIN";
  const value = environment[envName]?.trim();
  if (!value) {
    throw new Error(`${envName} is required for the public page address.`);
  }

  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== "" ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.hostname.length === 0
    ) {
      throw new Error("invalid public page address");
    }
    return { origin: url.origin, hostname: url.hostname };
  } catch {
    throw new Error(
      `${envName} must be one HTTPS origin without a path, port, query, or fragment.`,
    );
  }
}

const entryPath = process.argv[1];
if (
  typeof entryPath === "string" &&
  import.meta.url === pathToFileURL(path.resolve(entryPath)).href
) {
  try {
    await prepareCloudflareBuildConfig();
    console.log("Cloudflare build Wrangler config generated.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
