import { QueryClient, isServer } from '@tanstack/react-query';
import { isApiError } from './api';

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Do not refetch immediately on mount; sockets (M4) update caches via setQueryData.
        staleTime: 30 * 1000,
        retry: (failureCount, error) => {
          // 4xx never fixes itself by retrying (401 in particular must fail fast).
          if (isApiError(error) && error.status < 500) return false;
          return failureCount < 2;
        },
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

/**
 * TanStack Query SSR pattern: a fresh client per server request, one lazily created
 * singleton in the browser (so React suspending during the first render cannot discard it).
 */
export function getQueryClient(): QueryClient {
  if (isServer) return makeQueryClient();
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}
