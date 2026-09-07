import { Container, Heading, HStack, Stack, Link as ChakraLink } from '@chakra-ui/react';
import type { Metadata, Route } from 'next';
import { headers } from 'next/headers';
import NextLink from 'next/link';
import { redirect } from 'next/navigation';
import { copy } from '@/copy';
import { adminLoginPath } from '@/lib/next-path';
import { getServerRole, getServerSession } from '@/lib/session.server';
import { X_PATHNAME } from '@/proxy';

export const metadata: Metadata = { title: `${copy.adminTitle} | ${copy.appName}` };

/**
 * PLAN 12: everything under /admin is admin-only. The check runs on the server so a member
 * never receives the page at all; the API enforces the same rule on every call (AdminGuard).
 * M3 adds markets, payments and audit failures; settlement and disputes arrive with M5.
 */
/** Next 16 types `href`, so the list is declared as routes rather than plain strings. */
const NAV: { href: Route; label: string }[] = [
  { href: '/admin/markets', label: copy.adminMarkets },
  { href: '/admin/users', label: copy.adminUsers },
  { href: '/admin/charge-packages', label: copy.adminPackages },
  { href: '/admin/coupons', label: copy.adminCoupons },
  { href: '/admin/payments', label: copy.adminPayments },
  { href: '/admin/audit-failures', label: copy.adminAuditFailures },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  if (!(await getServerSession())) {
    // Where they were going, so signing in returns them there rather than to the user list.
    // The path comes from the header `proxy.ts` stamps; this fires on a hard load of an
    // admin URL (bookmark, shared link, cold visit, refresh) — a session that expires while
    // the tab is open surfaces as 401s on the API calls, not here.
    const pathname = (await headers()).get(X_PATHNAME);
    redirect(adminLoginPath(pathname) as Route);
  }
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
