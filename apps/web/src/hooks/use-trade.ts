'use client';

import { type Outcome, supersedes } from '@buddha/shared';
import {
  type QueryClient,
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useRef } from 'react';
import {
  type Market,
  type MarketStats,
  type Me,
  type Position,
  type QuoteBody,
  type QuoteResult,
  type TradeBody,
  type TradeResult,
  api,
  isApiError,
  isForAnotherAccount,
  unwrap,
} from '@/lib/api';
import { useSession } from '@/lib/use-session';
import { IdempotencyKeys } from '@/lib/idempotency';
import {
  MARKETS_KEY,
  ORDERS_KEY,
  POSITIONS_KEY,
  marketFillsKey,
  marketKey,
  quoteMarketKey,
  quoteQueryKey,
} from '@/lib/market-keys';
import { type MarketPages, type MarketTickPatch, applyTick, applyToPages } from '@/lib/market-live';
import { ME_QUERY_KEY } from './use-me';
import { positionsKey } from './use-portfolio';

/**
 * The trade panel's data layer (design 4-5): pricing a trade, sending it, and writing what the
 * server answered into every cache that shows it.
 *
 * Nothing here decides what the panel renders — `lib/trade-panel.ts` does, as a pure function —
 * and nothing here formats a string. The three decisions that DO live here are the ones about
 * the cache: which key a quote is filed under (which is the whole race fix), which key an
 * `Idempotency-Key` is filed under, and what a `TradeResult` is allowed to write.
 *
 * Every cache writer is exported apart from its hook, because `apps/web` runs vitest under
 * `environment: 'node'`: a decision left inside a component or a hook body is a decision no
 * unit test can reach (the rule stated in `use-admin-markets.ts`).
 */

// ---- quoting ------------------------------------------------------------------------

/**
 * The panel re-quotes at most once a second while the market keeps moving under a shown price.
 * At most one quote query is active at a time, so this bounds the busiest market to one extra
 * `POST /quotes` per second — and the request is public and side-effect free.
 */
export const REQUOTE_THROTTLE_MS = 1_000;

/**
 * `POST /quotes` for one intent. Every input of the quote is in its key (`quoteQueryKey`), and
 * that IS the fix for the typing race: a response for terms the trader has already typed past
 * is written into its own entry and never read, because an observer only ever publishes the key
 * it currently asks for. So there is no `AbortController` and no sequence ref anywhere.
 *
 * `keepPreviousData` keeps the previous numbers on screen instead of flashing a skeleton between
 * keystrokes, and the one hazard it introduces is closed by the panel reading
 * `q.isPlaceholderData ? undefined : q.data`: `ready` and the wire body can never be built from
 * another intent's numbers, and clearing the field clears the summary.
 *
 * `staleTime: 0` because this is a price — the client's 30s default would freeze it — while
 * `gcTime` is short because typing mints keys that must evict, and `retry: false` because a
 * refused quote is answered by the market's own state (마감, 종료), which retrying cannot change.
 */
export function quoteQueryOptions(body: QuoteBody | undefined) {
  return {
    queryKey: quoteQueryKey(body),
    queryFn: async (): Promise<QuoteResult> => {
      // Unreachable while `enabled` honours the same condition; refusing beats posting a body
      // the schema would reject and calling the 400 a quote failure.
      if (body === undefined) throw new Error('quote requested without a body');
      return unwrap(await api.POST('/api/v1/quotes', { body })).data;
    },
    enabled: body !== undefined,
    staleTime: 0,
    gcTime: 60_000,
    retry: false,
    placeholderData: keepPreviousData,
  };
}

/** `undefined` parks on one idle key rather than minting an entry the panel cannot ask for. */
export function useQuote(body: QuoteBody | undefined) {
  return useQuery(quoteQueryOptions(body));
}

// ---- submitting ---------------------------------------------------------------------

