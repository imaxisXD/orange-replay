import {
  decodePublicPageData,
  PUBLIC_PAGE_REFRESH_MS,
  type PublicPageData,
} from "@orange-replay/shared";
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
  let response: Response;
  try {
    response = await fetch(`/api/v1/public-pages/${encodeURIComponent(publicId)}`, {
      cache: "no-store",
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error(
      "This public page is temporarily unavailable. Check your connection and try again.",
    );
  }
  if (!response.ok) throw new Error(publicPageErrorMessage(response.status));
  try {
    const data = decodePublicPageData(await response.json());
    if (data.publicId !== publicId) throw new Error("public page id does not match the request");
    return data;
  } catch {
    throw new Error("This public page is temporarily unavailable. Refresh the page and try again.");
  }
}

export function publicPageErrorMessage(status: number): string {
  if (status === 404) return "This public page is no longer available. Check the address.";
  if (status === 429) return "Too many requests. Wait, then refresh the page.";
  return "This public page is temporarily unavailable. Refresh the page and try again.";
}
