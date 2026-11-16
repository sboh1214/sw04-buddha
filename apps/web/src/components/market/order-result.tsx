'use client';

import {
  Alert,
  Badge,
  Box,
  Button,
  DataList,
  HStack,
  Heading,
  Link as ChakraLink,
  Spinner,
  Stack,
  Text,
} from '@chakra-ui/react';
import { formatCoin, parseCoinAmount } from '@buddha/shared';
import NextLink from 'next/link';
import { useEffect, useId, useRef } from 'react';
import { useFormatDateTime } from '@/components/time-zone/time-zone-provider';
import { copy } from '@/copy';
import { type Order, type PlaceOrderBody } from '@/lib/api';
import { formatContracts } from '@/lib/market-admin';
import { MY_MODERATION_PATH } from '@/lib/moderation';
import {
  contractSideLabel,
  formatContractPrice,
  kindLabel,
  neededCoinOf,
  requestSummary,
  resultRows,
} from '@/lib/order-confirm';
import { type OrderFailure, type PendingOrderRequest } from '@/lib/order-panel';
import {
  cancelReasonText,
  failureText,
  insufficientCoinLine,
  insufficientContractsLine,
  orderStatusLabel,
  rejectReasonText,
  restrictedLineParts,
} from '@/lib/order-reasons';
import { useOrderPanel } from './order-panel-provider';

/**
 * 접수 중 and after (#66, ADR-0140 결정 2): the press's wait, the read-back of a lost answer, the
 * card of a request not found (owner answer 66-Q2: the same request again first, 버리기 with its
 * warning), and the end — the server's order as it stands, or a refusal that wrote no row. Every
 * figure is the server's row (`resultRows`), never the quote's.
 */
export function OrderOutcome() {
  const { state } = useOrderPanel();
  const { step } = state;
  switch (step.name) {
    case 'submitting':
      return <Submitting request={step.request} />;
    case 'recovering':
      return <Recovering request={step.request} exhausted={step.exhausted} />;
    case 'unsent':
      return <Unsent request={step.request} />;
    case 'result':
      return <OrderResultCard order={step.order} />;
    case 'failed':
      return <OrderErrorCard failure={step.failure} />;
    default:
      return null;
  }
}

/**
 * The terms a kept request went with, on one line (`requestSummary`): 접수 중 and the read-back
 * show what is being waited for, as 확인 did (ADR-0140 결정 2-23).
 */
function RequestSummary({ request }: { request: PendingOrderRequest }) {
  return (
    <Text fontSize="sm" color="fg.muted" data-testid="order-request-summary">
      {requestSummary(request.body)}
    </Text>
  );
}

/**
 * D13's restriction line with its end unbroken: '(2026. 11. 23. 오후 12:35까지)' never splits
 * between the year and the month (ADR-0140 결정 2-23). The order panel's account line too.
 */
export function RestrictedText({ endsAtText }: { endsAtText: string | null }) {
  const [head, end, tail] = restrictedLineParts(endsAtText);
  return (
    <>
      {head}
      <Text as="span" whiteSpace="nowrap">
        {end}
      </Text>
      {tail}
    </>
  );
}

/** 접수 중: the press's button, busy; only the sheet's 닫기 does anything meanwhile. */
function Submitting({ request }: { request: PendingOrderRequest }) {
  return (
    <Stack gap="3" data-testid="order-submitting">
      <Text role="status" fontSize="sm" color="fg.muted">
        {copy.orderSubmitting}
      </Text>
      <RequestSummary request={request} />
      <Button colorPalette="brand" loading aria-busy disabled data-testid="order-submit">
        {copy.orderSubmitting}
      </Button>
    </Stack>
  );
}

/**
 * The read-back (결정 2-6): busy, with a spinner, while its three reads run; after three failures
 * it waits for 다시 확인 and is no longer busy.
 */
function Recovering({ request, exhausted }: { request: PendingOrderRequest; exhausted: boolean }) {
  const panel = useOrderPanel();
  return (
    <Stack gap="3" role="status" aria-busy={!exhausted} data-testid="order-recovering">
      <HStack gap="2">
        {!exhausted && (
          <Spinner size="sm" color="fg.muted" data-testid="order-recovering-spinner" />
        )}
        <Text fontSize="sm">{copy.orderRecovering}</Text>
      </HStack>
      <RequestSummary request={request} />
      {exhausted && (
        <Button
          size="sm"
          variant="outline"
          alignSelf="flex-start"
          onClick={panel.recheck}
          data-testid="order-recheck"
        >
          {copy.orderRecheck}
        </Button>
      )}
    </Stack>
  );
}

