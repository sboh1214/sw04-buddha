'use client';

import {
  Alert,
  Box,
  Button,
  Card,
  CloseButton,
  DataList,
  Drawer,
  Field,
  HStack,
  Input,
  InputGroup,
  Portal,
  SegmentGroup,
  Skeleton,
  Stack,
  Tabs,
  Text,
} from '@chakra-ui/react';
import {
  type OrderSide,
  type Outcome,
  type QuoteMode,
  formatP,
  parsePAmount,
} from '@buddha/shared';
import { useQueryClient } from '@tanstack/react-query';
import NextLink from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, type Ref, useEffect, useRef, useState } from 'react';
import { toaster } from '@/components/ui/toaster';
import { copy } from '@/copy';
import { QUOTE_DEBOUNCE_MS, useDebouncedValue } from '@/hooks/use-debounced-value';
import { useMarket } from '@/hooks/use-markets';
import { useMe } from '@/hooks/use-me';
import {
  REQUOTE_THROTTLE_MS,
  heldQtyOf,
  usePositions,
  useQuote,
  useTrade,
} from '@/hooks/use-trade';
import { type Market, type TradeBody, isApiError } from '@/lib/api';
import { useSession } from '@/lib/use-session';
import {
  formatBp,
  formatContracts,
  formatNoPrice,
  formatPricePerContract,
  formatYesPrice,
} from '@/lib/market-admin';
import { quoteMarketKey } from '@/lib/market-keys';
import {
  type TradeCta,
  type TradeInputs,
  // Aliased because the component below owns the name `TradePanelView`: the type is the phase
  // the machine answered, the component is what renders it.
  type TradePanelView as TradeView,
  type TradeSummary,
  INITIAL_TRADE_INPUTS,
  isTradable,
  quoteRequest,
  setMode,
  setOutcome,
  setSide,
  setValue,
  tradeCta,
  tradeErrorMessage,
  tradePanelView,
  tradeRequest,
  tradeSummary,
} from '@/lib/trade-panel';

/**
 * The 매수/매도 panel (design 6-7): ONE `useTradePanel` state feeding ONE dumb `TradePanelView`
 * that is mounted twice — an inline sticky card from `md` up, and a bottom sheet opened from the
 * fixed 예/아니오 bar below it.
 *
 * Two instances of the state would mean two quote queries, two machines and a typed amount lost
 * on rotation; two renderers of one state cost a `testIdPrefix` and nothing else. The split is
 * CSS (`hideBelow`/`hideFrom`), never `useBreakpointValue`: that hook answers `T | undefined` on
 * the first client render (`ssr: true, fallback: 'base'`), which flashes exactly the bar AC 5
 * measures at 375px.
 *
 * Nothing here decides anything. The phase, the button, the summary numbers, the refusal text and
 * the slippage guard all come from `lib/trade-panel.ts` and `@buddha/shared`, because this file
 * cannot be executed by this app's test runner (`environment: 'node'`, no jsdom) — a decision
 * left in a component is a decision no unit test can reach.
 */

/** 1,000 / 5,000 / 10,000P — the spend-mode shortcuts; they go through the same debounce. */
const AMOUNT_CHIPS_P = [1_000n, 5_000n, 10_000n] as const;

/** An unpriced row. The repo already writes an em dash inline for "nothing here yet". */
const DASH = '—';

// ---- state --------------------------------------------------------------------------

/** Everything the two renderers read. Built once per render by `useTradePanel`. */
interface TradePanelState {
  market: Market;
  inputs: TradeInputs;
  view: TradeView;
  cta: TradeCta;
  /** The numbers the summary rows show, or `undefined` while there is nothing to price. */
  summary: TradeSummary | undefined;
  /** A first quote is in flight with nothing to keep on screen: the summary is a skeleton. */
  loadingSummary: boolean;
  /** The summary belongs to the previous intent, or the market moved under it: dim it. */
  dim: boolean;
  /** 진행 중이 아님 / 마감 — the one string the panel and the mobile bar both render. */
  notice: string | undefined;
  availableP: bigint | undefined;
  heldQty: number | undefined;
  submitting: boolean;
  sheetOpen: boolean;
  chooseSide: (side: OrderSide) => void;
  chooseOutcome: (outcome: Outcome) => void;
  chooseMode: (mode: QuoteMode) => void;
  changeValue: (raw: string) => void;
  openSheet: (outcome: Outcome) => void;
  closeSheet: () => void;
  press: () => void;
}

