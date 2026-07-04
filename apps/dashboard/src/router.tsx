import { createBrowserRouter, Navigate } from "react-router";
import { AppShell } from "@/routes/app-shell";
import { LoginPage } from "@/routes/login";
import { RequireAuth } from "@/routes/require-auth";
import { RouteError } from "@/routes/route-error";
import { SessionDetailPage } from "@/routes/session-detail";
import { SessionsPage } from "@/routes/sessions";
import { SettingsPage } from "@/routes/settings";

export const defaultProjectId = "p1";

export const router = createBrowserRouter([
  {
    path: "/login",
    element: <LoginPage />,
  },
  {
    path: "/",
    element: <Navigate to={`/projects/${defaultProjectId}/sessions`} replace />,
  },
  {
    path: "/projects/:projectId",
    element: (
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    ),
    errorElement: <RouteError />,
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
        path: "settings",
        element: <SettingsPage />,
      },
    ],
  },
]);