/** The terms a kept request was sent with, as 확인 named them, and when it went. */
function requestRows(body: PlaceOrderBody, sentAt: string) {
  const gtc = body.timeInForce === 'gtc';
  const limitLabel = gtc
    ? copy.orderLimit
    : body.side === 'buy'
      ? copy.orderMaxBuyPrice
      : copy.orderMinSellPrice;
  return [
    {
      id: 'contract',
      label: copy.orderContract,
      value: contractSideLabel(body.outcome, body.side),
    },
    { id: 'kind', label: copy.orderKind, value: kindLabel(body.timeInForce) },
    body.budgetCoin === undefined
      ? { id: 'size', label: copy.orderQty, value: formatContracts(body.qty ?? 0) }
      : {
          id: 'size',
          label: copy.orderBudget,
          value: formatCoin(parseCoinAmount(body.budgetCoin)),
        },
    { id: 'limit', label: limitLabel, value: formatContractPrice(body.limitPriceCoin) },
    { id: 'sent-at', label: copy.orderUnsentSentAt, value: sentAt },
  ];
}

/**
 * The request not found after three reads (owner answer 66-Q2): what it was sent with and when,
 * 같은 요청 다시 보내기 first — the same id and body, which the server answers with the order if
 * the first one is still being taken — and 버리기 under its warning. It stays until one is pressed
 * or the tab closes.
 */
function Unsent({ request }: { request: PendingOrderRequest }) {
  const panel = useOrderPanel();
  const format = useFormatDateTime();
  const headingRef = useFocusOnShow<HTMLHeadingElement>();
  const warningId = useId();
  const rows = requestRows(request.body, format(new Date(request.savedAt).toISOString()));
  return (
    <Stack gap="3" role="status" data-testid="order-unsent">
      <Heading as="h3" size="sm" tabIndex={-1} ref={headingRef} outline="none">
        {copy.orderUnsent}
      </Heading>
      <DataList.Root orientation="horizontal" size="sm">
        {rows.map((row) => (
          <DataList.Item key={row.id} data-testid={`order-unsent-${row.id}`}>
            <DataList.ItemLabel>{row.label}</DataList.ItemLabel>
            <DataList.ItemValue fontVariantNumeric="tabular-nums">{row.value}</DataList.ItemValue>
          </DataList.Item>
        ))}
      </DataList.Root>
      <Button
        colorPalette="brand"
        onClick={() => {
          void panel.resend();
        }}
        data-testid="order-resend"
      >
        {copy.orderResend}
      </Button>
      {/* 버리기 with its warning, a group of its own below a rule: the warning is 버리기's
          (`aria-describedby`), never read as the line under 같은 요청 다시 보내기 (결정 2-23). */}
      <Stack gap="2" mt="2" pt="3" borderTopWidth="1px" data-testid="order-discard-group">
        <Text id={warningId} fontSize="sm" color="fg.warning" data-testid="order-discard-warning">
          {copy.orderDiscardWarning}
        </Text>
        <Button
          variant="outline"
          aria-describedby={warningId}
          onClick={panel.discard}
          data-testid="order-discard"
        >
          {copy.orderDiscard}
        </Button>
      </Stack>
    </Stack>
  );
}

/**
 * The focus to a card as it shows, only when it follows a press in this tab (`outcomeFocus`: 주문
 * 제출, 같은 요청 다시 보내기, 다시 확인) and the focus is still where that press left it — on the
 * panel or the sheet, or nowhere once the pressed button went. A read-back a page load started, or
 * a reader who moved on while it ran, keeps their focus; the card's status line says it
 * (결정 2-19).
 */
function useFocusOnShow<T extends HTMLElement>() {
  const { state } = useOrderPanel();
  const ref = useRef<T>(null);
  const pressed = useRef(state.outcomeFocus);
  useEffect(() => {
    const target = ref.current;
    if (!pressed.current || target === null) return;
    const active = document.activeElement;
    const place =
      target.closest('[data-testid="order-sheet"]') ??
      target.closest('[data-testid="order-panel"]');
    if (active === null || active === document.body || place?.contains(active) === true) {
      target.focus();
    }
  }, []);
  return ref;
}

