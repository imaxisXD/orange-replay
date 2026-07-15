"use client";

import type { ReactNode } from "react";
import { SurfaceContext } from "./surface-context-value";

export function SurfaceProvider({ value, children }: { value: number; children: ReactNode }) {
  return (
    <SurfaceContext.Provider value={Math.max(1, Math.min(8, value))}>
      {children}
    </SurfaceContext.Provider>
  );
}
