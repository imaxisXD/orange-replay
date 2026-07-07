import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "framer-motion";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { IconProvider } from "@/lib/icon-context";
import { queryClient } from "@/lib/query";
import { ShapeProvider } from "@/lib/shape-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import { router } from "@/router";
import "@/index.css";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("Dashboard root element was not found.");
}

createRoot(root).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <QueryClientProvider client={queryClient}>
        <ShapeProvider defaultShape="rounded">
          <IconProvider defaultLibrary="lucide">
            <TooltipProvider>
              <RouterProvider router={router} />
            </TooltipProvider>
          </IconProvider>
        </ShapeProvider>
      </QueryClientProvider>
    </MotionConfig>
  </StrictMode>,
);