function useTradePanel(market: Market): TradePanelState {
  const [inputs, setInputs] = useState<TradeInputs>(INITIAL_TRADE_INPUTS);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [reconfirmFrom, setReconfirmFrom] = useState<bigint | undefined>(undefined);

  const queryClient = useQueryClient();
  // The account the panel trades as rides along as `expectedAccountId` (Q-M3-5). `sessionPending`
  // is its own phase rather than "anonymous": sending `expectedAccountId: undefined` is not an
  // option, and flashing 로그인 at a signed-in reader is worse than a disabled button.
  const { data: session, isPending: sessionPending } = useSession();
  const accountId = session?.user.id;
  const me = useMe();
  const positions = usePositions('open');
  // A second observer on the `['market', id]` entry the screen around this panel already reads:
  // it costs no request (one key, one query function) and `dataUpdatedAt` is the only thing this
  // panel wants from it — both the staleness signal and the clock below.
  const marketQuery = useMarket(market.id);
  const marketUpdatedAt = marketQuery.dataUpdatedAt;

  /*
   * The clock the 마감 gate reads. Deliberately NOT `Date.now()`: this client component also
   * renders on the server, where a browser-read instant is both a hydration mismatch on the page
   * AC 2 measures and a `react-hooks/purity` error. `dataUpdatedAt` is the instant the SERVER
   * last answered for this market — it rides the dehydrated payload, so the SSR render and its
   * hydration agree byte for byte, and it moves forward on every refetch and every `market:tick`
   * the socket writes into the cache.
   *
   * It is a lower bound on the real clock, which is the safe direction: the panel is never EARLY
   * in calling a market 마감, only late, and the last word belongs to `assertTradable` on the
   * database clock anyway (A-M3-16) — a late refusal arrives as MARKET_CLOSED and renders through
   * the same string.
   */
  const now = marketUpdatedAt;

  // PLAN 11.4's 300ms, on the typed amount ONLY. 매수/매도, 예/아니오 and the mode reach the
  // quote key undebounced, so a discrete tap re-prices instantly (design 4.2).
  const settledValue = useDebouncedValue(inputs.value, QUOTE_DEBOUNCE_MS);
  const quoteBody = quoteRequest(
    market.id,
    { ...inputs, value: settledValue },
    isTradable(market, now),
  );
  const quoteQuery = useQuote(quoteBody);
  // The whole race fix in one line (design 4.1): every input is in the query key, so a late
  // answer lands on its own entry, and placeholder data — which belongs to an intent the trader
  // has already typed past — may dim the summary but must never build a wire body.
  const quote = quoteQuery.isPlaceholderData ? undefined : quoteQuery.data;
  const quoteUpdatedAt = quoteQuery.dataUpdatedAt;
  const stale = quoteUpdatedAt > 0 && marketUpdatedAt > quoteUpdatedAt;

  const trade = useTrade(market, (result) => {
    // Fires BEFORE the cache work (useTrade awaits it after), so the toast and the closing sheet
    // are instant while the CTA stays disabled until the fresh numbers land.
    toaster.create({
      type: 'success',
      title: result.order.side === 'buy' ? copy.tradeBought : copy.tradeSold,
    });
    setSheetOpen(false);
    // The amount that was just spent is not a proposal for the next trade: left in the field it
    // would keep a quote running for P the balance no longer holds, one tap from a second order.
    setInputs((current) => setValue(current, ''));
    setReconfirmFrom(undefined);
  });
  const submitting = trade.isPending;

  const availableP = me.data === undefined ? undefined : parsePAmount(me.data.balance.availableP);
  // `undefined` (logged out, or the list still loading) never blocks a sell — it is not 0.
  const heldQty = heldQtyOf(positions.data, market.id, inputs.outcome);

  const view = tradePanelView({
    market,
    inputs,
    quote,
    quoteError: quoteQuery.error,
    stale,
    accountId,
    sessionPending,
    availableP,
    heldQty,
    submitting,
    reconfirmFrom,
    now,
  });

  /*
   * Follow the live price without importing the socket (design 4.3): whatever patches the market
   * cache — a `market:tick`, this tab's own trade answer, a background refetch — shows up as
   * `marketUpdatedAt > quoteUpdatedAt`, and one throttled invalidation re-prices the single active
   * quote. At most one quote query exists, so this is <= 1 `POST /quotes` per second on the
   * busiest market, and the request is public and side-effect free.
   *
   * Suppressed while a submit is in flight or a re-confirm is pending, so the guard that is sent
   * is the guard the user read. `marketUpdatedAt` is a dependency rather than a derived boolean:
   * a run the throttle turns away must be retried by the NEXT tick, and a boolean that stays true
   * would never re-fire the effect.
   */
  const lastRequoteAt = useRef(0);
  useEffect(() => {
    if (submitting || reconfirmFrom !== undefined) return;
    if (quoteUpdatedAt === 0 || marketUpdatedAt <= quoteUpdatedAt) return;
    const at = Date.now();
    if (at - lastRequoteAt.current < REQUOTE_THROTTLE_MS) return;
    lastRequoteAt.current = at;
    void queryClient.invalidateQueries({
      queryKey: quoteMarketKey(market.id),
      refetchType: 'active',
    });
  }, [marketUpdatedAt, quoteUpdatedAt, submitting, reconfirmFrom, queryClient, market.id]);

  // While a new quote is in flight the previous numbers stay on screen instead of flashing a
  // skeleton — the same summary the machine builds, from the placeholder the query still holds,
  // marked stale so it is dimmed and can never be pressed on.
  const summary =
    'summary' in view
      ? view.summary
      : view.kind === 'quoting' && quoteQuery.data !== undefined
        ? tradeSummary(inputs, quoteQuery.data, true)
        : undefined;

  // Steps 1-2 of the machine run before anything else, so these two kinds are exactly "this
  // market cannot be traded", which is what the mobile bar has to say in place of its buttons.
  const notice =
    view.kind === 'not_open'
      ? copy.errMarketNotOpen
      : view.kind === 'past_close'
        ? copy.errTradeClosed
        : undefined;

  /** Any input change is a new intent, so a re-confirm asked for on the old one is stale. */
  function change(next: (current: TradeInputs) => TradeInputs): void {
    setInputs(next);
    setReconfirmFrom(undefined);
  }

  async function send(body: TradeBody, amountP: bigint): Promise<void> {
    try {
      await trade.mutateAsync(body);
    } catch (error) {
      // `useTrade.onError` has already corrected whichever cache the refusal contradicts, and the
      // view re-derives from it — which is why exactly one code path renders 충전하기 and one
      // renders 마감. All that is left is whether this becomes the explicit re-confirm step.
      // PRICE_MOVED gets no toast: the panel says it itself, above a button carrying the new
      // number, and a toast would scroll that answer off a 375px screen.
      if (isApiError(error, 'PRICE_MOVED')) {
        setReconfirmFrom(amountP);
        return;
      }
      setReconfirmFrom(undefined);
      toaster.create({ type: 'error', title: tradeErrorMessage(error) });
    }
  }

  function press(): void {
    if (view.kind === 'ready') {
      void send(view.body, view.summary.amountP);
      return;
    }
    // A pending re-confirm holds the machine out of `ready` (step 10), so the body it never built
    // is built here — by the same builder, on the fresh quote the summary is already showing.
    if (view.kind !== 'reconfirm' || quote === undefined || accountId === undefined) return;
    const body = tradeRequest({ marketId: market.id, inputs, quote, accountId });
    if (body !== undefined) void send(body, view.summary.amountP);
  }

  return {
    market,
    inputs,
    view,
    cta: tradeCta(view),
    summary,
    loadingSummary: view.kind === 'quoting' && summary === undefined,
    dim: view.kind === 'quoting' || summary?.stale === true,
    notice,
    availableP,
    heldQty,
    submitting,
    sheetOpen,
    chooseSide: (side) => {
      change((current) => setSide(current, side));
    },
    chooseOutcome: (outcome) => {
      change((current) => setOutcome(current, outcome));
    },
    chooseMode: (mode) => {
      change((current) => setMode(current, mode));
    },
    changeValue: (raw) => {
      change((current) => setValue(current, raw));
    },
    openSheet: (outcome) => {
      change((current) => setOutcome(current, outcome));
      setSheetOpen(true);
    },
    closeSheet: () => {
      setSheetOpen(false);
    },
    press,
  };
}

