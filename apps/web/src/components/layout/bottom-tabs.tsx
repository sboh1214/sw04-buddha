'use client';

import { HStack, Link as ChakraLink } from '@chakra-ui/react';
import NextLink from 'next/link';
import { usePathname } from 'next/navigation';
import { copy } from '@/copy';
import { BOTTOM_TABS_HEIGHT_PX, isPrimaryCurrent, primaryNavItems } from '@/lib/nav';
import { useSession } from '@/lib/use-session';

/**
 * The mobile bottom tab bar (PLAN 11.4 레이아웃, #16), below `md` only: the same three areas as
 * the desktop header's row 1 — 시장 탐색 · 커뮤니티 · MY — from the same list (`primaryNavItems`,
 * lib/nav.ts), so every width reaches the same places. Which tab is current is
 * `isPrimaryCurrent`, the header's own rule: 시장 탐색 stays lit on a market detail, on the
 * search screen (ADR-0066) and on the theme pages (ADR-0088), and MY on every MY tab.
 *
 * Fixed to the bottom of the viewport, so the document needs that much extra scroll length or
 * every page's last row would sit under it — the site footer, the last row of every page, pays it
 * as extra bottom padding (footer.tsx).
 *
 * A visitor with no session sees the two public areas; MY joins once the session says someone is
 * signed in (owner decision 2026-10-13). `useSession` holds `isPending` through hydration
 * (lib/use-session.ts), so the server HTML and the hydrating render both draw two tabs and a
 * signed-in reader's third arrives after — the bar's height never changes, only the width of its
 * cells.
 *
 * On every route, the market detail included. There an open market's YES·NO 매수 bar (#122,
 * order-entry-bar.tsx) sits directly on top of this one rather than in its place: it sticks
 * `BOTTOM_TABS_HEIGHT_PX` above the bottom of the viewport, the height this bar is built to.
 */
export function BottomTabs() {
  const pathname = usePathname();
  const { data: session } = useSession();

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
      {primaryNavItems(session != null).map((tab) => {
        const current = isPrimaryCurrent(pathname, tab.key);
        return (
          <ChakraLink
            key={tab.key}
            asChild
            // The whole cell is the target, not just the few characters of the label (WCAG
            // 2.5.5): equal columns, each a full-height link.
            flex="1"
            justifyContent="center"
            // The row is `BOTTOM_TABS_HEIGHT_PX` less this bar's 1px rule, which is what the
            // detail's 매수 bar stands on (lib/nav.ts) — a fixed height, not padding around a line
            // box, so a font change cannot move the edge it meets.
            h={`${String(BOTTOM_TABS_HEIGHT_PX - 1)}px`}
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
