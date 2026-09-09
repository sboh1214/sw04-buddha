'use client';

import { ChakraProvider } from '@chakra-ui/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { ColorModeProvider, type ColorModeProviderProps } from './color-mode';
import { EmotionRegistry } from './emotion-registry';
import { Toaster } from './toaster';
import { SessionCacheGuard } from '@/components/auth/session-cache-guard';
import { RealtimeProvider } from '@/components/realtime/realtime-provider';
import { getQueryClient } from '@/lib/query-client';
import { system } from '@/theme/system';

/**
 * App-wide providers. EmotionRegistry is required with Turbopack (Next 16 default):
 * without it, Emotion's inline <style> tags cause a hydration mismatch (React #418).
 * The QueryClient comes from getQueryClient() (per request on the server, singleton in
 * the browser) rather than useState so a suspending first render cannot recreate it.
 *
 * SessionCacheGuard stays a SIBLING that renders first, so its resetQueries runs before
 * RealtimeProvider's new handshake: an account switch empties the cache and only then does
 * the socket start writing into it. Both are idempotent, and both need the QueryClient, so
 * neither can move above QueryClientProvider.
 */
export function Provider(props: ColorModeProviderProps) {
  const queryClient = getQueryClient();
  return (
    <EmotionRegistry>
      <ChakraProvider value={system}>
        <QueryClientProvider client={queryClient}>
          <SessionCacheGuard />
          <RealtimeProvider>
            <ColorModeProvider {...props} />
          </RealtimeProvider>
          <Toaster />
        </QueryClientProvider>
      </ChakraProvider>
    </EmotionRegistry>
  );
}
