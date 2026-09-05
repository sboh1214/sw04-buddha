import { Container, Heading, HStack, Stack, Link as ChakraLink } from '@chakra-ui/react';
import type { Metadata, Route } from 'next';
import NextLink from 'next/link';
import { redirect } from 'next/navigation';
import { copy } from '@/copy';
import { getServerRole, getServerSession } from '@/lib/session.server';

export const metadata: Metadata = { title: `${copy.adminTitle} | ${copy.appName}` };

/**
 * PLAN 12: everything under /admin is admin-only. The check runs on the server so a member
 * never receives the page at all; the API enforces the same rule on every call (AdminGuard).
 * M2 ships the users screen only — markets, disputes and settlement arrive with M3.
 */
/** Next 16 types `href`, so the list is declared as routes rather than plain strings. */
const NAV: { href: Route; label: string }[] = [
  { href: '/admin/users', label: copy.adminUsers },
  { href: '/admin/charge-packages', label: copy.adminPackages },
  { href: '/admin/coupons', label: copy.adminCoupons },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  if (!(await getServerSession())) redirect('/login?next=/admin/users');
  if ((await getServerRole()) !== 'admin') redirect('/');

  return (
    <Container maxW="4xl" py={{ base: '6', md: '10' }}>
      <Stack gap="6">
        <HStack justify="space-between" align="baseline">
          <Heading as="h2" size="2xl">
            {copy.adminTitle}
          </Heading>
          <HStack gap="4">
            {NAV.map((item) => (
              <ChakraLink
                key={item.href}
                asChild
                colorPalette="brand"
                color="colorPalette.fg"
                fontWeight="medium"
              >
                <NextLink href={item.href}>{item.label}</NextLink>
              </ChakraLink>
            ))}
          </HStack>
        </HStack>
        {children}
      </Stack>
    </Container>
  );
}
