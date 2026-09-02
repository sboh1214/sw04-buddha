'use client';

import { ChakraProvider } from '@chakra-ui/react';
import { ColorModeProvider, type ColorModeProviderProps } from './color-mode';
import { EmotionRegistry } from './emotion-registry';
import { system } from '@/theme/system';

/**
 * App-wide providers. EmotionRegistry is required with Turbopack (Next 16 default):
 * without it, Emotion's inline <style> tags cause a hydration mismatch (React #418).
 */
export function Provider(props: ColorModeProviderProps) {
  return (
    <EmotionRegistry>
      <ChakraProvider value={system}>
        <ColorModeProvider {...props} />
      </ChakraProvider>
    </EmotionRegistry>
  );
}
