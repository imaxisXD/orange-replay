import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { MotionProvider } from "@/lib/motion-provider";
import { queryClient } from "@/lib/query";
import { ShapeProvider } from "@/lib/shape-context";
import { OrangeToastProvider } from "@/components/ui/orange-toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { router } from "@/router";
import "@/index.css";

const root = document.getElementById("root");

if (root === null) {
  throw new Error("Dashboard root element was not found.");
}

createRoot(root).render(
  <StrictMode>
    <MotionProvider>
      <QueryClientProvider client={queryClient}>
        <ShapeProvider defaultShape="rounded">
          <OrangeToastProvider>
            <TooltipProvider>
              <RouterProvider router={router} />
            </TooltipProvider>
          </OrangeToastProvider>
        </ShapeProvider>
      </QueryClientProvider>
    </MotionProvider>
  </StrictMode>,
);
