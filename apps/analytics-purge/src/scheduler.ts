import { setWideEventVersion, startWideEvent, uuidv7 } from "@orange-replay/shared";

const CONTAINER_ENVIRONMENT_NAMES = [
  "ORANGE_REPLAY_PURGE_API_URL",
  "ANALYTICS_PURGE_RUNNER_TOKEN",
  "R2_CATALOG_URI",
  "R2_SQL_WAREHOUSE",
  "ORANGE_REPLAY_CATALOG_TOKEN",
] as const;

type ContainerEnvironmentName = (typeof CONTAINER_ENVIRONMENT_NAMES)[number];

export type SchedulerEnvironment = Pick<Env, ContainerEnvironmentName | "CF_VERSION_METADATA">;

export interface PurgeContainerStarter {
  start(options: {
    envVars: Record<ContainerEnvironmentName, string>;
    enableInternet: boolean;
    labels: Record<string, string>;
  }): Promise<void>;
}

export function buildContainerEnvironment(
  env: SchedulerEnvironment,
): Record<ContainerEnvironmentName, string> {
  const values = {} as Record<ContainerEnvironmentName, string>;
  for (const name of CONTAINER_ENVIRONMENT_NAMES) {
    const value = env[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`${name} is required`);
    }
    values[name] = value;
  }
  return values;
}

export function redactedContainerError(error: unknown, env: SchedulerEnvironment): Error {
  let message = error instanceof Error ? error.message : String(error);
  for (const name of CONTAINER_ENVIRONMENT_NAMES) {
    const value = env[name];
    if (typeof value === "string" && value.length > 0) {
      message = message.replaceAll(value, "[hidden]");
    }
  }
  return new Error(message.slice(0, 500));
}

export async function startScheduledPurge(
  env: SchedulerEnvironment,
  cron: string,
  container: PurgeContainerStarter,
): Promise<void> {
  setWideEventVersion(env.CF_VERSION_METADATA?.tag ?? env.CF_VERSION_METADATA?.id);
  const event = startWideEvent("analytics-purge", "container.start", uuidv7());
  try {
    await container.start({
      envVars: buildContainerEnvironment(env),
      enableInternet: true,
      labels: {
        service: "analytics-purge",
      },
    });
    event.set({ cron, start_requested: true });
  } catch (error) {
    const safeError = redactedContainerError(error, env);
    event.fail(safeError);
    throw safeError;
  } finally {
    event.emit();
  }
}