// ---- the panel ----------------------------------------------------------------------

export interface TradePanelProps {
  /** The live market row the detail screen holds; `lastPrice`/`status` drive the bar and gate. */
  market: Market;
}

/**
 * Mount this once, inside the detail grid's right column. It renders three things off one state:
 * the inline card (>= md), the fixed 예/아니오 bar (< md) and the sheet that bar opens. The bar is
 * `position: fixed`, so it leaves the column and takes the mobile tab bar's place on this route —
 * the page container owes it a bottom padding.
 */
export function TradePanel({ market }: TradePanelProps) {
  const panel = useTradePanel(market);
  // Only the sheet's field takes the ref: at < md the inline card is still mounted behind
  // `display: none`, and focusing a hidden input does nothing.
  const sheetAmountRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <Box hideBelow="md" position="sticky" top="4" alignSelf="start">
        <Card.Root>
          <Card.Body>
            <TradePanelView panel={panel} testIdPrefix="trade" />
          </Card.Body>
        </Card.Root>
      </Box>

      {/* AC 5: at 375px the 확률 and both 예/아니오 buttons are inside the viewport without
          scrolling, in the SSR paint — this bar is how, and it is why the split is CSS. */}
      <HStack
        hideFrom="md"
        position="fixed"
        insetInline="0"
        bottom="0"
        zIndex="sticky"
        bg="bg"
        borderTopWidth="1px"
        p="3"
        gap="3"
        data-testid="trade-bar"
      >
        {panel.notice === undefined ? (
          <>
            <Button
              flex="1"
              size="lg"
              colorPalette="yes"
              aria-haspopup="dialog"
              onClick={() => {
                panel.openSheet('YES');
              }}
              data-testid="trade-bar-yes"
            >
              {formatYesPrice(market.lastPrice)}
            </Button>
            <Button
              flex="1"
              size="lg"
              colorPalette="no"
              aria-haspopup="dialog"
              onClick={() => {
                panel.openSheet('NO');
              }}
              data-testid="trade-bar-no"
            >
              {formatNoPrice(market.lastPrice)}
            </Button>
          </>
        ) : (
          <Text flex="1" textAlign="center" color="fg.muted" data-testid="trade-bar-notice">
            {panel.notice}
          </Text>
        )}
      </HStack>

      {/* `Drawer.Root` is a React.FC with no style props and its `size` only sets `maxW`, so the
          sheet's height is an explicit `maxH` on the content — `dvh`, not `vh`, because a mobile
          URL bar changes the viewport under it. Nothing renders here at >= md or before the first
          tap (`lazyMount unmountOnExit`), so the two testid sets never both carry a live sheet. */}
      <Drawer.Root
        open={panel.sheetOpen}
        placement="bottom"
        lazyMount
        unmountOnExit
        closeOnInteractOutside={!panel.submitting}
        closeOnEscape={!panel.submitting}
        initialFocusEl={() => sheetAmountRef.current}
        onOpenChange={(details) => {
          if (!details.open && !panel.submitting) panel.closeSheet();
        }}
      >
        <Portal>
          <Drawer.Backdrop />
          <Drawer.Positioner>
            <Drawer.Content maxH="85dvh" roundedTop="l3" data-testid="trade-sheet">
              <Drawer.Header>
                <Drawer.Title lineClamp={2} pe="8">
                  {market.title}
                </Drawer.Title>
                <Drawer.CloseTrigger asChild>
                  <CloseButton
                    size="sm"
                    aria-label={copy.cancel}
                    disabled={panel.submitting}
                    data-testid="trade-sheet-close"
                  />
                </Drawer.CloseTrigger>
              </Drawer.Header>
              {/* The home indicator on a modern phone sits under the sheet's own bottom edge. */}
              <Drawer.Body pb="env(safe-area-inset-bottom)">
                <TradePanelView
                  panel={panel}
                  testIdPrefix="trade-sheet"
                  amountRef={sheetAmountRef}
                />
              </Drawer.Body>
            </Drawer.Content>
          </Drawer.Positioner>
        </Portal>
      </Drawer.Root>
    </>
  );
}

