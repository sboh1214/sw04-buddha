'use client';

import { ClientOnly, HStack, Skeleton, Switch, Text } from '@chakra-ui/react';
import { useColorMode } from '@/components/ui/color-mode';
import { copy } from '@/copy';
import { SettingsSection } from './section';

/** Light/dark toggle (next-themes). ClientOnly: the resolved theme is unknown during SSR. */
export function ThemeSection() {
  return (
    <SettingsSection
      title={copy.settingsTheme}
      hint={copy.settingsThemeHint}
      testId="settings-theme"
    >
      <ClientOnly fallback={<Skeleton height="6" width="40" />}>
        <ThemeSwitch />
      </ClientOnly>
    </SettingsSection>
  );
}

function ThemeSwitch() {
  const { colorMode, setColorMode } = useColorMode();
  return (
    <Switch.Root
      checked={colorMode === 'dark'}
      onCheckedChange={(e) => setColorMode(e.checked ? 'dark' : 'light')}
      colorPalette="brand"
    >
      <Switch.HiddenInput />
      <Switch.Control />
      <Switch.Label>
        <HStack gap="2">
          <Text>{copy.darkMode}</Text>
        </HStack>
      </Switch.Label>
    </Switch.Root>
  );
}
