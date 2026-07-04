import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { getApiToken } from "@/lib/api";

export function RequireAuth({ children }: { children: ReactNode }) {
  const location = useLocation();

  if (getApiToken() === null) {
    return <Navigate to="/login" replace state={{ returnTo: location.pathname }} />;
  }

  return children;
}
