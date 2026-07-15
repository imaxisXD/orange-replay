export function readAnalyticsDeletionReadVersion(environment = process.env) {
  const envName = "ORANGE_REPLAY_PROD_ANALYTICS_DELETION_READ_VERSION";
  const value = environment[envName]?.trim() || "v1";
  if (value !== "v1" && value !== "v2") {
    throw new Error(`${envName} must be v1 or v2.`);
  }
  return value;
}

export function requireDistinctAnalyticsStreamIds(primaryStreamId, deletionV2StreamId) {
  if (primaryStreamId === deletionV2StreamId) {
    throw new Error(
      "ORANGE_REPLAY_PROD_ANALYTICS_DELETION_V2_STREAM_ID must be different from ORANGE_REPLAY_PROD_ANALYTICS_STREAM_ID.",
    );
  }
}
