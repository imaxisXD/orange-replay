import { createBrowserRouter, Navigate } from "react-router";
import type { ReactNode } from "react";
import { AppShell } from "@/routes/app-shell";
import { InstallPage } from "@/routes/install";
import { LoginPage } from "@/routes/login";
import { LivePage } from "@/routes/live";
import { RequireAuth } from "@/routes/require-auth";
import { RouteError } from "@/routes/route-error";
import { SessionDetailPage } from "@/routes/session-detail";
import { SessionsPage } from "@/routes/sessions";
import { SettingsPage } from "@/routes/settings";

export const defaultProjectId = "p1";

function shellElement(element?: ReactNode) {
  return (
    <RequireAuth>
      <AppShell>{element}</AppShell>
    </RequireAuth>
  );
}

export const router = createBrowserRouter([
  {
    path: "/login",
    element: <LoginPage />,
    errorElement: (
      <AppShell>
        <RouteError />
      </AppShell>
    ),
  },
  {
    path: "/",
    errorElement: shellElement(<RouteError />),
    children: [
      {
        index: true,
        element: <Navigate to={`/projects/${defaultProjectId}/sessions`} replace />,
      },
      {
        path: "projects/:projectId",
        element: shellElement(),
        errorElement: shellElement(<RouteError />),
        children: [
          {
            index: true,
            element: <Navigate to="sessions" replace />,
          },
          {
            path: "sessions",
            element: <SessionsPage />,
          },
          {
            path: "sessions/:sessionId",
            element: <SessionDetailPage />,
          },
          {
            path: "live",
            element: <LivePage />,
          },
          {
            path: "settings",
            element: <SettingsPage />,
          },
          {
            path: "install",
            element: <InstallPage />,
          },
          {
            path: "*",
            element: <RouteError notFound />,
          },
        ],
      },
      {
        path: "*",
        element: shellElement(<RouteError notFound />),
      },
    ],
  },
]);
