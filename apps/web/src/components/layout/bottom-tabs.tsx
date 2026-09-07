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
 * every page's last row would sit under it — the root layout pays it as `<main>`'s bottom padding.
 *
 * The four destinations are shown to signed-out visitors too. Three of them are session-gated on
 * the server and answer with `redirect('/login?next=…')`, which is the same thing a tap on a
 * hidden tab could not do; hiding them would also make the bar's shape depend on a `GET /me` that
 * has not resolved during the first paint.
 */
/** Next 16 types `href`, so the list is declared as routes rather than plain strings. */
const TABS: { key: string; href: Route; label: string }[] = [
  { key: 'home', href: '/', label: copy.navHome },
  { key: 'portfolio', href: '/portfolio', label: copy.navPortfolio },
  { key: 'wallet', href: '/wallet', label: copy.navWallet },
  { key: 'settings', href: '/settings', label: copy.navSettings },
];

/**
 * The market detail screen is the one route with no tab bar: its trade panel puts a fixed
 * 예/아니오 bar in exactly this real estate (decision-trade-panel §6), and that bar is the element
 * AC 5 measures at 375px. Two fixed bars would stack, and the tab bar would cover the trade one.
 *
 * Only `/markets/<slug>` is excluded, not the whole prefix: a future `/markets` index would be a
 * list like the home page and should keep its tabs.
 */
export function hidesBottomTabs(pathname: string): boolean {
  return pathname.startsWith('/markets/');
}

/**
 * Whether a tab is the page being shown. `/` matches only itself — every route starts with it —
 * while the others also match their own subtree, so a future `/wallet/…` keeps 지갑 marked.
 */
export function isCurrentTab(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function BottomTabs() {
  const pathname = usePathname();
  if (hidesBottomTabs(pathname)) return null;

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
