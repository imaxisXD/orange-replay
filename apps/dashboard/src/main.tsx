import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { IconProvider } from "@/lib/icon-context";
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
    <ShapeProvider defaultShape="rounded">
      <IconProvider defaultLibrary="lucide">
        <TooltipProvider>
          <RouterProvider router={router} />
        </TooltipProvider>
      </IconProvider>
    </ShapeProvider>
  </StrictMode>,
);
