'use client';

import { Box, Button, DataList, HStack, Heading, Stack, Text } from '@chakra-ui/react';
import { useEffect, useRef, useState } from 'react';
import { copy } from '@/copy';
import { confirmNotes, confirmRows, immediateFillNotice } from '@/lib/order-confirm';
import { coinShortfall } from '@/lib/order-panel';
import { insufficientCoinLine } from '@/lib/order-reasons';
import { FirstOrderGuide } from './first-order-guide';
import { useOrderPanel } from './order-panel-provider';

/**
 * 확인 화면 (#66, ADR-0140; N02 §6, ADR-0135 결정 4 '확인 화면의 자리'): the next step in the same
 * place — not a dialog — with every row open, none folded (N02 §4), each from the frozen quote and
 * `CONTRACT_TERMS` alone (`confirmRows`). The quote does not move under it: a book that moves is
 * said once with 다시 견적 beside it (D7), and never blocks 주문 제출.
 *
 * The buttons stay at the bottom of the column or the sheet while the rows scroll, and D7's line
 * and 다시 견적 ride with them, above the buttons, so the line and its button's focus are never
 * under the bar (WCAG 2.4.11). In the sheet the bar carries the body's bottom padding (the
 * safe area included), so nothing scrolls by below it.
 */
export function OrderConfirm({
  place,
  closedId,
  accountLineId,
}: {
  place: 'column' | 'sheet';
  closedId: string;
  accountLineId: string;
}) {
  const panel = useOrderPanel();
  const { state, me, inputClosed, account } = panel;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { step } = state;
  const requestId = step.name === 'confirm' ? step.requestId : null;
  // A 다시 견적 that froze a new quote is a new confirmation (a new id): said in the line that is
  // always there, decided while rendering (react.dev, "Storing information from previous renders").
  const [shownId, setShownId] = useState(requestId);
  const [requoted, setRequoted] = useState(false);
  if (shownId !== requestId) {
    setShownId(requestId);
    setRequoted(shownId !== null && requestId !== null);
  }
  // On 확인, and again on each new quote: the focus to its title, so a reader of the screen hears
  // the rows from the top — the 다시 견적 button it was on is gone by then (결정 2-19).
  useEffect(() => {
    headingRef.current?.focus();
  }, [requestId]);
  if (step.name !== 'confirm') return null;
  const { frozen } = step;
  const crossed = immediateFillNotice(frozen);
  // D11 for a buy: told, never blocked — the balance was read again as 확인 opened (결정 2-10).
  const shortfall =
    frozen.terms.side === 'buy' ? coinShortfall(frozen.quote, me?.balance.availableCoin) : null;
  const requoting = step.requote !== null;
  // D13 learned while 확인 is open turns 주문 제출 off as it does 주문 확인 (owner answer 66-Q3).
  const submitOff = requoting || inputClosed !== null || me === undefined || account !== null;
  const offReasons = [
    inputClosed !== null ? closedId : null,
    account !== null ? accountLineId : null,
  ].filter((id) => id !== null);
  // D7's line, in a live region that is always there so its words are read when they come.
  const notice = step.requoteFailed
    ? { text: copy.orderQuoteFailed, testId: 'order-review-requote-failed' }
    : step.bookChanged
      ? { text: copy.orderBookChanged, testId: 'order-review-book-changed' }
      : requoted
        ? { text: copy.orderRequoted, testId: 'order-review-requoted' }
        : null;
  const offersRequote = step.bookChanged || step.requoteFailed;
  // `data-baseline`: D7's baseline is in, so a book move from here on is told (the e2e waits).
  return (
    <Stack
      gap="4"
      data-testid="order-review"
      data-baseline={step.baseline !== null ? 'true' : 'false'}
    >
      <Heading as="h3" size="sm" tabIndex={-1} ref={headingRef} outline="none">
        {copy.orderReviewTitle}
      </Heading>
      {/* 첫 주문 안내 (#59, ADR-0154): open until the account's first order is taken, folded after —
          under the title, ahead of the rows, so its toggle and its opened text are never under the
          sticky bar below (WCAG 2.4.11). */}
      <FirstOrderGuide
        firstOrderPlaced={me?.firstOrderPlaced}
        timeInForce={frozen.terms.timeInForce}
        side={frozen.terms.side}
      />
      <DataList.Root orientation="horizontal" size="sm">
        {confirmRows(frozen).map((row) => (
          <DataList.Item key={row.id} data-testid={`order-review-${row.id}`}>
            <DataList.ItemLabel>{row.label}</DataList.ItemLabel>
            <DataList.ItemValue fontVariantNumeric="tabular-nums">{row.value}</DataList.ItemValue>
          </DataList.Item>
        ))}
      </DataList.Root>
      {crossed !== null && (
        <Text
          fontSize="sm"
          fontWeight="medium"
          color="fg.warning"
          role="status"
          data-testid="order-review-immediate-notice"
        >
          {crossed}
        </Text>
      )}
      {shortfall !== null && (
        <Text fontSize="sm" color="fg.warning" role="status" data-testid="order-shortfall">
          {insufficientCoinLine(shortfall.availableCoin, shortfall.needCoin)}
        </Text>
      )}
      <Stack gap="1">
        {confirmNotes(frozen).map((note) => (
          <Text key={note} fontSize="xs" color="fg.muted">
            {note}
          </Text>
        ))}
      </Stack>
      {/* The bar: D7's line and 다시 견적 above the buttons, in view at the bottom of the column or
          the sheet, on the panel's own surface (`bg.panel`, the card's and the sheet's). */}
      <Box
        position="sticky"
        bottom="0"
        bg="bg.panel"
        pt="2"
        pb={place === 'sheet' ? 'calc(24px + env(safe-area-inset-bottom))' : '1'}
        zIndex="1"
        data-testid="order-review-actions"
      >
        <HStack gap="3" flexWrap="wrap" mb={notice !== null || offersRequote ? '2' : '0'}>
          <Box role="status">
            {notice !== null && (
              <Text
                fontSize="sm"
                color={notice.testId === 'order-review-requoted' ? 'fg.muted' : 'fg.warning'}
                data-testid={notice.testId}
              >
                {notice.text}
              </Text>
            )}
          </Box>
          {offersRequote && (
            <Button
              size="xs"
              variant="outline"
              loading={requoting}
              disabled={requoting}
              onClick={() => {
                void panel.requote();
              }}
              data-testid="order-review-requote"
            >
              {copy.orderRequote}
            </Button>
          )}
        </HStack>
        <HStack gap="3">
          <Button
            flex="1"
            variant="outline"
            disabled={requoting}
            onClick={panel.back}
            data-testid="order-review-edit"
          >
            {copy.orderEdit}
          </Button>
          <Button
            flex="1"
            colorPalette="brand"
            disabled={submitOff}
            aria-describedby={offReasons.length > 0 ? offReasons.join(' ') : undefined}
            onClick={() => {
              void panel.submit();
            }}
            data-testid="order-submit"
          >
            {copy.orderSubmit}
          </Button>
        </HStack>
      </Box>
    </Stack>
  );
}
