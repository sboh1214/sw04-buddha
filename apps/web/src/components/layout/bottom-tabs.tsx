'use client';

import { HStack, Link as ChakraLink } from '@chakra-ui/react';
import type { Route } from 'next';
import NextLink from 'next/link';
import { usePathname } from 'next/navigation';
import { copy } from '@/copy';

/**
 * The mobile bottom tab bar (PLAN 11.4 레이아웃): 홈 · 포트폴리오 · 지갑 · 설정, below `md` only.
 *
 * Fixed to the bottom of the viewport, so the document needs that much extra scroll length or
 * every page's last row would sit under it — the site footer, the last row of every page, pays it
 * as extra bottom padding (footer.tsx).
 *
 * The four destinations are shown to signed-out visitors too. Three of them are in MY, whose
 * layout is session-gated on the server and answers with `redirect('/login?next=…')`, which is
 * the same thing a tap on a hidden tab could not do; hiding them would also make the bar's shape
 * depend on a `GET /me` that has not resolved during the first paint.
 */
/** Next 16 types `href`, so the list is declared as routes rather than plain strings. */
const TABS: { key: string; href: Route; label: string }[] = [
  { key: 'home', href: '/', label: copy.navHome },
  { key: 'portfolio', href: '/my', label: copy.navPortfolio },
  { key: 'wallet', href: '/my/wallet', label: copy.navWallet },
  { key: 'settings', href: '/my/settings', label: copy.navSettings },
];

/**
 * Whether a tab is the page being shown. `/` matches only itself — every route starts with it —
 * while the others also match their own subtree, so a future `/my/wallet/…` keeps 지갑 marked.
 */
export function isCurrentTab(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * On every route, the market detail included: its 주문 영역 is an ordinary block (#125), so
 * nothing else claims this place.
 */
export function BottomTabs() {
  const pathname = usePathname();

  return (
    <HStack
      as="nav"
      aria-label={copy.navMenu}
      hideFrom="md"
      position="fixed"
      insetInline="0"
      bottom="0"
      zIndex="sticky"
      bg="bg"
      borderTopWidth="1px"
      gap="0"
      // The home-indicator strip on a notched phone sits over the last few pixels of the viewport.
      pb="env(safe-area-inset-bottom)"
      data-testid="bottom-tabs"
    >
      {TABS.map((tab) => {
        const current = isCurrentTab(pathname, tab.href);
        return (
          <ChakraLink
            key={tab.key}
            asChild
            // The whole cell is the target, not just the two or three characters of the label
            // (WCAG 2.5.5): four equal columns, each a full-height link.
            flex="1"
            justifyContent="center"
            py="3"
            fontSize="sm"
            // Weight as well as colour, and `aria-current` on top of both: the current tab is
            // never signalled by colour alone (AC 6).
            colorPalette="brand"
            color={current ? 'colorPalette.fg' : 'fg.muted'}
            fontWeight={current ? 'semibold' : 'normal'}
            textDecoration="none"
            data-testid={`bottom-tab-${tab.key}`}
          >
            <NextLink href={tab.href} aria-current={current ? 'page' : undefined}>
              {tab.label}
            </NextLink>
          </ChakraLink>
        );
      })}
    </HStack>
  );
}
