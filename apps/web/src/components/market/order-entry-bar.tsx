'use client';

import {
  Alert,
  Box,
  Button,
  CloseButton,
  Drawer,
  HStack,
  Portal,
  Skeleton,
} from '@chakra-ui/react';
import { type Outcome } from '@buddha/shared';
import { useEffect, useState } from 'react';
import { SignInPrompt } from '@/components/market/sign-in-prompt';
import { copy } from '@/copy';
import {
  INITIAL_ORDER_SHEET,
  MD_UP_MEDIA_QUERY,
  ORDER_ENTRY_CONTRACTS,
  ORDER_ENTRY_SCROLL_PADDING,
  type OrderSheetState,
  type PersonalAreaView,
  closeOrderSheet,
  openOrderSheet,
  orderEntryLabel,
  orderSheetBody,
} from '@/lib/market-detail';
import { BOTTOM_TABS_HEIGHT_PX, ORDER_ENTRY_BAR_HEIGHT_PX } from '@/lib/nav';

/**
 * 모바일 주문 진입 (N02 §4 "주문 패널을 별도 시트로 연다", #122): below md, an open market's
 * YES 매수 and NO 매수, and the bottom sheet both of them open. The owner's #122 row (ADR-0061
 * decision 3): two entry points, no price on either, and until the order panel (#66) the sheet
 * says 거래 준비 중 to a member — the one line the desktop's order column says (ADR-0048). A
 * signed-out visitor is asked to sign in there instead, since an order is placed signed in (N02
 * §2; owner decision 2026-10-17); `orderSheetBody` decides which. The sheet remembers which
 * contract was pressed and names it in its title either way, which is what #66 opens its panel on.
 *
 * The caller draws this for an open market only (`showsOrderArea`), so a `market:status` that
 * closes the market takes the bar and an open sheet away with it.
 *
 * The bar is `position: sticky` at the end of the detail rather than `fixed` over the page. It
 * stands on the tab bar — `BOTTOM_TABS_HEIGHT_PX` plus the home-indicator inset above the bottom
 * of the viewport, the height `bottom-tabs.tsx` is built to — so neither bar covers the other.
 * And it never covers the page for good: a sticky box keeps its place in the flow, so scrolled to
 * the end of the detail it rests below the last section, and past that it leaves with the detail
 * instead of sitting over the footer. A fixed bar would need every page end on this route to pay
 * its height as padding, which is the footer's job for the tab bar alone (footer.tsx).
 *
 * Keyboard focus is kept out from under it. While the bar is in the page, below md, the page's
 * `scroll-padding-bottom` is the band the two bars cover (`ORDER_ENTRY_SCROLL_PADDING`), so a
 * control that takes the focus inside that band is scrolled up above the bar the way one off
 * screen would be, rather than focused where nobody can see it (WCAG 2.2 SC 2.4.11). The rule is
 * the bar's own — `html` that has this box — so it exists exactly as long as the bar does: it
 * leaves with a `market:status` that closes the market and with a navigation away. The bar is
 * built to `ORDER_ENTRY_BAR_HEIGHT_PX` for the same reason the tab bar is built to its number.
 *
 * The two buttons take the `yes` and `no` palettes the rest of the detail paints its contracts in
 * (내 포지션, 최근 체결), with their words on them, so the colour never carries the choice alone
 * (PLAN 11.2). Their `solid` and `contrast` pair is the one measured for buttons (ADR-0032).
 */