// ---- the renderer -------------------------------------------------------------------

interface TradePanelViewProps {
  panel: TradePanelState;
  /**
   * REQUIRED, and the reason this component has no default: below `md` the inline card is still
   * in the DOM behind `display: none`, so both id sets exist at once and every Playwright
   * selector has to be prefix-scoped. A bare `trade-value` would be ambiguous on a phone.
   */
  testIdPrefix: 'trade' | 'trade-sheet';
  amountRef?: Ref<HTMLInputElement>;
}

function TradePanelView({ panel, testIdPrefix: prefix, amountRef }: TradePanelViewProps) {
  const { market, inputs, view, cta, summary } = panel;
  const pathname = usePathname();

  // Steps 1-2 replace the whole panel rather than disabling its controls: a market that cannot
  // be traded has no quote to show, and every field would be a control that can never work.
  if (panel.notice !== undefined) {
    return (
      <Alert.Root status="info" role="status" data-testid={`${prefix}-panel`}>
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description data-testid={`${prefix}-notice`}>{panel.notice}</Alert.Description>
        </Alert.Content>
      </Alert.Root>
    );
  }

  const errorText = fieldError(view);
  const inputDisabled = view.kind === 'no_position' || panel.submitting;
  const unit = inputs.mode === 'spend' ? 'P' : copy.tradeUnitContracts;
  const maxValue = maxValueFor(panel);
  // While the summary is unpriced the row set still follows the tab, so nothing jumps when the
  // first quote lands: a sell has no payout leg (`maxPayoutP` is '0') and shows neither row.
  const guardKind = summary?.guardKind ?? (inputs.side === 'buy' ? 'maxCost' : 'minProceeds');
  const sideLabel = inputs.side === 'buy' ? copy.tradeBuy : copy.tradeSell;
  // `tradeCta` decides what the button DOES; the number on it is the one the summary shows, which
  // a re-confirm carries in its own summary rather than in the CTA.
  const pressAmountP =
    cta.kind === 'submit'
      ? cta.amountP
      : view.kind === 'reconfirm'
        ? view.summary.amountP
        : undefined;

  const form = (
    <Stack gap="4">
      {/* 예/아니오. The colour is never the only signal (PLAN 11.2): each label is that side's
          own price, which is also the comparison this panel exists to make. `subtle`, not
          `outline`, so the unselected side stays a filled affordance at AA contrast. */}
      <HStack gap="2">
        <Button
          flex="1"
          colorPalette="yes"
          variant={inputs.outcome === 'YES' ? 'solid' : 'subtle'}
          aria-pressed={inputs.outcome === 'YES'}
          disabled={panel.submitting}
          onClick={() => {
            panel.chooseOutcome('YES');
          }}
          data-testid={`${prefix}-outcome-yes`}
        >
          {formatYesPrice(market.lastPrice)}
        </Button>
        <Button
          flex="1"
          colorPalette="no"
          variant={inputs.outcome === 'NO' ? 'solid' : 'subtle'}
          aria-pressed={inputs.outcome === 'NO'}
          disabled={panel.submitting}
          onClick={() => {
            panel.chooseOutcome('NO');
          }}
          data-testid={`${prefix}-outcome-no`}
        >
          {formatNoPrice(market.lastPrice)}
        </Button>
      </HStack>

      {/* Hidden on 매도, not disabled: `quoteBodySchema` refuses spend + sell, so this control
          could never work there, and an absent control beats a dead one. */}
      {inputs.side === 'buy' && (
        <SegmentGroup.Root
          size="sm"
          value={inputs.mode}
          disabled={panel.submitting}
          onValueChange={(details) => {
            panel.chooseMode(details.value === 'shares' ? 'shares' : 'spend');
          }}
          data-testid={`${prefix}-mode`}
        >
          <SegmentGroup.Indicator />
          <SegmentGroup.Items
            items={[
              { value: 'spend', label: copy.tradeModeAmount },
              { value: 'shares', label: copy.tradeModeShares },
            ]}
          />
        </SegmentGroup.Root>
      )}

      <Field.Root invalid={errorText !== undefined} disabled={inputDisabled}>
        <Field.Label>{copy.tradeAmountLabel}</Field.Label>
        {/* `InputGroup` takes exactly one child; the unit rides in `endElement`. */}
        <InputGroup endElement={<Text color="fg.muted">{unit}</Text>}>
          <Input
            ref={amountRef}
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            value={inputs.value}
            disabled={inputDisabled}
            onChange={(event) => {
              panel.changeValue(event.target.value);
            }}
            data-testid={`${prefix}-value`}
          />
        </InputGroup>
        <Field.ErrorText>{errorText}</Field.ErrorText>
      </Field.Root>

      <HStack gap="2" flexWrap="wrap">
        {inputs.mode === 'spend' &&
          AMOUNT_CHIPS_P.map((chip) => (
            <Button
              key={chip.toString()}
              size="xs"
              variant="outline"
              disabled={inputDisabled}
              onClick={() => {
                panel.changeValue(chip.toString());
              }}
              data-testid={`${prefix}-chip-${chip.toString()}`}
            >
              {formatP(chip)}
            </Button>
          ))}
        {maxValue !== undefined && (
          <Button
            size="xs"
            variant="ghost"
            disabled={inputDisabled}
            onClick={() => {
              panel.changeValue(maxValue);
            }}
            data-testid={`${prefix}-max`}
          >
            {copy.tradeMax}
          </Button>
        )}
        {inputs.side === 'sell' && panel.heldQty !== undefined && (
          <Text fontSize="xs" color="fg.muted" data-testid={`${prefix}-holding`}>
            {`${copy.tradeHolding} ${formatContracts(panel.heldQty)}`}
          </Text>
        )}
      </HStack>

      {/* Always on screen (PLAN 11.1-2), including the slippage guard as an ABSOLUTE amount —
          there is no hidden tolerance and no slider. Dimmed while the numbers belong to the
          previous intent or the market has moved under them; a fade, never a colour flash, and
          instant for a reader who asked for less motion. */}
      <Skeleton loading={panel.loadingSummary}>
        <DataList.Root
          orientation="horizontal"
          size="sm"
          opacity={panel.dim ? 0.6 : 1}
          transition="opacity"
          _motionReduce={{ transitionDuration: '0ms' }}
          data-testid={`${prefix}-summary`}
        >
          <SummaryRow label={copy.tradeContracts} testId={`${prefix}-summary-shares`}>
            {summary === undefined ? DASH : formatContracts(summary.shares)}
          </SummaryRow>
          <SummaryRow label={copy.tradeAvgPrice} testId={`${prefix}-summary-avg`}>
            {summary === undefined ? DASH : formatPricePerContract(summary.priceAvgBp)}
          </SummaryRow>
          {guardKind === 'maxCost' && (
            <SummaryRow label={copy.tradePayout} testId={`${prefix}-summary-payout`}>
              {summary === undefined ? DASH : formatP(summary.maxPayoutP)}
            </SummaryRow>
          )}
          {guardKind === 'maxCost' && (
            <SummaryRow label={copy.tradeProfit} testId={`${prefix}-summary-profit`}>
              {summary === undefined ? DASH : formatP(summary.profitP)}
            </SummaryRow>
          )}
          <SummaryRow label={copy.tradeAfterProb} testId={`${prefix}-summary-after`}>
            {summary === undefined ? DASH : formatBp(summary.priceAfterBp)}
          </SummaryRow>
          <SummaryRow
            label={guardKind === 'maxCost' ? copy.tradeMaxCost : copy.tradeMinProceeds}
            testId={`${prefix}-summary-guard`}
          >
            {summary === undefined ? DASH : formatP(summary.guardP)}
          </SummaryRow>
        </DataList.Root>
      </Skeleton>

      {/* The server's own verdict, never a client-side price comparison: exact bp equality is
          satisfied after any trade by anyone, so a client badge would be permanently on. */}
      {view.kind === 'reconfirm' && (
        <Alert.Root status="warning" role="status" data-testid={`${prefix}-reconfirm`}>
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{copy.tradeReconfirm}</Alert.Title>
            <Alert.Description>
              {`${copy.tradePrevious} ${formatP(view.previousAmountP)} → ${formatP(view.summary.amountP)}`}
            </Alert.Description>
          </Alert.Content>
        </Alert.Root>
      )}

      {/* No confirmation modal (PLAN 11.4: 확인 버튼 → 성공 토스트). The summary is above it and
          the button carries the number, so the press is informed; a trade is undone by selling. */}
      {cta.kind === 'login' ? (
        <Button asChild width="full" size="lg" data-testid={`${prefix}-login`}>
          <NextLink href={{ pathname: '/login', query: { next: pathname } }}>
            {copy.tradeLoginToTrade}
          </NextLink>
        </Button>
      ) : cta.kind === 'charge' ? (
        <Button asChild width="full" size="lg" data-testid={`${prefix}-charge`}>
          <NextLink href="/wallet">{copy.tradeCharge}</NextLink>
        </Button>
      ) : (
        <Button
          width="full"
          size="lg"
          loading={cta.kind === 'pending'}
          disabled={cta.kind === 'disabled' || cta.kind === 'pending'}
          onClick={panel.press}
          data-testid={`${prefix}-submit`}
        >
          {pressAmountP === undefined ? sideLabel : `${sideLabel} · ${formatP(pressAmountP)}`}
        </Button>
      )}
    </Stack>
  );

  /*
   * `unmountOnExit` is load-bearing, not tidiness: without it both `Tabs.Content` bodies stay in
   * the DOM and one panel carries two `${prefix}-value` fields, which is exactly the ambiguity
   * the prefix exists to remove. Chakra's tabs recipe puts no animation on the content slot, so
   * the exiting body leaves in the same commit the entering one arrives in — there is no window
   * where both are mounted.
   */
  return (
    <Tabs.Root
      fitted
      lazyMount
      unmountOnExit
      value={inputs.side}
      onValueChange={(details) => {
        panel.chooseSide(details.value === 'sell' ? 'sell' : 'buy');
      }}
      data-testid={`${prefix}-panel`}
    >
      <Tabs.List>
        <Tabs.Trigger value="buy" disabled={panel.submitting} data-testid={`${prefix}-side-buy`}>
          {copy.tradeBuy}
        </Tabs.Trigger>
        <Tabs.Trigger value="sell" disabled={panel.submitting} data-testid={`${prefix}-side-sell`}>
          {copy.tradeSell}
        </Tabs.Trigger>
      </Tabs.List>
      <Tabs.Content value="buy">{form}</Tabs.Content>
      <Tabs.Content value="sell">{form}</Tabs.Content>
    </Tabs.Root>
  );
}

