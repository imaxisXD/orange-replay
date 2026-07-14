import { QueryClientProvider } from "@tanstack/react-query";
import { lazy } from "react";
import { hydrateRoot } from "react-dom/client";
import { PublicPageDocument, type PublicPageBootstrap } from "./document.tsx";
import { makePublicPageQueryClient } from "./query.ts";
import "./styles.css";

const ReplayPlayer = lazy(() => import("./replay-player.tsx"));

const dataElement = document.querySelector<HTMLScriptElement>("#public-page-data");
const bootstrap = readBootstrap(dataElement?.textContent);

if (bootstrap !== null) {
  const queryClient = makePublicPageQueryClient();
  hydrateRoot(
    document,
    <QueryClientProvider client={queryClient}>
      <PublicPageDocument bootstrap={bootstrap} replayPlayer={ReplayPlayer} />
    </QueryClientProvider>,
  );
}

function readBootstrap(value: string | null | undefined): PublicPageBootstrap | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<PublicPageBootstrap>;
    if (
      typeof parsed.publicId !== "string" ||
      typeof parsed.publicUrl !== "string" ||
      typeof parsed.projectName !== "string" ||
      typeof parsed.dehydratedState !== "object" ||
      parsed.dehydratedState === null
    ) {
      return null;
    }
    return parsed as PublicPageBootstrap;
  } catch {
    return null;
  }
}
