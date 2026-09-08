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
import { type SessionIdentity, cacheOwnerAccount } from '@/components/auth/session-cache-guard';
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
import { restartQueries } from '@/lib/query-client';
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
    onSuccess: async (result, body) => {
      // A trade answers for the account that SENT it, and this tab may no longer BE that
      // account: nothing cancels an in-flight POST, so a sign-out and a sign-in as somebody
      // else — in this tab or broadcast from another one — would land A's balance, A's
      // position row and A's 매수 완료 toast on B's screen, on top of the caches
      // `SessionCacheGuard` has just reset for B.
      //
      // The refetch that follows does NOT undo it, which is what makes the gate load-bearing
      // rather than a nicety: `joinPositions` is registered on `['positions']`
      // (query-client.ts) and keeps the HELD row wherever its `version` is the higher one.
      // Two accounts' versions are unrelated per-row counters, so A's seeded row can sit on
      // B's 매도 ceiling and B's 평가손익 until B's own version happens to pass it.
      if (
        tradeAnswerScope({
          sent: body.expectedAccountId,
          account: cacheOwnerAccount(),
          cached: queryClient.getQueryData<Me>(ME_QUERY_KEY),
        }) === 'market'
      ) {
        // The market itself is nobody's: a trade moved its probability and added a fill
        // whatever the cache belongs to now, and dropping that would leave the screen behind
        // for a reason that has nothing to do with the market.
        await applyTradeMarket(queryClient, result);
        return;
      }
      onDone?.(result);
      await applyTradeResult(queryClient, result);
    },
    // Every refusal corrects the cache it contradicts — `applyTradeError` holds the table, so
    // the decision is reachable by a test rather than sealed in this hook body. Awaited like
    // `useCharge`'s, so the CTA stays disabled until the corrected numbers have landed; the
    // session refetch is NOT awaited (`void`), because what it resolves to is a reset this tab
    // does not wait on — `SessionCacheGuard` performs it whenever the answer lands.
    onError: async (error) => {
      await applyTradeError(queryClient, market.id, error, () => void refetchSession());
    },
  });
  return { ...mutation, ready: accountId !== undefined };
}

// ---- what a TradeResult writes ------------------------------------------------------

/** Which half of a `TradeResult` a tab is still entitled to write. */
export type TradeAnswerScope = 'account' | 'market';

/**
 * Whether a trade answer still belongs to whoever is looking at this tab.
 *
 * `sent` is not a guess. The server compared `TradeBody.expectedAccountId` against the COOKIE
 * before it reserved anything (`assertExpectedAccount`), so a 2xx PROVES that string names the
 * account the trade actually moved — which `TradeResult` itself never says, carrying an order,
 * a market and a balance but no owner.
 *
 * `account` is who this TAB belongs to, from `cacheOwnerAccount()` (session-cache-guard.tsx),
 * and it is the whole answer whenever it has one. Neither of the two readings this started
 * with could be trusted alone, which is why the decision reads a third thing that is neither:
 *
 * - the account the PANEL last rendered freezes. react-query pushes fresh options into a
 *   pending mutation from an effect (`useMutation` → `MutationObserver.setOptions`), so a
 *   trader who navigates off the market while the POST hangs unmounts the panel, and the
 *   closure then keeps naming the account that pressed the button however long the tab has
 *   since belonged to somebody else. `Mutation.execute` awaits `onSuccess` with no observer
 *   left to correct it.
 * - the CACHED `Me` is empty exactly when it matters. `SessionCacheGuard` resets `['me']` on a
 *   switch, and B's `['me']` and B's `['positions']` refetch INDEPENDENTLY — so there is a
 *   window where B's holdings are loaded and B's profile is not, and an answer waved through
 *   on "no `Me` yet" lands A's row on B's list. `joinPositions` (query-client.ts) then keeps
 *   it: two accounts' `version` counters are unrelated, so B's own refetch re-applies A's
 *   numbers rather than clearing them.
 *
 * The guard is mounted above every screen for the life of the tab and publishes this from an
 * effect, so it neither freezes with a component nor empties with a cache.
 *
 * `cached` stays as the fallback for the only moment the guard cannot speak — before
 * better-auth has answered at all in this tab, which no trade of ours can be older than, but
 * a tree without the guard (a test, a future embed) can be. Holding no `Me` is not a refusal
 * there: nothing of anybody's is on screen to overwrite, and refusing would swallow the 체결
 * toast for a trader whose own `GET /me` merely has not landed yet.
 *
 * `market` rather than nothing at all: a market moved because SOMEBODY traded and a fill was
 * added to 체결 내역, whoever the tab belongs to now.
 */
