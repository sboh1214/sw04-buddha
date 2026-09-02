'use client';

import type { ButtonProps } from '@chakra-ui/react';
import { Button, ClientOnly, Skeleton } from '@chakra-ui/react';
import { ThemeProvider, useTheme } from 'next-themes';
import type { ThemeProviderProps } from 'next-themes';
import { copy } from '@/copy';

export type ColorModeProviderProps = ThemeProviderProps;

export function ColorModeProvider(props: ColorModeProviderProps) {
  return <ThemeProvider attribute="class" disableTransitionOnChange {...props} />;
}

export type ColorMode = 'light' | 'dark';

export function useColorMode() {
  const { resolvedTheme, setTheme, forcedTheme } = useTheme();
  const colorMode = (forcedTheme ?? resolvedTheme) as ColorMode;
  const toggleColorMode = () => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark');
  return { colorMode, setColorMode: setTheme as (mode: ColorMode) => void, toggleColorMode };
}

export function useColorModeValue<T>(light: T, dark: T) {
  const { colorMode } = useColorMode();
  return colorMode === 'dark' ? dark : light;
}

/** Light/dark toggle. Client-only because the resolved theme is unknown during SSR. */
export function ColorModeButton(props: ButtonProps) {
  const { colorMode, toggleColorMode } = useColorMode();
  return (
    <ClientOnly fallback={<Skeleton width="24" height="9" />}>
      <Button variant="outline" size="sm" onClick={toggleColorMode} {...props}>
        {colorMode === 'dark' ? copy.lightMode : copy.darkMode}
      </Button>
    </ClientOnly>
  );
}
