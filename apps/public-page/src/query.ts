import { PUBLIC_PAGE_REFRESH_MS, type PublicPageData } from "@orange-replay/shared";
import { QueryClient, queryOptions } from "@tanstack/react-query";

export function makePublicPageQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: PUBLIC_PAGE_REFRESH_MS,
        retry: 1,
        refetchOnWindowFocus: true,
      },
    },
  });
}

export function publicPageQueryOptions(publicId: string) {
  return queryOptions({
    queryKey: ["public-page", publicId] as const,
    queryFn: ({ signal }) => fetchPublicPage(publicId, signal),
    staleTime: PUBLIC_PAGE_REFRESH_MS,
    refetchInterval: PUBLIC_PAGE_REFRESH_MS,
    refetchIntervalInBackground: false,
  });
}

async function fetchPublicPage(publicId: string, signal: AbortSignal): Promise<PublicPageData> {
  const response = await fetch(`/api/v1/public-pages/${encodeURIComponent(publicId)}`, {
    cache: "no-store",
    signal,
  });
  if (!response.ok) throw new Error("This public page is no longer available.");
  return (await response.json()) as PublicPageData;
}
