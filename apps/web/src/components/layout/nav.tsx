import { Box, Container, HStack, Heading } from '@chakra-ui/react';
import NextLink from 'next/link';
import { AuthButtons } from '@/components/auth/auth-buttons';
import { ColorModeButton } from '@/components/ui/color-mode';
import { copy } from '@/copy';

/** Top navigation (PLAN 11.4). Search / categories / mobile bottom tabs arrive in M4. */
export function Nav() {
  return (
    <Box as="header" borderBottomWidth="1px" bg="bg" position="sticky" top="0" zIndex="sticky">
      <Container maxW="6xl" py="3">
        <HStack justify="space-between">
          <Heading as="h1" size="lg" letterSpacing="tight">
            <NextLink href="/">{copy.appName}</NextLink>
          </Heading>
          <HStack gap="2">
            <ColorModeButton display={{ base: 'none', md: 'inline-flex' }} />
            <AuthButtons />
          </HStack>
        </HStack>
      </Container>
    </Box>
  );
}
