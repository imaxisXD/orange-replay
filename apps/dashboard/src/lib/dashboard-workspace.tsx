import { createContext, use, type ReactNode } from "react";

interface DashboardWorkspace {
  projectId: string;
  isDemo: boolean;
}

const DashboardWorkspaceContext = createContext<DashboardWorkspace | null>(null);

export function DashboardWorkspaceProvider({
  children,
  isDemo,
  projectId,
}: {
  children: ReactNode;
  isDemo: boolean;
  projectId: string;
}) {
  return (
    <DashboardWorkspaceContext.Provider value={{ projectId, isDemo }}>
      {children}
    </DashboardWorkspaceContext.Provider>
  );
}

export function DemoWorkspaceProvider({
  children,
  projectId,
}: {
  children: ReactNode;
  projectId: string;
}) {
  return (
    <DashboardWorkspaceProvider isDemo projectId={projectId}>
      {children}
    </DashboardWorkspaceProvider>
  );
}

export function useDashboardWorkspace(): DashboardWorkspace {
  const context = use(DashboardWorkspaceContext);
  if (context === null) {
    throw new Error("Dashboard workspace is missing its provider.");
  }
  return context;
}
