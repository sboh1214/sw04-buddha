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
import { tickingNow } from '@/lib/datetime';
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
  maxValueFor,
  quoteIsStale,
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

/**
 * The 마감 gate's clock, at `CountdownBadge`'s own cadence (`countdown-badge.tsx` TICK_MS): the
 * badge above this panel and the panel itself must flip within the same second, or the header
 * says 마감됨 over live 예/아니오 buttons.
 */
const CLOCK_TICK_MS = 1000;

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
  // panel wants from it — the staleness signal, and the floor under the 마감 clock below.
  const marketQuery = useMarket(market.id);
  const marketUpdatedAt = marketQuery.dataUpdatedAt;

  /*
   * The clock the 마감 gate reads, and it has to TICK. `dataUpdatedAt` — the instant the SERVER
   * last answered for this market — only moves when something WRITES the `['market', id]` cache,
   * and M4 ships no close job (that is M5), so on a market nobody is trading it stays pinned at
   * the load instant: the header's `CountdownBadge` runs its own 1s interval and would say 마감됨
   * over a panel still offering 예/아니오 and quoting a market that can no longer trade.
   *
   * `Date.now()` is still never read during a render: this client component also renders on the
   * server, where a browser-read instant is both a hydration mismatch on the page AC 2 measures
   * and a `react-hooks/purity` error. The first render answers `dataUpdatedAt` alone — it rides
   * the dehydrated payload, so the SSR render and its hydration agree byte for byte — and the
   * interval takes over from the first browser frame, exactly as the badge does.
   *
   * The browser is asked only for a DURATION, never for an instant: `tickingNow` adds a monotonic
   * elapsed to the server's anchor. `Math.max(anchor, Date.now())` was not a repair — the two
   * numbers come from different machines, and `closeAt` is the server's — so a browser running
   * BEHIND stayed pinned at the anchor and went on offering trades in a closed market, while one
   * running AHEAD won the max outright and drew 마감 over a market still open. See `tickingNow`
   * for which half is worse and what the fix does not recover.
   *
   * The ANCHOR is captured once, at the first render, and deliberately not refreshed: only the
   * SSR-hydrated `dataUpdatedAt` is a server instant. query-core restamps it with the BROWSER's
   * clock on every later success — a refetch, and every `market:tick` the socket writes — so
   * re-anchoring would quietly put the skew back (measured: hydrate keeps the server stamp,
   * refetch and `setQueryData` do not).
   *
   * The last word belongs to `assertTradable` on the database clock anyway (A-M3-16) — a refusal
   * arrives as MARKET_CLOSED and renders through the same string.
   */
  const [anchor] = useState(marketUpdatedAt);
  const [clock, setClock] = useState<number | undefined>(undefined);
  // The monotonic origin the elapsed is measured from. A ref and not state: written inside the
  // effect and read only there, so no render touches it (`react-hooks/refs` is an error).
  const originRef = useRef<number | undefined>(undefined);
  const now = clock ?? anchor;
  const tradable = isTradable(market, now);
  useEffect(() => {
    // Nothing left to watch once the market cannot be traded: the panel has replaced itself with
    // the 마감 notice, and only a cache write can undo that — which moves `marketUpdatedAt` on
    // its own.
    if (!tradable) return;
    // `setClock` is called from a timer callback and never synchronously in the effect body: the
    // second form is what `react-hooks/set-state-in-effect` refuses. The zero-delay timeout no
    // longer CORRECTS anything — at elapsed 0 it answers the anchor itself — but it still starts
    // the clock on the first browser frame rather than up to a second later, which is what keeps
    // this and the badge stepping together.
    // `performance.now()` and not `Date.now()`: the elapsed has to survive an NTP step, which is
    // the very moment a wall-clock delta would jump. Read in the callback, never in a render.
    //
    // Measured from an origin captured ONCE for this panel — `??=`, so an effect re-run cannot
    // restart it and rewind the gate to the page-load anchor (an admin extending `closeAt` on an
    // expired market is ordinary, A-M3-31). NOT `performance.now()` bare: bare is the DOCUMENT's
    // age, and a `next/link` navigation keeps the document, so a panel reached from the grid
    // would add the visitor's whole browsing session to the anchor and draw 마감 over an open
    // market — the worse half of the very hazard this fix exists to remove. See `tickingNow`.
    originRef.current ??= performance.now();
    const startedAt = originRef.current;
    const tick = () => {
      setClock(tickingNow(anchor, performance.now() - startedAt, Date.now()));
    };
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, CLOCK_TICK_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [tradable, anchor]);

  // PLAN 11.4's 300ms, on the typed amount ONLY. 매수/매도, 예/아니오 and the mode reach the
  // quote key undebounced, so a discrete tap re-prices instantly (design 4.2).
  const settledValue = useDebouncedValue(inputs.value, QUOTE_DEBOUNCE_MS);
  // The ONE intent everything below describes. The field runs up to `QUOTE_DEBOUNCE_MS` ahead of
  // this value, and the two are never mixed: `tradePanelView` is handed `quotedValue` and holds
  // the panel in `quoting` — disabled, dimmed — until they agree again, so the quote, the
  // summary, the disclosed slippage guard and the wire body all price the same amount.
  const quoteInputs = { ...inputs, value: settledValue };
  const quoteBody = quoteRequest(market.id, quoteInputs, tradable);
  const quoteQuery = useQuote(quoteBody);
  // The whole race fix in one line (design 4.1): every input is in the query key, so a late
  // answer lands on its own entry, and placeholder data — which belongs to an intent the trader
  // has already typed past — may dim the summary but must never build a wire body.
  const quote = quoteQuery.isPlaceholderData ? undefined : quoteQuery.data;
  /**
   * Whether the market has moved under the price on screen — by the market's own REVISION, not
   * by two clocks.
   *
   * It used to compare `marketUpdatedAt` with the quote's `dataUpdatedAt`, and those are stamped
   * by different machines: the SSR-seeded market carries the value the WEB SERVER wrote, which
   * hydration copies into the browser cache verbatim, while a quote answered afterwards carries
   * `Date.now()` in the BROWSER. On a device whose clock runs behind the server, every fresh
   * quote therefore looked older than the market it had just been priced from — the summary
   * stayed dimmed and the effect below re-quoted on its throttle until real time caught up with
   * the skew. `QuoteResult.tradeCount` is the counter the answer was priced at, and `market`
   * carries the same counter kept newest by `joinMarket`, so both sides come from one sequence.
   */
  const stale = quoteIsStale(market, quote);

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
    quotedValue: settledValue,
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
   * cache — a `market:tick`, this tab's own trade answer, a background refetch — raises the row's
   * `tradeCount` past the one the quote was priced at, and one throttled invalidation re-prices
   * the single active quote. At most one quote query exists, so this is <= 1 `POST /quotes` per
   * second on the busiest market, and the request is public and side-effect free.
   *
   * Suppressed while a submit is in flight or a re-confirm is pending, so the guard that is sent
   * is the guard the user read. The two COUNTERS are the dependencies rather than the derived
   * boolean: every tick has to re-enter this effect, and a boolean that stays true would never
   * re-fire it.
   *
   * A run the throttle turns away is ARMED, not dropped. The last tick of a burst is the one that
   * matters and there is no later event to retry on — once the market goes quiet nothing changes
   * a dependency again — so the invalidation runs itself when the window expires. The cleanup
   * cancels it, which is also how a further tick coalesces into the same deadline instead of
   * queueing a second re-quote.
   */
  const lastRequoteAt = useRef(0);
  useEffect(() => {
    if (submitting || reconfirmFrom !== undefined) return;
    if (!quoteIsStale(market, quote)) return;
    const requote = () => {
      lastRequoteAt.current = Date.now();
      void queryClient.invalidateQueries({
        queryKey: quoteMarketKey(market.id),
        refetchType: 'active',
      });
    };
    const wait = REQUOTE_THROTTLE_MS - (Date.now() - lastRequoteAt.current);
    if (wait <= 0) {
      requote();
      return;
    }
    const timer = setTimeout(requote, wait);
    return () => {
      clearTimeout(timer);
    };
  }, [market, quote, submitting, reconfirmFrom, queryClient]);

  // While a new quote is in flight the previous numbers stay on screen instead of flashing a
  // skeleton — the same summary the machine builds, from the answer the query still holds,
  // marked stale so it is dimmed and can never be pressed on (`tradeCta` of `quoting` is
  // disabled). Built from `quoteInputs`, never from the field: inside the debounce window that
  // pair is exactly the intent the held answer was asked for. Once the window has fired the held
  // answer is `keepPreviousData`'s placeholder from the amount before it, so these rows are an
  // approximation of numbers already on screen — which is the only reason they may be shown at
  // all, and why nothing here can become a wire body.
  const summary =
    'summary' in view
      ? view.summary
      : view.kind === 'quoting' && quoteQuery.data !== undefined
        ? tradeSummary(quoteInputs, quoteQuery.data, true)
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
    // Reaching `reconfirm` at all means the machine paired that quote with the field's own value
    // (step 6), so these two arguments cannot be two different intents.
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
  // ONLY a submit in flight locks the field. `no_position` used to be here too, and it is a
  // phase that can only be reached from a field that already holds a digit (step 3 answers
  // `empty` first), so it trapped that digit: on the 매도 tab holding nothing there is no chip,
  // no 최대 and no other control that writes the value, and a disabled input cannot be
  // backspaced either. The refusal is the `Field.ErrorText` below plus the disabled button.
  const inputDisabled = panel.submitting;
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
          `outline`, so the unselected side stays a filled affordance at AA contrast.
          Two `aria-pressed` buttons are a pair only visually, so the row is a named group —
          otherwise a screen reader cannot tell it from the 매수/매도 tabs or the 입력 방식
          toggle, which are three two-option controls stacked on one card. */}
      <HStack gap="2" role="group" aria-label={copy.tradeOutcomeLabel}>
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
          could never work there, and an absent control beats a dead one.
          The `aria-label` is not optional: zag's radio-group always emits `role="radiogroup"`
          with an `aria-labelledby` pointing at the id a `SegmentGroup.Label` would carry, and
          Chakra ships no such part — so without it the group has no accessible name at all
          (the `chartRangeLabel` precedent on the chart's own range toggle). */}
      {inputs.side === 'buy' && (
        <SegmentGroup.Root
          size="sm"
          aria-label={copy.tradeModeLabel}
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
          there is no hidden tolerance and no slider. The VALUES are dimmed while they belong to
          the previous intent or the market has moved under them; a fade, never a colour flash,
          and instant for a reader who asked for less motion.
          The dimming stops at the values on purpose. `DataList` colours its labels `fg.muted`
          and `size="sm"` renders them at 12px, so 60% of that over the card is 2.90:1 — under
          AA, on the six words that say which number is which, for the whole debounce plus round
          trip of every keystroke. 60% of a value's near-black still clears 4.5:1, and what is
          stale is the numbers anyway. */}
      <Skeleton loading={panel.loadingSummary}>
        <DataList.Root orientation="horizontal" size="sm" data-testid={`${prefix}-summary`}>
          <SummaryRow
            label={copy.tradeContracts}
            testId={`${prefix}-summary-shares`}
            dim={panel.dim}
          >
            {summary === undefined ? DASH : formatContracts(summary.shares)}
          </SummaryRow>
          <SummaryRow label={copy.tradeAvgPrice} testId={`${prefix}-summary-avg`} dim={panel.dim}>
            {summary === undefined ? DASH : formatPricePerContract(summary.priceAvgBp)}
          </SummaryRow>
          {guardKind === 'maxCost' && (
            <SummaryRow
              label={copy.tradePayout}
              testId={`${prefix}-summary-payout`}
              dim={panel.dim}
            >
              {summary === undefined ? DASH : formatP(summary.maxPayoutP)}
            </SummaryRow>
          )}
          {guardKind === 'maxCost' && (
            <SummaryRow
              label={copy.tradeProfit}
              testId={`${prefix}-summary-profit`}
              dim={panel.dim}
            >
              {summary === undefined ? DASH : formatP(summary.profitP)}
            </SummaryRow>
          )}
          <SummaryRow
            label={copy.tradeAfterProb}
            testId={`${prefix}-summary-after`}
            dim={panel.dim}
          >
            {summary === undefined ? DASH : formatBp(summary.priceAfterBp)}
          </SummaryRow>
          <SummaryRow
            label={guardKind === 'maxCost' ? copy.tradeMaxCost : copy.tradeMinProceeds}
            testId={`${prefix}-summary-guard`}
            dim={panel.dim}
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
      {/* Zag puts `role="tablist"` here and no name with it; the two triggers read 매수/매도 but
          say nothing about what the pair selects. */}
      <Tabs.List aria-label={copy.tradeSideLabel}>
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

/** The label always reads at full contrast; only the number it names fades (see the row set). */
function SummaryRow({
  label,
  testId,
  dim,
  children,
}: {
  label: string;
  testId: string;
  dim: boolean;
  children: ReactNode;
}) {
  return (
    <DataList.Item>
      <DataList.ItemLabel>{label}</DataList.ItemLabel>
      <DataList.ItemValue
        fontWeight="medium"
        opacity={dim ? 0.6 : 1}
        transition="opacity"
        _motionReduce={{ transitionDuration: '0ms' }}
        data-testid={testId}
      >
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