export function OrderEntryBar({
  viewer,
}: {
  /** Who is reading (`personalAreaView`): what the sheet holds under its title. */
  viewer: PersonalAreaView;
}) {
  const [sheet, setSheet] = useState<OrderSheetState>(INITIAL_ORDER_SHEET);

  // The sheet is the order panel below md only. A width that reaches md while it is open — a
  // tablet turned to landscape, a window widened — hides this bar and draws the order column
  // beside the sections, so the sheet closes there rather than stay over the column with its
  // backdrop (ADR-0067). Watched only while it is open, and closed from the media query's
  // callback, never in the effect body. Back below md it stays closed: nobody pressed anything.
  useEffect(() => {
    if (!sheet.open) return;
    const wide = window.matchMedia(MD_UP_MEDIA_QUERY);
    const close = (event: MediaQueryListEvent) => {
      if (event.matches) setSheet(closeOrderSheet);
    };
    wide.addEventListener('change', close);
    return () => {
      wide.removeEventListener('change', close);
    };
  }, [sheet.open]);

  return (
    <Drawer.Root
      open={sheet.open}
      // The pressed contract is also the dialog's trigger value, so the trigger zag gives the
      // focus back to is the one that was pressed.
      triggerValue={sheet.contract}
      onOpenChange={(details) => {
        if (!details.open) setSheet(closeOrderSheet);
      }}
      placement="bottom"
      lazyMount
      unmountOnExit
    >
      <Box
        hideFrom="md"
        position="sticky"
        bottom={`calc(${String(BOTTOM_TABS_HEIGHT_PX)}px + env(safe-area-inset-bottom))`}
        // Over the sections it passes, under the header and the tab bar (both `sticky`) and the
        // sheet's overlay.
        zIndex="docked"
        // Full width at the page's edges: the page's container pads 24px on each side.
        mx="-6"
        mt="6"
        px="6"
        py="3"
        // 12px, the 44px buttons, 12px, and the 1px rule: the number the scroll padding counts.
        h={`${String(ORDER_ENTRY_BAR_HEIGHT_PX)}px`}
        bg="bg"
        borderTopWidth="1px"
        css={{
          // The band under the two bars is outside the place the focus is scrolled to. `auto`
          // from md up, where `hideFrom` takes the bar away but this box is still in the page.
          'html:has(&)': { scrollPaddingBottom: { base: ORDER_ENTRY_SCROLL_PADDING, md: 'auto' } },
        }}
        data-testid="order-entry-bar"
      >
        <HStack gap="3">
          {ORDER_ENTRY_CONTRACTS.map((contract) => (
            // The dialog's own triggers, one per contract, rather than buttons that set `open`:
            // zag then returns the focus to the trigger of the pressed contract on close, which
            // does not depend on the press having focused the button — Safari and iOS never
            // focus a button on a click or a tap, and zag's other fallback is whatever had the
            // focus before, `<body>` there. They also say what they open (`aria-haspopup`,
            // `aria-expanded`, `aria-controls` while the sheet is mounted).
            <Drawer.Trigger key={contract} asChild value={contract}>
              <Button
                flex="1"
                size="lg"
                variant="solid"
                colorPalette={contract === 'YES' ? 'yes' : 'no'}
                onClick={() => {
                  setSheet(openOrderSheet(contract));
                }}
                data-testid={`order-entry-${contract === 'YES' ? 'yes' : 'no'}`}
              >
                {orderEntryLabel(contract)}
              </Button>
            </Drawer.Trigger>
          ))}
        </HStack>
      </Box>
      <OrderSheet contract={sheet.contract} viewer={viewer} />
    </Drawer.Root>
  );
}

/**
 * The bottom sheet: Chakra's `Drawer` at `placement="bottom"`, which is the dialog pattern — the
 * focus moves in and stays in, Escape and a press outside close it, and the focus goes back to the
 * trigger that opened it — with a close button named in Korean (`CloseButton` says 'Close').
 *
 * The frame has one scrolling body and no collapsible part (N02 §4: the price, quantity and amount
 * an order is confirmed on are never in a collapsed area), so whatever #66 puts in it stays in the
 * open. `lazyMount` and `unmountOnExit` on the root: nothing of it is in the server's HTML or in
 * the page while it is closed.
 *
 * The body is `orderSheetBody`'s — the sign-in prompt, 거래 준비 중 or a placeholder while the
 * session is unknown — and the title stays the pressed contract for all three.
 */
function OrderSheet({ contract, viewer }: { contract: Outcome | null; viewer: PersonalAreaView }) {
  const body = orderSheetBody(viewer);
  return (
    <Portal>
      <Drawer.Backdrop />
      <Drawer.Positioner>
        <Drawer.Content roundedTop="card" maxH="85dvh" data-testid="order-sheet">
          <Drawer.Header>
            <Drawer.Title data-testid="order-sheet-title">
              {contract === null ? null : orderEntryLabel(contract)}
            </Drawer.Title>
          </Drawer.Header>
          <Drawer.Body overflowY="auto" pb="calc(24px + env(safe-area-inset-bottom))">
            {body === 'login' ? (
              <SignInPrompt message={copy.orderSheetSignedOut} data-testid="order-sheet-sign-in" />
            ) : body === 'preparing' ? (
              <Alert.Root status="info" role="status">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description data-testid="order-sheet-notice">
                    {copy.tradePreparing}
                  </Alert.Description>
                </Alert.Content>
              </Alert.Root>
            ) : (
              // The session has not answered yet: neither line, so nobody is told one thing and
              // then the other (`orderSheetBody`). The 거래 준비 중 alert's own height.
              <Skeleton height="12" data-testid="order-sheet-pending" />
            )}
          </Drawer.Body>
          <Drawer.CloseTrigger asChild>
            <CloseButton size="sm" aria-label={copy.close} data-testid="order-sheet-close" />
          </Drawer.CloseTrigger>
        </Drawer.Content>
      </Drawer.Positioner>
    </Portal>
  );
}