/**
 * `POST /trades`. Copies `useCharge`'s idempotency discipline (`use-wallet.ts`) with one
 * intent and one settle rule changed.
 *
 * The intent is the MARKET ID (design 5.1): two presses on the same terms while the first
 * answer is lost send the same key and the API replays the first order instead of trading
 * twice, and a user who gives up waiting, edits the amount and presses again also sends that
 * key — earning a 409 DUPLICATE_REQUEST rather than a second order on top of one that may
 * already have filled. A key derived from the terms would mint a new key for exactly that
 * second press, which is the case it exists to prevent.
 *
 * The key is settled on every answered status except one: a 403 naming `expectedAccountId`
 * means the server judged the COOKIE, not the key — spending it would throw away the replay
 * this account may still be waiting on. A 5xx and a transport failure keep it too
 * (`IdempotencyKeys.settle` ignores >= 500). Unlike a charge there is no in-flight 409 to keep
 * it for: a trade's DUPLICATE_REQUEST always means "same key, other terms".
 *
 * `onDone` fires BEFORE the cache work so the toast and the closing sheet are instant, and the
 * cache work is awaited so the CTA stays disabled (`isPending`) until the fresh numbers land —
 * the `useCharge` precedent, and what keeps a second press from being priced on stale state.
 */
export function useTrade(market: Pick<Market, 'id'>, onDone?: (result: TradeResult) => void) {
  const queryClient = useQueryClient();
  // The account the panel shows rides along as `expectedAccountId` (Q-M3-5) and files the key.
  // Until better-auth has said whose session this is there is no account to file under, so
  // `ready` is false and the CTA stays disabled rather than sending an unfiled key.
  const { data: session, refetch: refetchSession } = useSession();
  const accountId = session?.user.id;
  // A ref, not useMemo: React may drop a memo, and with a throwing storage the handle's
  // in-memory fallback IS the key. Resolved at call time, so no ref is touched during render.
  const handle = useRef<{ account: string; keys: IdempotencyKeys } | null>(null);
  const keysFor = (account: string): IdempotencyKeys => {
    if (handle.current?.account !== account) {
      // Namespaced apart from the charge keys: the two flows settle by different rules, so
      // neither may spend a key the other is still waiting to replay (design 5.2).
      handle.current = { account, keys: new IdempotencyKeys(account, undefined, 'trade-key') };
    }
    return handle.current.keys;
  };
  const mutation = useMutation({
    mutationFn: async (body: TradeBody) => {
      // Unreachable while the CTA honours `ready`.
      if (!accountId) throw new Error('trade attempted before the session was known');
      const keys = keysFor(accountId);
      const result = await api.POST('/api/v1/trades', {
        params: { header: { 'Idempotency-Key': keys.take(market.id) } },
        body,
      });
      let data: TradeResult;
      try {
        data = unwrap(result).data;
      } catch (error) {
        if (!isForAnotherAccount(error)) keys.settle(market.id, result.response.status);
        throw error;
      }
      keys.settle(market.id, result.response.status);
      return data;
    },
    // The account the request LEFT as, carried to `onSuccess` as its context. It cannot be
    // read back from `mutationFn`: that answers the `TradeResult`, which names an order and a
    // market but never the account the server judged.
    onMutate: () => ({ account: accountId }),
    onSuccess: async (result, _body, sent) => {
      // A trade answers for the account that SENT it, and this tab may no longer BE that
      // account: nothing cancels an in-flight POST, so a sign-out and a sign-in as somebody
      // else — in this tab or broadcast from another one — lands A's balance, A's position row
      // and A's 매수 완료 toast on B's screen, on top of the caches `SessionCacheGuard` has
      // just reset for B. The refetches that follow would usually paper over it; if one of
      // them fails, B keeps reading A's numbers with nothing left to correct them.
      //
      // The comparison is sound because query-core hands a PENDING mutation the newest options
      // on every render (`MutationObserver.setOptions`), so this closure's `accountId` is the
      // account the tab currently shows rather than the one it showed when the CTA was pressed.
      if (sent.account !== accountId) {
        // The market itself is nobody's: a trade moved its probability and added a fill
        // whatever the cache belongs to now, and dropping that would leave the screen behind
        // for a reason that has nothing to do with the market.
        await applyTradeMarket(queryClient, result);
        return;
      }
      onDone?.(result);
      await applyTradeResult(queryClient, result);
    },
    // Design 5.5's table: every refusal corrects the cache it contradicts, and the panel then
    // re-derives through `tradePanelView` from the corrected cache. That is why there is
    // exactly one code path that renders 충전하기 and one that renders 마감, whether the
    // shortfall was seen before the request or only after it. Awaited like `useCharge`'s, so
    // the button stays disabled until the corrected numbers have landed.
    onError: async (error) => {
      if (isApiError(error, 'PRICE_MOVED')) {
        // The panel enters its reconfirm phase; both the price it showed and the quote behind
        // it are now known to be behind the market.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: quoteMarketKey(market.id) }),
          queryClient.invalidateQueries({ queryKey: marketKey(market.id) }),
        ]);
        return;
      }
      if (isApiError(error, 'INSUFFICIENT_BALANCE')) {
        await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
        return;
      }
      if (isApiError(error, 'INSUFFICIENT_POSITION')) {
        await queryClient.invalidateQueries({ queryKey: POSITIONS_KEY });
        return;
      }
      if (isApiError(error, 'DUPLICATE_REQUEST')) {
        // Same key, other terms: an earlier press may well have traded, so the balance and the
        // position on screen are behind what the server holds. The key is already spent.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }),
          queryClient.invalidateQueries({ queryKey: POSITIONS_KEY }),
        ]);
        return;
      }
      // The cookie belongs to another account, or to nobody: have better-auth refetch, so
      // SessionCacheGuard resets the caches and the CTA flips to 로그인. Nothing traded, and
      // the key stayed in the on-screen account's namespace (see mutationFn). A FORBIDDEN
      // that names no field is CSRF and corrects nothing.
      if (isForAnotherAccount(error) || isApiError(error, 'UNAUTHENTICATED')) {
        void refetchSession();
        return;
      }
      // The market itself moved on: 마감, 종료, or gone from the public routes entirely. Only
      // the market this panel trades — the id is canonical (A-M3-29), so the key is knowable.
      if (
        isApiError(error, 'MARKET_CLOSED') ||
        isApiError(error, 'MARKET_NOT_OPEN') ||
        isApiError(error, 'NOT_FOUND')
      ) {
        await queryClient.invalidateQueries({ queryKey: marketKey(market.id) });
      }
    },
  });
  return { ...mutation, ready: accountId !== undefined };
}

