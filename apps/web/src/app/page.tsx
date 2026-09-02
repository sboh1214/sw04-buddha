import { Container, Heading, HStack, Stack, Text } from '@chakra-ui/react';
import { formatP } from '@buddha/shared';
import { ColorModeButton } from '@/components/ui/color-mode';
import { copy } from '@/copy';

// Placeholder home page (M0). The market list arrives in M4.
export default function HomePage() {
  return (
    <Container maxW="4xl" py="12">
      <Stack gap="6">
        <HStack justify="space-between">
          <Heading as="h1" size="2xl">
            {copy.appName}
          </Heading>
          <ColorModeButton />
        </HStack>
        <Text color="fg.muted">
          {copy.predict} {copy.comingSoon}
        </Text>
        <HStack gap="3">
          <Text fontWeight="semibold" colorPalette="yes" color="colorPalette.fg">
            {copy.yes} 63%
          </Text>
          <Text fontWeight="semibold" colorPalette="no" color="colorPalette.fg">
            {copy.no} 37%
          </Text>
          <Text>{formatP(12345n)}</Text>
        </HStack>
        <Text fontSize="sm" color="fg.subtle">
          {copy.walletNotice}
        </Text>
      </Stack>
    </Container>
  );
}
