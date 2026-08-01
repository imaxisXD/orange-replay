const analyticsOnlySecrets = new Set(["R2_SQL_TOKEN", "ANALYTICS_PURGE_RUNNER_TOKEN"]);
const requiredSecretsBlockPattern =
  /^(?<indent>[ \t]*)"secrets"\s*:\s*\{\s*"required"\s*:\s*\[(?<body>[\s\S]*?)\]\s*,?\s*\}\s*,?[ \t]*(?:\r?\n|$)/m;

export function withoutAnalyticsSecretRequirement(config) {
  if (!config.includes('"ANALYTICS_READ_BACKEND": "d1"')) {
    throw new Error("Emergency rollback config must use the D1 analytics backend.");
  }
  const requiredSecretsBlock = requiredSecretsBlockPattern.exec(config);
  if (!requiredSecretsBlock?.groups) {
    throw new Error("Emergency rollback could not find the exact analytics secret requirement.");
  }

  const requiredSecretsBody = requiredSecretsBlock.groups.body;
  const invalidListContent = requiredSecretsBody
    .replaceAll(/"[^"]+"/g, "")
    .replaceAll(/[\s,]/g, "");
  const requiredSecretNames = [...requiredSecretsBody.matchAll(/"([^"]+)"/g)].map(
    (match) => match[1],
  );
  const hasEachAnalyticsSecretOnce = [...analyticsOnlySecrets].every(
    (secretName) => requiredSecretNames.filter((name) => name === secretName).length === 1,
  );
  if (invalidListContent !== "" || !hasEachAnalyticsSecretOnce) {
    throw new Error("Emergency rollback could not find the exact analytics secret requirement.");
  }

  const remainingSecrets = requiredSecretNames.filter(
    (secretName) => !analyticsOnlySecrets.has(secretName),
  );
  if (remainingSecrets.length === 0) {
    return config.replace(requiredSecretsBlock[0], "");
  }

  const newline = requiredSecretsBody.includes("\r\n") ? "\r\n" : "\n";
  const itemIndent =
    requiredSecretsBody.match(/\r?\n([ \t]*)"/)?.[1] ?? `${requiredSecretsBlock.groups.indent}  `;
  const closingIndent =
    requiredSecretsBody.match(/\r?\n([ \t]*)$/)?.[1] ?? requiredSecretsBlock.groups.indent;
  const trailingComma = /,\s*$/.test(requiredSecretsBody) ? "," : "";
  const rebuiltBody = `${newline}${remainingSecrets
    .map((secretName) => `${itemIndent}"${secretName}"`)
    .join(`,${newline}`)}${trailingComma}${newline}${closingIndent}`;
  const rebuiltBlock = requiredSecretsBlock[0].replace(requiredSecretsBody, rebuiltBody);
  return config.replace(requiredSecretsBlock[0], rebuiltBlock);
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
