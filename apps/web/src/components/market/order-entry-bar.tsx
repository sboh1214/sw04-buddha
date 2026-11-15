'use client';

import { Box, Button, CloseButton, Drawer, HStack, Portal, Skeleton, Text } from '@chakra-ui/react';
import { copy } from '@/copy';
import {
  ORDER_ENTRY_CONTRACTS,
  ORDER_ENTRY_SCROLL_PADDING,
  orderEntryLabel,
  orderEntryPrice,
  orderSheetBody,
} from '@/lib/market-detail';
import {
  BOTTOM_TABS_HEIGHT_PX,
  ORDER_ENTRY_BAR_HEIGHT_PX,
  ORDER_SHEET_MAX_HEIGHT,
} from '@/lib/nav';
import { contractSideLabel } from '@/lib/order-confirm';
import { bestPriceOf } from '@/lib/order-panel';
import { OrderPanel } from './order-panel';
import { useOrderPanel } from './order-panel-provider';

/**
 * 모바일 주문 진입 (N02 §4 "주문 패널을 별도 시트로 연다", #122): below md, an open market's
 * YES 매수 and NO 매수, and the bottom sheet both of them open. Each names the contract's best ask
 * beside its words — '63.00 Coin', or '호가 없음' (ADR-0135 D2, #66 ADR-0140; in the gap the
 * reason's short name, 결정 2-23) — in a slot of its own that the server's HTML leaves empty, so
 * the price comes in without moving the words. The
 * sheet holds the order panel (#66), a visitor's too: typing and the quote need no sign-in, 주문
 * 확인 asks for one (D3). Its state — open, the contract pressed, what was typed — is the
 * provider's (`OrderPanelProvider`), which the column from md up shares, so a width that crosses
 * md keeps the order.
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
export function OrderEntryBar() {
  const panel = useOrderPanel();
  const { sheet, book, mdUp, inputClosed } = panel;
  // The provider closes the sheet when the width reaches md (ADR-0067).
  return (
    <Drawer.Root
      open={sheet.open}
      // The pressed contract is also the dialog's trigger value, so the trigger zag gives the
      // focus back to is the one that was pressed — a restored input's contract too (D4).
      triggerValue={sheet.contract}
      onOpenChange={(details) => {
        if (!details.open) panel.closeSheet();
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
          {ORDER_ENTRY_CONTRACTS.map((contract) => {
            const id = contract === 'YES' ? 'yes' : 'no';
            // Blank until the page has mounted: the server's HTML and hydration say the words. In
            // the gap, the reason's short name rather than '호가 없음' (ADR-0140 결정 2-23).
            const price =
              mdUp === null
                ? undefined
                : orderEntryPrice(bestPriceOf(book, contract, 'buy'), inputClosed);
            return (
              // The dialog's own triggers, one per contract, rather than buttons that set `open`:
              // zag then returns the focus to the trigger of the pressed contract on close, which
              // does not depend on the press having focused the button — Safari and iOS never
              // focus a button on a click or a tap, and zag's other fallback is whatever had the
              // focus before, `<body>` there. They also say what they open (`aria-haspopup`,
              // `aria-expanded`, `aria-controls` while the sheet is mounted).
              <Drawer.Trigger key={contract} asChild value={contract}>
                <Button
                  flex="1"
                  minW="0"
                  size="lg"
                  px="3"
                  gap="1.5"
                  variant="solid"
                  colorPalette={contract === 'YES' ? 'yes' : 'no'}
                  onClick={() => {
                    panel.openSheet(contract);
                  }}
                  data-testid={`order-entry-${id}`}
                >
                  {orderEntryLabel(contract)}
                  {/* A fixed slot, empty until the book answers: the words never move. */}
                  <Text
                    as="span"
                    display="inline-block"
                    minW="9ch"
                    textAlign="start"
                    fontSize="sm"
                    fontWeight="normal"
                    fontVariantNumeric="tabular-nums"
                    data-testid={`order-entry-${id}-price`}
                  >
                    {price}
                  </Text>
                </Button>
              </Drawer.Trigger>
            );
          })}
        </HStack>
      </Box>
      <OrderSheet />
    </Drawer.Root>
  );
}

/**
 * The bottom sheet: Chakra's `Drawer` at `placement="bottom"`, which is the dialog pattern — the
 * focus moves in and stays in, Escape and a press outside close it, and the focus goes back to the
 * trigger that opened it — with a close button named in Korean (`CloseButton` says 'Close').
 *
 * The frame has one scrolling body and no collapsible part (N02 §4: the price, quantity and amount
 * an order is confirmed on are never in a collapsed area); 확인's buttons stay at its bottom, the
 * body's bottom padding moved into their bar so they reach the sheet's edge.
 * `lazyMount` and `unmountOnExit` on the root: nothing of it is in the server's HTML or in the page
 * while it is closed. The title is the contract and the direction chosen now ('YES 매수').
 */
function OrderSheet() {
  const { viewer, state } = useOrderPanel();
  const body = orderSheetBody(viewer);
  return (
    <Portal>
      <Drawer.Backdrop />
      <Drawer.Positioner>
        <Drawer.Content roundedTop="card" maxH={ORDER_SHEET_MAX_HEIGHT} data-testid="order-sheet">
          <Drawer.Header>
            <Drawer.Title data-testid="order-sheet-title">
              {contractSideLabel(state.input.outcome, state.input.side)}
            </Drawer.Title>
          </Drawer.Header>
          {/* In 확인 its button bar carries this bottom padding (order-confirm.tsx): a sticky bar
              stops at the scroll box's padding, and rows would scroll by below it. */}
          <Drawer.Body
            overflowY="auto"
            pb={
              body === 'panel' && state.step.name === 'confirm'
                ? '0'
                : 'calc(24px + env(safe-area-inset-bottom))'
            }
          >
            {body === 'panel' ? (
              <OrderPanel place="sheet" />
            ) : (
              // The session has not answered yet: no panel, so nobody is shown one and then
              // another (`orderSheetBody`).
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
