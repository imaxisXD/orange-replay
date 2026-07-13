export function getDashboardEnvironmentLabel(
  isDemo: boolean,
  dashboardEnvironment: string | undefined,
): string {
  if (isDemo) return "Demo";
  return dashboardEnvironment === "production" ? "Production" : "Local dev";
}
