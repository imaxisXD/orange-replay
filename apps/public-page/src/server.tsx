import type { PublicPageData } from "@orange-replay/shared";
import { dehydrate, QueryClientProvider } from "@tanstack/react-query";
import { renderToReadableStream } from "react-dom/server";
import { makePublicPageBootstrap, PublicPageDocument } from "./document.tsx";
import { makePublicPageQueryClient, publicPageQueryOptions } from "./query.ts";

export async function renderPublicPage(data: PublicPageData): Promise<ReadableStream<Uint8Array>> {
  const queryClient = makePublicPageQueryClient();
  queryClient.setQueryData(publicPageQueryOptions(data.publicId).queryKey, data);
  const bootstrap = makePublicPageBootstrap(data, dehydrate(queryClient));

  const stream = await renderToReadableStream(
    <QueryClientProvider client={queryClient}>
      <PublicPageDocument bootstrap={bootstrap} />
    </QueryClientProvider>,
  );
  await stream.allReady;
  return stream;
}