function SummaryRow({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <DataList.Item>
      <DataList.ItemLabel>{label}</DataList.ItemLabel>
      <DataList.ItemValue fontWeight="medium" data-testid={testId}>
        {children}
      </DataList.ItemValue>
    </DataList.Item>
  );
}

/**
 * The message that belongs under the amount field: the phases that are a refusal ABOUT the number
 * that was typed, or about the quote that number asked for. Everything else is either a phase the
 * button already shows (quoting, submitting, session_pending) or a refusal the server answered,
 * which `send` toasts. One `switch`, so a new phase cannot silently render nothing.
 */
function fieldError(view: TradeView): string | undefined {
  switch (view.kind) {
    case 'invalid':
      return view.message;
    case 'quote_failed':
      return view.message;
    case 'too_small':
      return copy.errTradeTooSmall;
    case 'no_position':
      return copy.errTradeNoPosition;
    case 'over_position':
      return copy.errTradePosition;
    case 'short':
      return copy.errTradeBalance;
    default:
      return undefined;
  }
}

/**
 * What 최대 fills in, or `undefined` when there is no ceiling to offer. A sell is capped by the
 * contracts actually held; a spend-mode buy by the available balance. Buying a COUNT has no
 * ceiling this side of a quote, so the chip is absent there rather than disabled — and the value
 * still goes through `setValue`, which is the only thing that bounds it.
 */
function maxValueFor(panel: TradePanelState): string | undefined {
  if (panel.inputs.side === 'sell') {
    const held = panel.heldQty;
    return held === undefined || held <= 0 ? undefined : String(held);
  }
  if (panel.inputs.mode !== 'spend') return undefined;
  const available = panel.availableP;
  return available === undefined || available <= 0n ? undefined : available.toString();
}
