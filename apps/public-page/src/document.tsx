import type { PublicPageData } from "@orange-replay/shared";
import { HydrationBoundary, type DehydratedState } from "@tanstack/react-query";
import { PublicPageApp, type PublicReplayPlayerComponent } from "./public-page-app.tsx";

export interface PublicPageBootstrap {
  publicId: string;
  publicUrl: string;
  projectName: string;
  dehydratedState: DehydratedState;
}

interface PublicPageDocumentProperties {
  bootstrap: PublicPageBootstrap;
  replayPlayer?: PublicReplayPlayerComponent;
}

export function PublicPageDocument({ bootstrap, replayPlayer }: PublicPageDocumentProperties) {
  const title = `${bootstrap.projectName} analytics | Orange Replay`;
  const description = `Public product analytics and selected session recordings for ${bootstrap.projectName}.`;
  const bootstrapJson = escapeJsonForHtml(JSON.stringify(bootstrap));

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="index, follow" />
        <meta name="description" content={description} />
        <meta name="theme-color" content="#0a0a0c" />
        <meta property="og:type" content="website" />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={description} />
        <meta property="og:url" content={bootstrap.publicUrl} />
        <link rel="canonical" href={bootstrap.publicUrl} />
        <link rel="stylesheet" href="/public/public-page.css" />
        <title>{title}</title>
      </head>
      <body>
        <HydrationBoundary state={bootstrap.dehydratedState}>
          <PublicPageApp publicId={bootstrap.publicId} replayPlayer={replayPlayer} />
        </HydrationBoundary>
        <script
          id="public-page-data"
          type="application/json"
          dangerouslySetInnerHTML={{ __html: bootstrapJson }}
        />
        <script type="module" src="/public/public-page.js" />
      </body>
    </html>
  );
}

export function makePublicPageBootstrap(
  data: PublicPageData,
  dehydratedState: DehydratedState,
): PublicPageBootstrap {
  return {
    publicId: data.publicId,
    publicUrl: data.publicUrl,
    projectName: data.projectName,
    dehydratedState,
  };
}

export function escapeJsonForHtml(value: string): string {
  return value
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}
