'use client';

import { Box, HStack, Link as ChakraLink } from '@chakra-ui/react';
import NextLink from 'next/link';
import { usePathname } from 'next/navigation';
import { UnreadCount, useUnreadNotifications } from '@/components/notifications/unread-count';
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
 * cells. MY's cell then carries the member's unread notification count once its account is known
 * (#53, owner answer 53-1; `UnreadCount`): over the cell, so the bar keeps its height, and
 * described to a screen reader through the link's `aria-describedby` — the link's name stays 'MY'.
 *
 * On every route, the market detail included. There an open market's YES·NO 매수 bar (#122,
 * order-entry-bar.tsx) sits directly on top of this one rather than in its place: it sticks
 * `BOTTOM_TABS_HEIGHT_PX` above the bottom of the viewport, the height this bar is built to.
 */
export function BottomTabs() {
  const pathname = usePathname();
  const { data: session } = useSession();
  const unread = useUnreadNotifications();

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
        // MY carries the member's unread count (#53, 53-1), beside the link and not in it.
        const count = tab.key === 'my' ? unread : null;
        return (
          // The whole cell is the target, not just the few characters of the label (WCAG 2.5.5):
          // equal columns — the wrapper takes the column, the link fills it — each a full-height
          // link. The wrapper is the box the count sits on.
          <Box key={tab.key} flex="1" position="relative" display="flex">
            <ChakraLink
              asChild
              flex="1"
              justifyContent="center"
              // The row is `BOTTOM_TABS_HEIGHT_PX` less this bar's 1px rule, which is what the
              // detail's 매수 bar stands on (lib/nav.ts) — a fixed height, not padding around a
              // line box, so a font change cannot move the edge it meets.
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
              <NextLink
                href={tab.href}
                aria-current={current ? 'page' : undefined}
                aria-describedby={count === null ? undefined : BOTTOM_TAB_MY_UNREAD_ID}
              >
                {tab.label}
              </NextLink>
            </ChakraLink>
            {tab.key === 'my' && (
              <UnreadCount
                unread={count}
                id={BOTTOM_TAB_MY_UNREAD_ID}
                testId="bottom-tab-my-unread"
                // Up and to the right of the centred label, inside the cell: the bar's height and
                // the label's place stay as they are.
                placement={{ top: '1', left: 'calc(50% + 12px)' }}
              />
            )}
          </Box>
        );
      })}
    </HStack>
  );
}

/** The MY tab's unread phrase, which its link names as its description. */
const BOTTOM_TAB_MY_UNREAD_ID = 'bottom-tab-my-unread-text';