export function tradeAnswerScope(a: {
  sent: string;
  account: SessionIdentity | undefined;
  cached: Me | undefined;
}): TradeAnswerScope {
  if (a.account !== undefined) return a.account === a.sent ? 'account' : 'market';
  if (a.cached !== undefined && a.cached.id !== a.sent) return 'market';
  return 'account';
}

/**
 * Design 5.5's table: every refusal corrects the cache it contradicts, and the panel then
 * re-derives through `tradePanelView` from the corrected cache. That is why there is exactly one
 * code path that renders 충전하기 and one that renders 마감, whether the shortfall was seen
 * before the request or only after it. The caller awaits it, so the CTA stays disabled until the
 * corrected numbers have landed (the `useCharge` precedent).
 *
 * The asymmetry between the branches is the load-bearing part. `restartQueries` is only for the
 * answer that PROVES something committed: a refusal that traded nothing leaves a first fetch's
 * in-flight snapshot perfectly good, and cancelling it would buy a second request for an answer
 * that was never stale.
 *
 * Exported apart from the hook for the reason the file header gives: a decision left inside a
 * mutation callback is a decision this app's node-only vitest cannot reach.
 */
export async function applyTradeError(
  queryClient: QueryClient,
  marketId: string,
  error: unknown,
  onSessionChanged: () => void,
): Promise<void> {
  if (isApiError(error, 'PRICE_MOVED')) {
    // The panel enters its reconfirm phase; both the price it showed and the quote behind
    // it are now known to be behind the market.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: quoteMarketKey(marketId) }),
      queryClient.invalidateQueries({ queryKey: marketKey(marketId) }),
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
    //
    // `restartQueries`, for the reason the success path uses it: this answer PROVES the key
    // was already spent, so a first fetch still in flight may have taken its snapshot before
    // that trade — and a bare invalidation subscribes to the request already running rather
    // than issuing one. The refusals above need no such thing: they mean nothing committed,
    // so a snapshot from before the request is not stale.
    //
    // `['orders']` for the same proof, and this is the one branch that HAS it: `replay()` is
    // reached only after an order row for this key was FOUND (trade.service.ts), which is the
    // very thing `applyTradeResult` restarts the list on. There is no 주문 이력 observer on a
    // screen that trades, so the default `refetchType: 'active'` only marks it stale.
    await Promise.all([
      restartQueries(queryClient, ME_QUERY_KEY),
      restartQueries(queryClient, POSITIONS_KEY),
      restartQueries(queryClient, ORDERS_KEY),
    ]);
    return;
  }
  // The cookie belongs to another account, or to nobody: have better-auth refetch, so
  // SessionCacheGuard resets the caches and the CTA flips to 로그인. Nothing traded, and
  // the key stayed in the on-screen account's namespace (see mutationFn). A FORBIDDEN
  // that names no field is CSRF and corrects nothing.
  if (isForAnotherAccount(error) || isApiError(error, 'UNAUTHENTICATED')) {
    onSessionChanged();
    return;
  }
  // The market itself moved on: 마감, 종료, or gone from the public routes entirely. Only
  // the market this panel trades — the id is canonical (A-M3-29), so the key is knowable.
  if (
    isApiError(error, 'MARKET_CLOSED') ||
    isApiError(error, 'MARKET_NOT_OPEN') ||
    isApiError(error, 'NOT_FOUND')
  ) {
    await queryClient.invalidateQueries({ queryKey: marketKey(marketId) });
  }
}

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
  // `restartQueries`, not a bare invalidation: the seeds above wrote NOTHING into a cache that
  // held nothing, so a list still on its first fetch would otherwise wait on the request that
  // left before this trade.
  return Promise.all([
    market,
    restartQueries(queryClient, ME_QUERY_KEY),
    restartQueries(queryClient, POSITIONS_KEY),
    restartQueries(queryClient, ORDERS_KEY),
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
  // `restartQueries` for symmetry with the socket path rather than because it bites: the fills
  // list is never seeded (`seedMarketDetail` carries the market and the ticks), so a bare
  // invalidation would wait on the request that left before this fill — but reaching it takes a
  // trade submitted while 체결 내역 is still on its FIRST fetch, which is a press within a
  // moment of mount. It costs nothing and leaves no invalidation of an unseeded key on the
  // shape this repo has twice had to correct.
  return restartQueries(queryClient, marketFillsKey(result.market.id));
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
    traderCount: stats.traderCount,
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