// ---- what a TradeResult writes ------------------------------------------------------

/**
 * Seed what the answer carries, then invalidate what it does not — in ONE synchronous block,
 * because an `await` between them would let a GET that started before the trade land on top of
 * the seed instead of being cancelled by the invalidation (the `applyMarket` precedent).
 *
 * The seed is not an optimisation. An `Idempotency-Key` replay publishes NO realtime event at
 * all (the API only publishes for the transaction that actually traded), and a trade by this
 * tab is answered before its own `market:tick` arrives, so `TradeResult` is the PRIMARY path
 * for the balance chip, the position row and the probability — the socket is the second path,
 * for what other people do.
 *
 * The refetches that follow are the tie-breaker the balance cannot get any other way: REST
 * `Balance` carries no `ledgerEntryId` (Q-M3-8(2)), so this seed cannot be ordered against a
 * `user:balance` event the way the market and the position can be ordered against theirs.
 */
export function applyTradeResult(queryClient: QueryClient, result: TradeResult): Promise<void> {
  // Never invents a `Me` for a visitor the cache does not hold one for: `setQueryData` returns
  // early on an updater that answers undefined, so a logged-out tab gains no session state.
  queryClient.setQueryData<Me>(ME_QUERY_KEY, (me) => {
    if (me === undefined) return undefined;
    return { ...me, balance: result.balance };
  });
  applyPositionRow(queryClient, result.position);
  // Evaluated here rather than inside the array below so the whole synchronous block reads in
  // the order it runs: every seed, then every invalidation.
  const market = applyTradeMarket(queryClient, result);
  return Promise.all([
    market,
    queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: POSITIONS_KEY }),
    queryClient.invalidateQueries({ queryKey: ORDERS_KEY }),
  ]).then(() => undefined);
}

/**
 * The half of a `TradeResult` that belongs to nobody: the market's own stats, and the 체결
 * 내역 the fill was added to.
 *
 * Split out because it is the ONLY half a tab may still write once it has moved to another
 * account (see `useTrade`'s `onSuccess`). Both writes are keyed by `result.market.id` and
 * neither reads the session: a market moved because SOMEBODY traded, and which account that
 * was is what the private half above is about.
 */
export function applyTradeMarket(queryClient: QueryClient, result: TradeResult): Promise<void> {
  applyMarketStats(queryClient, result.market);
  return queryClient.invalidateQueries({ queryKey: marketFillsKey(result.market.id) });
}

/**
 * `TradeResult.market` into every cached copy of that market: the detail entry and every
 * filtered list page.
 *
 * `MarketStats` carries exactly the five fields a `market:tick` carries, under `id` where the
 * event says `marketId`, so remapping it here lets the trade answer and the socket handler
 * share ONE reducer — and therefore one `supersedes(tradeCount)` rule, which is what makes
 * whichever of the two arrives second a no-op instead of a rollback.
 *
 * The detail key is exact rather than searched, because it is always the row's canonical
 * lower-cased uuid (A-M3-29) and `MarketStats.id` is that same string. The lists are searched:
 * `setQueriesData` matches by prefix and creates nothing, so a filter that is not cached costs
 * no entry and a market that is in no cached page costs no write.
 */
