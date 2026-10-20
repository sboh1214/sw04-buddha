import { Container, Heading, HStack, Stack, Link as ChakraLink } from '@chakra-ui/react';
import { PAID_COIN_SALES_ENABLED } from '@buddha/shared';
import type { Metadata, Route } from 'next';
import { headers } from 'next/headers';
import NextLink from 'next/link';
import { redirect } from 'next/navigation';
import { KstTimeZone } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';
import { adminLoginPath } from '@/lib/next-path';
import { getServerRole, getServerSession } from '@/lib/session.server';
import { X_PATHNAME } from '@/proxy';

export const metadata: Metadata = { title: `${copy.adminTitle} | ${copy.appName}` };

/**
 * PLAN 12: everything under /admin is admin-only. The check runs on the server so a member
 * never receives the page at all; the API enforces the same rule on every call (AdminGuard).
 * M3 adds markets, payments and audit failures. 판정 and its settlement steps live on the market
 * detail (ADR-0046); M5's dispute list went with the dispute stage.
 */
/**
 * Next 16 types `href`, so the list is declared as routes rather than plain strings. 충전 상품,
 * 쿠폰 and 결제 are listed only while paid Coin is on sale (PAID_COIN_SALES_ENABLED, ADR-0049):
 * hidden from the menu, their pages still open by address, and the API keeps the package and
 * coupon admin open (owner decision 2026-10-13) while it closes the refund. 운영자 계정 is #171's
 * (ADR-0056), 출시 설정 #170's (ADR-0055), SMS 발송 #183's (ADR-0070), 공지 #138's (ADR-0077).
 * The row wraps rather than scrolling sideways at phone width.
 */
const NAV: { href: Route; label: string }[] = [
  { href: '/admin/markets', label: copy.adminMarkets },
  { href: '/admin/notices', label: copy.adminNotices },
  { href: '/admin/users', label: copy.adminUsers },
  { href: '/admin/admins', label: copy.adminAccounts },
  ...(PAID_COIN_SALES_ENABLED
    ? [
        { href: '/admin/charge-packages' as Route, label: copy.adminPackages },
        { href: '/admin/coupons' as Route, label: copy.adminCoupons },
        { href: '/admin/payments' as Route, label: copy.adminPayments },
      ]
    : []),
  { href: '/admin/settings', label: copy.adminReleaseSettings },
  { href: '/admin/sms', label: copy.adminSms },
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
        <HStack justify="space-between" align="baseline" flexWrap="wrap" gap="3">
          <Heading as="h2" size="2xl">
            {copy.adminTitle}
          </Heading>
          <HStack gap="4" flexWrap="wrap" data-testid="admin-nav">
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
        {/* KST for every time inside, whichever zone the admin picked as a member (ADR-0061
            #60-8: 표시와 입력 모두 한국 시간). The admin lists call `formatKst` themselves; this is
            what holds the member components they borrow — the preview's card and rules. */}
        <KstTimeZone>{children}</KstTimeZone>
      </Stack>
    </Container>
  );
}
