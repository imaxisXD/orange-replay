"use client";

import { createContext, useContext } from "react";

export const SurfaceContext = createContext<number>(1);

export function useSurface(): number {
  return useContext(SurfaceContext);
}