export function applyMarketStats(queryClient: QueryClient, stats: MarketStats): void {
  const patch: MarketTickPatch = {
    marketId: stats.id,
    pYesBp: stats.pYesBp,
    lastPrice: stats.lastPrice,
    volumeP: stats.volumeP,
    tradeCount: stats.tradeCount,
  };
  queryClient.setQueryData<Market>(marketKey(stats.id), (held) => applyTick(held, patch));
  queryClient.setQueriesData<MarketPages>({ queryKey: MARKETS_KEY }, (held) =>
    applyToPages(held, (row) => applyTick(row, patch)),
  );
}

/**
 * `TradeResult.position` into the cached open-positions list — the one 내 포지션 and the
 * portfolio's 보유 포지션 both read.
 *
 * Only that list: a trade cannot produce a settled row (`assertTradable` refuses every status
 * but `open`), so prepending its answer into a cached `['positions', 'settled']` would put an
 * unsettled row in 정산 이력 until the next fetch. `setQueriesData` writes only where an entry
 * already exists, so a screen that never asked for the list pays nothing, and the awaited
 * `POSITIONS_KEY` invalidation still refreshes every variant.
 */
export function applyPositionRow(queryClient: QueryClient, position: Position): void {
  queryClient.setQueriesData<Position[]>({ queryKey: positionsKey('open') }, (held) =>
    mergePosition(held, position),
  );
}

/**
 * One position row merged into a held list, or **undefined meaning do not write**.
 *
 * Unlike `applyPositionEvent` (market-live.ts), which may only patch a row the cache already
 * holds — a `user:position` event carries no market title, slug or status, so a row built from
 * it would be a lie the portfolio would render — a `TradeResult` carries the whole row, so the
 * first trade in a market can be appended. It goes to the FRONT because that is the order
 * `GET /me/positions` answers in (most recently changed first), so the seeded list is in the
 * same order as the refetch that follows and nothing jumps when it lands.
 *
 * Ordering is the row's own `version`, the same key the event path uses, so a trade answer and
 * a `user:position` for the same write cannot undo each other. A row that trades to zero is
 * kept, not dropped: `status=open` still lists it (qty may be 0 after a full sell).
 */
export function mergePosition(
  held: Position[] | undefined,
  incoming: Position,
): Position[] | undefined {
  if (held === undefined) return undefined;
  const index = held.findIndex(
    (row) => row.marketId === incoming.marketId && row.outcome === incoming.outcome,
  );
  // `findIndex` answered -1 when the row is not cached, and reading it back is undefined.
  const current = held[index];
  if (current === undefined) return [incoming, ...held];
  if (!supersedes(incoming.version, current.version)) return undefined;
  const rows = [...held];
  rows[index] = incoming;
  return rows;
}

// ---- positions ----------------------------------------------------------------------

/**
 * The account's positions, declared once in `use-portfolio.ts` and re-exported here so the
 * trade panel and 내 포지션 import one hook rather than two — the same reason
 * `use-admin-markets.ts` re-exports the keys it shares with the public screens.
 *
 * A second declaration would be a second cache entry for the same rows, and the two would
 * disagree for one round trip after every trade: `applyPositionRow` can only seed the list the
 * screen actually reads. The hook keys on `['positions', status]` and waits for the session
 * itself, so a logged-out visitor never provokes a 401.
 */
export { usePositions } from './use-portfolio';

/**
 * Contracts held of one (market, outcome) — the 매도 ceiling, and what tells 보유 없음 from
 * 아직 모름.
 *
 * `undefined` while the list is unknown (loading, or a visitor who is not signed in) is
 * deliberate and is NOT the same as 0: `tradePanelView` refuses a sell at 0 before it costs a
 * round trip, while `undefined` never blocks — the server checks the position under its own
 * lock either way, and a panel that refused on a list that had not loaded would be inventing a
 * refusal. A market with no row is a real 0.
 */
export function heldQtyOf(
  positions: Position[] | undefined,
  marketId: string,
  outcome: Outcome,
): number | undefined {
  if (positions === undefined) return undefined;
  const row = positions.find((p) => p.marketId === marketId && p.outcome === outcome);
  return row?.qty ?? 0;
}
