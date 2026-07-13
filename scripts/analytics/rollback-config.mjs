const requiredSecretsBlock = `      "secrets": {
        "required": ["R2_SQL_TOKEN", "ANALYTICS_PURGE_RUNNER_TOKEN"],
      },
`;

export function withoutAnalyticsSecretRequirement(config) {
  if (!config.includes('"ANALYTICS_READ_BACKEND": "d1"')) {
    throw new Error("Emergency rollback config must use the D1 analytics backend.");
  }
  if (config.split(requiredSecretsBlock).length !== 2) {
    throw new Error("Emergency rollback could not find the exact analytics secret requirement.");
  }
  return config.replace(requiredSecretsBlock, "");
}

export function buildD1FallbackConfig(config, currentBackend) {
  if (!new Set(["d1", "compare", "r2_sql"]).has(currentBackend)) {
    throw new Error("The D1 fallback config needs a known analytics backend.");
  }

  const currentLine = `        "ANALYTICS_READ_BACKEND": "${currentBackend}",`;
  if (config.split(currentLine).length !== 2) {
    throw new Error("The D1 fallback config could not find the production analytics backend.");
  }
  const d1Config = config.replace(currentLine, '        "ANALYTICS_READ_BACKEND": "d1",');
  return withoutAnalyticsSecretRequirement(d1Config);
}