/** The reason line of an ended order, with 잔액 부족's and 보유량 부족's figures (D11). */
function ReasonLine({ order }: { order: Order }) {
  const { me, sellable } = useOrderPanel();
  let text: string | null = null;
  if (order.rejectReason === 'insufficient_coin' && me !== undefined) {
    // N is the balance read again after the answer; M the lock the server asked for (결정 2-10).
    text = insufficientCoinLine(parseCoinAmount(me.balance.availableCoin), neededCoinOf(order));
  } else if (
    order.rejectReason === 'insufficient_contracts' &&
    sellable !== undefined &&
    sellable.outcome === order.outcome
  ) {
    text = insufficientContractsLine(sellable.unlockedQty, sellable.restingSellQty);
  } else if (order.rejectReason !== null) {
    text = rejectReasonText(order.rejectReason);
  } else if (order.cancelReason !== null) {
    text = cancelReasonText(order.cancelReason);
  }
  if (text === null) return null;
  return (
    <Text
      fontSize="sm"
      color={order.status === 'rejected' ? 'fg.warning' : 'fg.muted'}
      data-testid="order-result-reason"
    >
      {text}
    </Text>
  );
}

function OrderResultCard({ order }: { order: Order }) {
  const panel = useOrderPanel();
  const headingRef = useFocusOnShow<HTMLHeadingElement>();
  const neutral = order.status !== 'rejected';
  return (
    <Stack gap="3" role="status" data-testid="order-result" data-status={order.status}>
      <HStack gap="2">
        <Heading as="h3" size="sm" tabIndex={-1} ref={headingRef} outline="none">
          {copy.orderResultTitle}
        </Heading>
        {/* `surface`: a fill and a stroke. A neutral badge's `gray.subtle` fill alone is gray.900
            on the dark panel's #13161a and vanished; dark takes one step up (결정 2-23). */}
        <Badge
          variant="surface"
          colorPalette={neutral ? 'gray' : 'orange'}
          _dark={neutral ? { bg: 'gray.800', shadowColor: 'gray.600' } : undefined}
          data-testid="order-result-status"
        >
          {orderStatusLabel(order.status)}
        </Badge>
      </HStack>
      <Text fontSize="sm" color="fg.muted">
        {contractSideLabel(order.outcome, order.side)} · {kindLabel(order.timeInForce)}
      </Text>
      <ReasonLine order={order} />
      <DataList.Root orientation="horizontal" size="sm">
        {resultRows(order).map((row) => (
          <DataList.Item key={row.id} data-testid={`order-result-${row.id}`}>
            <DataList.ItemLabel>{row.label}</DataList.ItemLabel>
            <DataList.ItemValue fontVariantNumeric="tabular-nums">{row.value}</DataList.ItemValue>
          </DataList.Item>
        ))}
      </DataList.Root>
      <Button variant="outline" onClick={panel.newOrder} data-testid="order-new">
        {copy.orderNew}
      </Button>
    </Stack>
  );
}

/** A refusal that wrote no row (`orders.controller.ts`): one sentence, the input kept. */
function OrderErrorCard({ failure }: { failure: OrderFailure }) {
  const panel = useOrderPanel();
  const format = useFormatDateTime();
  const headingRef = useFocusOnShow<HTMLDivElement>();
  const endsAt = failure.restrictedEndsAt;
  return (
    <Stack gap="3">
      <Box tabIndex={-1} ref={headingRef} outline="none">
        <Alert.Root
          status="warning"
          role="alert"
          data-testid="order-error"
          data-code={failure.code}
        >
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>
              {failure.code === 'RESTRICTED' ? (
                <RestrictedText
                  endsAtText={endsAt === undefined || endsAt === null ? null : format(endsAt)}
                />
              ) : (
                failureText(failure)
              )}
            </Alert.Description>
            {failure.code === 'RESTRICTED' && (
              <ChakraLink asChild colorPalette="brand" color="colorPalette.fg" fontSize="sm">
                <NextLink href={MY_MODERATION_PATH}>{copy.myModeration}</NextLink>
              </ChakraLink>
            )}
          </Alert.Content>
        </Alert.Root>
      </Box>
      <Button variant="outline" onClick={panel.newOrder} data-testid="order-new">
        {copy.orderNew}
      </Button>
    </Stack>
  );
}
