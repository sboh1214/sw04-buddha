'use client';

import {
  REALTIME_EXCEPTION_EVENT,
  REALTIME_NAMESPACE,
  REALTIME_SUBSCRIBE_MAX,
  RESYNC_EVENT,
  type RealtimeEventType,
  type SubscribeBody,
  errorEnvelopeSchema,
  marketStatusEventSchema,
  marketTickEventSchema,
  marketTradeEventSchema,
  userBalanceEventSchema,
  userPositionEventSchema,
} from '@buddha/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  type ReactNode,
  type RefObject,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { type Socket, io } from 'socket.io-client';
import { type SessionIdentity } from '@/components/auth/session-cache-guard';
import { ME_QUERY_KEY } from '@/hooks/use-me';
import { BALANCE_HISTORY_KEYS } from '@/hooks/use-wallet';
import { listStatusOf } from '@/hooks/use-portfolio';
import { type Market, type Me, type Position } from '@/lib/api';
import { useSession } from '@/lib/use-session';
import {
  MARKETS_KEY,
  MARKET_FILLS_KEY,
  MARKET_KEY,
  ORDERS_KEY,
  POSITIONS_KEY,
  TICKS_KEY,
  marketFillsKey,
  marketKey,
} from '@/lib/market-keys';
import {
  BalanceOrder,
  type MarketPages,
  Throttle,
  applyBalanceEvent,
  applyPositionEvent,
  applyStatus,
  applyTick,
  applyToPages,
  chunkIds,
  tickRestartsMarket,
  wroteAnOrder,
} from '@/lib/market-live';
import { restartQueries } from '@/lib/query-client';
import { type CachedSeries, appendTick } from '@/lib/ticks';

/**
 * The tab's ONE Socket.IO connection (PLAN 8, 11.5): the room registry every screen drives
 * through `useMarketSocket`, and every cache write a realtime event causes.
 *
 * One socket for the whole tab rather than one per screen, because the `market:*` handlers are
 * pure cache writes keyed by `event.marketId` — registering them once is correct wherever the
 * market happens to be on screen — while `user:balance` and `user:position` have to be live on
 * every page, since the balance chip lives in Nav.
 *
 * Every write goes through the reducers in lib/market-live.ts and lib/ticks.ts, which the REST
 * answers are joined through as well (query-client.ts): one ordering rule for both deliveries,
 * so whichever arrives second is a no-op instead of a rollback. Nothing here restates a reducer.
 *
 * `market:tick` and `market:trade` have no publisher until the CLOB fills (#119); their handlers
 * stay so a fill arrives already wired.
 */

/**
 * The API origin, mirroring api.server.ts and session.server.ts — with the difference that
 * this one is read in the BROWSER: next.config.ts rewrites `/api/:path*` only, and a rewrite
 * does not proxy a WebSocket upgrade, so the socket dials the API directly (ADR-0009 →
 * ADR-0017). `withCredentials` then carries the SameSite=Lax session cookie, which needs web
 * and API to stay same-site (localhost:3000 / localhost:4000; never 127.0.0.1 for the web
 * host, ADR-0015).
 *
 * Same-site is necessary and NOT sufficient once the two are different HOSTS. The login cookie
 * is minted through the web host — the Next rewrite proxies `/api/auth/*` server-side — and a
 * cookie with no `Domain` goes back only to the host that set it, so on an `app.`/`api.` split
 * this handshake would be anonymous however same-site it is: no `user:<id>` room, and the
 * balance chip and 내 포지션 silently stop moving. `AUTH_COOKIE_DOMAIN` on the API is what
 * gives the two hosts one cookie (ADR-0017 추기); locally the two ports are one host and it
 * stays unset.
 */
const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

/** At most one fills refetch per market per second — a busy market publishes a fill per trade. */
const FILLS_INVALIDATE_MS = 1_000;

/**
 * At most one first-fetch restart per market per second (`tickRestartsMarket`).
 *
 * LEADING EDGE ONLY, unlike `refreshFills` below — do NOT copy its trailing timer in here. A
 * refused window loses nothing on this path: the request this declines to restart is still
 * running, and the moment any answer lands the row exists and every later tick is a free cache
 * write. Fills needs the trailing edge because `['market-fills', id]` has no other writer for
 * somebody else's trade, so a dropped invalidation there leaves 체결 내역 a row short.
 */
const MARKET_RESTART_MS = 1_000;

/** The public caches a reconnect re-reads; any of them may have moved during the gap. */
const SNAPSHOT_KEYS = [MARKET_KEY, MARKETS_KEY, TICKS_KEY, MARKET_FILLS_KEY] as const;
/**
 * The same for a signed-in tab. Never SSR'd, so they exist only once the client has fetched.
 *
 * `['ledger']` is here for the reason `['orders']` is: a resnapshot runs BECAUSE events were
 * missed, and a missed `user:balance` is a ledger row nothing else in this tab writes. It earned
 * the place by becoming event-driven below; before that it would have been a refetch with no
 * event behind it. `['payments']` came with it, on the same event (`BALANCE_HISTORY_KEYS`).
 */
const PRIVATE_SNAPSHOT_KEYS = [
  ME_QUERY_KEY,
  POSITIONS_KEY,
  ORDERS_KEY,
  ...BALANCE_HISTORY_KEYS,
] as const;

/** What a screen may ask of the tab's socket. */
export interface Realtime {
  join(marketIds: readonly string[]): void;
  leave(marketIds: readonly string[]): void;
}

/**
 * The context carries the REF, not the value inside it.
 *
 * `useRef` answers the same object on every render, so the context value never changes
 * identity while `.current` still tracks the live registry. That matters twice: a consumer's
 * join/leave effect does not re-run (and so does not churn the refcounts) when the socket is
 * rebuilt for a new session, and nothing has to read `.current` during render — the house rule
 * use-wallet.ts states, and what `react-hooks/refs` enforces.
 */
export type RealtimeHandle = RefObject<Realtime>;

const RealtimeContext = createContext<RealtimeHandle | null>(null);

/** The tab's realtime handle, or null when rendered outside the provider. */
export function useRealtime(): RealtimeHandle | null {
  return useContext(RealtimeContext);
}

/**
 * `market:<id>` rooms with a refcount, plus whichever socket currently carries them.
 *
 * Refcounted because the list and the detail overlap: the home grid holds a card for the
 * market the detail also shows, and whichever unmounts first must not unsubscribe the other.
 * The registry OUTLIVES the socket — a sign-in forces a new handshake, and the screens that
 * stayed mounted keep the rooms they asked for — which is why the rooms live here rather than
 * inside the effect that opens the connection.
 */
class RoomRegistry implements Realtime {
  private readonly rooms = new Map<string, number>();
  private socket: Socket | null = null;

  attach(socket: Socket): void {
    this.socket = socket;
  }

  /** Guarded by identity so a late cleanup cannot detach the socket that replaced it. */
  detach(socket: Socket): void {
    if (this.socket === socket) this.socket = null;
  }

  /**
   * Re-send every held room. Rooms are per socket id, so a reconnect makes a new one and the
   * earlier joins are gone with it — the browser mirror of the gateway's own re-subscribe duty
   * (Q-M3-7).
   */
  resubscribe(): void {
    this.emit('subscribe', [...this.rooms.keys()]);
  }

  join(marketIds: readonly string[]): void {
    const fresh: string[] = [];
    for (const marketId of marketIds) {
      const held = (this.rooms.get(marketId) ?? 0) + 1;
      this.rooms.set(marketId, held);
      if (held === 1) fresh.push(marketId);
    }
    this.emit('subscribe', fresh);
  }

  leave(marketIds: readonly string[]): void {
    const gone: string[] = [];
    for (const marketId of marketIds) {
      const held = this.rooms.get(marketId);
      // Nothing held: a `leave` without a matching `join` must neither push the count below
      // zero nor tell the gateway to drop a room this tab never joined.
      if (held === undefined) continue;
      if (held > 1) {
        this.rooms.set(marketId, held - 1);
        continue;
      }
      this.rooms.delete(marketId);
      gone.push(marketId);
    }
    this.emit('unsubscribe', gone);
  }

  /**
   * Only while connected. socket.io buffers a packet emitted on a disconnected socket and
   * replays it on the next connect, which is exactly what `resubscribe()` already does from
   * the room map — the buffered copy would be a redundant second subscribe, and a buffered
   * `unsubscribe` would arrive AFTER that re-subscribe and undo it. There is no ack to wait
   * for (MERGE-NOTES R8): the gateway answers only when it refuses, on `exception`.
   *
   * Chunked at `REALTIME_SUBSCRIBE_MAX`, because the two caps differ on purpose: one MESSAGE
   * may name 100 markets while one SOCKET may hold 200 rooms, and `subscribeBodySchema`
   * refuses an over-long message whole — the gateway joins no room at all, not even the first
   * hundred. Sending a single frame therefore did not merely lose the tail: the home grid
   * crossing 100 rooms (five 더 보기) or a portfolio with 101 positions dropped ALL of its
   * realtime, `resubscribe()` re-sent the same doomed frame on every reconnect, and a
   * refused `unsubscribe` left the socket holding rooms this registry had already released.
   */
  private emit(event: 'subscribe' | 'unsubscribe', marketIds: string[]): void {
    if (marketIds.length === 0) return;
    const socket = this.socket;
    if (socket === null || !socket.connected) return;
    for (const slice of chunkIds(marketIds, REALTIME_SUBSCRIBE_MAX)) {
      const body: SubscribeBody = { marketIds: slice };
      socket.emit(event, body);
    }
  }
}

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data: session, isPending } = useSession();
  // SessionCacheGuard's definition of "whose cache is this", reused deliberately: undefined
  // while better-auth is still asking, null for signed out, the user id otherwise.
  const answered: SessionIdentity | undefined = isPending ? undefined : (session?.user.id ?? null);
  /**
   * The last identity better-auth actually ANSWERED, held across its refetches.
   *
   * `isPending` is not a sign-out and must not cost a handshake. better-auth recomputes it as
   * `data === null` on every session refetch (client/session-atom.mjs), which is ALWAYS true
   * for a signed-out visitor, and it refetches on focus, on `visibilitychange`, on regaining
   * connectivity and on any other tab's broadcast. Keying the socket effect on the raw value
   * therefore tore the connection down and rebuilt it every time an anonymous visitor came
   * back to the tab, leaving it in no room at all for the length of a `GET /get-session` —
   * and every event published in that window reached nobody. Only a real change of ACCOUNT
   * needs a new socket, because the gateway reads the cookie once, at the handshake.
   *
   * Adjusted during render rather than in an effect (React's "adjust state when props
   * change"): the extra render is discarded before the children are touched, and the socket
   * does not have to wait a commit for an identity that is already known.
   */
  const [identity, setIdentity] = useState<SessionIdentity | undefined>(undefined);
  if (answered !== undefined && answered !== identity) setIdentity(answered);
  // Built during render because a descendant's join effect runs BEFORE this component's effect
  // (effects fire child-first), so the registry has to exist by then. Never read here.
  const registry = useRef<RoomRegistry>(new RoomRegistry());
  /**
   * Whether this TAB has ever been connected — deliberately not "this socket", which is what a
   * `let` inside the effect measured. A socket is rebuilt whenever the account changes, and
   * the events published while the old one was gone are gone with it, so the rebuilt socket's
   * FIRST connect is still the tab's second and must re-snapshot. A ref, not state: nothing
   * renders from it.
   */
  const bootstrapped = useRef(false);

  useEffect(() => {
    // Never open an anonymous handshake first: the gateway reads the cookie ONCE, at the
    // handshake, so a socket opened before better-auth answered would never join `user:<id>`
    // and the balance chip would stay silent for the life of that connection. For the same
    // reason `identity` is a dependency — a sign-in or a sign-out must produce a NEW socket.
    if (identity === undefined) return;
    const rooms = registry.current;
    const socket = io(`${API_URL}${REALTIME_NAMESPACE}`, {
      withCredentials: true,
      // websocket first, polling only as the fallback: the upgrade dance costs a round trip
      // this app never needs, while polling still works behind a proxy that refuses upgrades.
      transports: ['websocket', 'polling'],
      // Without this the fallback above is dead code: engine.io-client only walks the
      // `transports` list inside `if (this.opts.tryAllTransports && ...)` (socket.js
      // `_onError`), and the option defaults to false — "the client will not test the other
      // transports and will abort the connection". A refused upgrade would then fail, the
      // Manager would reconnect with a fresh engine that starts at transports[0] again, and
      // the client the server keeps polling enabled for would never reach it.
      tryAllTransports: true,
    });
    rooms.attach(socket);

    // Both are per connection: the events they order belong to the socket that delivered them,
    // so a rebuilt socket starts from nothing seen and nothing spent.
    const balanceOrder = new BalanceOrder();
    const fills = new Throttle(FILLS_INVALIDATE_MS);
    // Per connection like the two above: a rebuilt socket starts with nothing spent, because the
    // window bounds requests made ON BEHALF of this connection's events.
    const marketRestart = new Throttle(MARKET_RESTART_MS);
    /**
     * The fills throttle's trailing-edge timers, one per market, cancelled with the socket.
     * The value is the canceller rather than the handle so nothing here has to name the type
     * of a timer: `lib.dom` and `@types/node` are both in scope and disagree about it.
     */
    const fillsPending = new Map<string, () => void>();

    /**
     * PLAN 8's "클라이언트 재연결 시 스냅샷 재요청", once per gap rather than once per event.
     * `refetchType: 'active'` so only mounted observers refetch and the rest merely go stale
     * ("refetch 남발 금지"); safe against an event landing mid-refetch, because the
     * `structuralSharing` join registered in query-client.ts keeps every market write monotone.
     *
     * EVERY key restarts rather than merely invalidating, and on this path the reason is not
     * the usual one. A bare invalidation is swallowed whole by a query still on its FIRST fetch
     * — query-core hands back the request already running — and here that request is precisely
     * the one that must not be accepted: a resnapshot runs BECAUSE events were missed, so an
     * answer that left before the gap is the stale thing it exists to replace. Waiting on it
     * ends the recovery having recovered nothing, and the caller cannot tell, because the
     * `success` dispatch clears `isInvalidated` on the way past.
     *
     * It was briefly a special case for `['market-fills']` alone, on the grounds that the other
     * keys are seeded or have a second writer. That was the wrong reading twice over: every
     * private key first-fetches on an ORDINARY page load (they are never dehydrated), and the
     * argument was about how likely the loss is rather than whether the recovery is honest.
     * The special case bought nothing either — `cancelFirstFetch` cancels only a query with NO
     * data, so on a seeded or already-answered key `restartQueries` IS the plain invalidation.
     */
    const resnapshot = () => {
      // The balance watermark is NOT reset here, and that is the fix rather than an omission.
      // `ledger_entries.id` is a bigserial drawn while the account's balance row is held
      // FOR UPDATE (wallet.service.ts and the admin and settle paths), so for one
      // account it is commit order — a property of the ACCOUNT, not of the socket that happened
      // to deliver it. Clearing it on every reconnect and every `realtime:resync` threw away a
      // bound that was still true and re-opened the one window `BalanceOrder` cannot order: its
      // FIRST event, which `supersedes(x, null)` takes whatever it says. That window is now once
      // per tab per identity (the effect builds a fresh `BalanceOrder` when `identity` changes)
      // instead of once per connection — which was exactly the route Q-M4-7 names, and the one a
      // Redis blip opens. An event whose id is not past the watermark committed before a balance
      // this tab has already applied, so refusing it can lose nothing.
      const keys = identity === null ? SNAPSHOT_KEYS : [...SNAPSHOT_KEYS, ...PRIVATE_SNAPSHOT_KEYS];
      for (const queryKey of keys) {
        void restartQueries(queryClient, queryKey);
      }
    };

    /**
     * One fills refetch per market per window, LEADING and trailing.
     *
     * The trailing edge is not an optimisation: `['market-fills', id]` has no other writer —
     * `useMarketFills` carries no `refetchInterval` — so a refused invalidation that is simply
     * dropped leaves the 체결 내역 list one row short until an unrelated trigger happens by.
     * A refusal therefore schedules itself for the rest of the window and every event inside
     * it coalesces into that one late refetch; re-entering rather than invalidating from the
     * timer keeps a single statement of when a refetch is allowed.
     *
     * `restartQueries` and not a bare invalidation, for the same reason the position and the
     * balance handlers cancel first. The fills list is never seeded (`seedMarketDetail` carries
     * the market and the ticks, not this), so its FIRST fetch is the ordinary path on every
     * visit to a market — and a trade landing in that window is exactly what this handler is
     * for. A bare invalidation there subscribes to the request already running, which left
     * before the fill; and because `take` SUCCEEDED, the trailing edge that rescues a refused
     * window is never armed either, so that event buys nothing at all.
     *
     * Self-healing, not permanent: once the first answer has landed the query holds data, so
     * the NEXT trade in this market refetches normally (that is the `cancelRefetch` gate) and
     * the missing row appears. Which is the whole shape of it — the busy markets where the race
     * is likely repair themselves within a second, and it is the quiet market, where one trade
     * an hour arrives just as somebody opens the page, that shows 체결 없음 under a probability
     * that plainly just moved.
     */
    const refreshFills = (marketId: string) => {
      const now = Date.now();
      if (fills.take(marketId, now)) {
        void restartQueries(queryClient, marketFillsKey(marketId));
        return;
      }
      if (fillsPending.has(marketId)) return;
      const timer = setTimeout(
        () => {
          fillsPending.delete(marketId);
          refreshFills(marketId);
        },
        fills.retryDelay(marketId, now),
      );
      fillsPending.set(marketId, () => {
        clearTimeout(timer);
      });
    };

    socket.on('connect', () => {
      rooms.resubscribe();
      if (bootstrapped.current) resnapshot();
      // The tab's FIRST connect must not invalidate. Every connect after it re-snapshots,
      // whether this socket reconnected or a new one replaced it — the ADR's "두 번째
      // connect부터" is per tab (ADR-0031).
      //
      // What the SSR payload is, stated accurately: a PRE-SUBSCRIBE snapshot. The server read
      // the market before this tab held any room, so a trade committing between that read and
      // the join above reaches no socket of this tab — a window the whole client bootstrap wide
      // (stream, hydrate, the session round trip this effect waits on, the handshake), not the
      // one event-loop tick the protocol's own comment used to claim was all of it.
      //
      // Accepted, not overlooked. `market:tick` and `market:status` carry ABSOLUTE values, so
      // the market's next event repairs the reading in full at zero request cost, and the
      // residue is a market that trades once inside the gap and then goes quiet. Re-snapshotting
      // here instead costs a request per mounted observer on EVERY page load by every visitor —
      // measured at three on a signed-out detail screen — which is the request `dehydrate()`
      // exists to remove. Closing it honestly would mean the gateway replying to a `subscribe`
      // with the rooms' current state, which is an ack (A-M4-8) and a read on the anonymous
      // path (A-M4-3): two recorded refusals, not a client-side refetch.
      bootstrapped.current = true;
    });

    // The gateway lost its Redis subscription and re-armed it, so whatever was published in
    // the gap is gone — the rooms survived, only the events did not. Same recovery as a
    // reconnect, and unconditional: the gateway never sends this for its first arm.
    socket.on(RESYNC_EVENT, resnapshot);

    // A refused `subscribe`/`unsubscribe` arrives here and nowhere else, so swallowing it
    // would leave the screen quietly un-live with nothing to explain it. Now that `emit`
    // chunks at the per-message cap, the refusal left is the per-SOCKET room cap
    // (REALTIME_ROOMS_MAX): the gateway joins ids until it is reached and refuses the rest,
    // and the envelope names no ids, so there is nothing to drop from the registry.
    //
    // WHICH rooms are dropped is deterministic; whether a reload recovers them depends on the
    // SCREEN, and this comment has stated both halves wrongly before. `useMarketSocket` joins
    // `[...new Set(ids)].sort()` and the gateway consumes that order, so the rooms it keeps are
    // the lexicographically first uuids and the dead cards are scattered through the grid rather
    // than being its tail. On the home grid a reload IS the recovery: `page.tsx` prefetches ONE
    // page and this app persists no query cache, so a reloaded tab is back to
    // PAGE_LIMIT_DEFAULT 20 rows, all live, and it takes ten presses of 더 보기 to pass 200
    // again. On /portfolio it is not: `GET /me/positions` is uncursored by design, so every load
    // selects the same first 200 markets and the same holdings stay dark.
    //
    // Two "fixes" are refused here on purpose. Capping the registry client-side buys ZERO live
    // rooms — the gateway joins ids until the cap wherever the boundary falls, so the same 200
    // live and the same rows die — while deleting the only signal that a screen is over the cap,
    // which is this warning. And 더 보기 is not bounded at `REALTIME_ROOMS_MAX`: that mirrors a
    // limit only the server holds, does nothing for /portfolio, and hides rows — which A-M3-31
    // already refused for a market whose close time has passed. A stale card is a smaller lie
    // than a market that is not on the page at all.
    socket.on(REALTIME_EXCEPTION_EVENT, (raw: unknown) => {
      const parsed = errorEnvelopeSchema.safeParse(raw);
      const detail = parsed.success
        ? `${parsed.data.error.code}: ${parsed.data.error.message}`
        : 'unparseable error envelope';
      console.warn(`realtime: the gateway refused a message (${detail})`);
    });

    /**
     * Per-type schemas rather than the `realtimeEventSchema` union: narrower, cheaper, and the
     * `satisfies Record<RealtimeEventType, …>` below turns a new event type into a compile
     * error here instead of an event nobody listens for.
     *
     * Every updater answers `undefined` when nothing moved and `setQueryData` returns early on
     * that, so a late or duplicate event costs no cache write, leaves `dataUpdatedAt` where it
     * was and restarts no `staleTime`.
     */
    const handlers = {
      'market:tick': (raw: unknown) => {
        const parsed = marketTickEventSchema.safeParse(raw);
        if (!parsed.success) return;
        const event = parsed.data;
        /**
         * The one event this app answers by ASKING, and every reason it is allowed to is stated
         * on `tickRestartsMarket` (market-live.ts) rather than here — a gate written inside an
         * effect body is a gate the node runner cannot reach, and its test can only paraphrase it.
         * What is local to this handler is the wiring: the query's state is read BEFORE the write
         * (`setQueryData` cannot create an entry when the updater answers `undefined`, so before
         * and after are the same reading, and before is the clearer one), and the throttle is the
         * socket's, so a rebuilt connection starts with nothing spent.
         *
         * `restartQueries`, not a bare invalidation, for the reason `refreshFills` gives above: a
         * query that has answered nothing hands back the request already running, which is
         * precisely the pre-trade one. Self-limiting — once the restarted answer lands the row
         * exists and every later tick is a free cache write.
         */
        const row = queryClient
          .getQueryCache()
          .find<Market>({ queryKey: marketKey(event.marketId), exact: true });
        queryClient.setQueryData<Market>(marketKey(event.marketId), (held) =>
          applyTick(held, event),
        );
        if (tickRestartsMarket(row?.state, marketRestart, event.marketId, Date.now())) {
          void restartQueries(queryClient, marketKey(event.marketId));
        }
        // Every filtered list at once: the same market sits in as many cache entries as the
        // tab has visited filters, and `applyToPages` answers undefined for the ones that do
        // not hold it, so those cost nothing.
        //
        // It writes a card's NUMBERS and never its RANK, and that is a decision rather than an
        // oversight. `sort=volume` is keyset-paginated on `(volume_p DESC, id DESC)`
        // (market.service.ts), so the order belongs to the fetch that produced the page — the
        // same rule `joinMarketPages` states from the other side ("the page SHAPE comes from
        // `incoming`"), and the same rule list MEMBERSHIP already follows: a market that closes
        // stays in a `status=open` list until the next answer says otherwise. Re-sorting here
        // could only sort the pages this tab happens to hold, which is neither the server's
        // order nor a correct global one; invalidating instead was measured at one request per
        // cached page per tick — six for a reader who pressed 더 보기 five times — and it does
        // not even converge, because each invalidation cancels the chain the last one started.
        // The order is restored by the next ordinary fetch: a filter change, a reconnect's
        // `resnapshot`, or a mount past `staleTime`.
        queryClient.setQueriesData<MarketPages>({ queryKey: MARKETS_KEY }, (held) =>
          applyToPages(held, (row) => applyTick(row, event)),
        );
        // And every range of this market's series, so the open chart's right edge moves
        // without a refetch (PLAN 11.5: an event must not become a request).
        queryClient.setQueriesData<CachedSeries>(
          { queryKey: [...TICKS_KEY, event.marketId] },
          (held) => appendTick(held, event),
        );
      },

      'market:status': (raw: unknown) => {
        const parsed = marketStatusEventSchema.safeParse(raw);
        if (!parsed.success) return;
        const event = parsed.data;
        queryClient.setQueryData<Market>(marketKey(event.marketId), (held) =>
          applyStatus(held, event),
        );
        queryClient.setQueriesData<MarketPages>({ queryKey: MARKETS_KEY }, (held) =>
          applyToPages(held, (row) => applyStatus(row, event)),
        );
        // The reducer above has already moved the badge and the notice; this fills in what the
        // event does not carry. `create` publishes nothing, and an EDIT to an open market
        // publishes this event with the status unchanged for exactly this refetch — no event
        // carries `closeAt`, `title` or `rules`, and `applyStatus` drops a repeat on rank, so
        // the restart below is the whole delivery of an admin edit (A-M4-36).
        //
        // It is a SANCTIONED refetch, and this file has kept a count of those twice now and been
        // wrong twice — "the second and last" became three, and three became six. So here is the
        // RULE instead, which does not go stale: a refetch is allowed only where the cache cannot
        // end up right without one, and it falls into exactly two kinds.
        //
        //  - the event cannot BUILD the row it is about: this one (a transition carries no
        //    price), `market:trade` → `refreshFills`, `user:position` → `['orders']`.
        //  - the cache could not TAKE the event, so the answer already on the wire is the stale
        //    one: this one again on an unseeded key (below), `market:tick` → `['market', id]`
        //    while its first answer is in flight, `user:position` → `['positions']` for a list
        //    that holds no such row, `user:balance` → `['me']` for a tab holding no `Me`.
        //
        // A refetch for anything a reducer can write belongs to neither kind, and is the 남발
        // PLAN 11.5 refuses.
        //
        // `restartQueries`, not the bare invalidation this used to be — the fourth time that
        // distinction has bitten, and the worst of them. `applyStatus` writes NOTHING into a
        // cache with no row, and a bare invalidation on a query that has answered nothing hands
        // back the request already running: the one that read the market BEFORE the transition.
        // /portfolio's `['market', id]` entries are unseeded (`useQueries`), so that pre-close
        // snapshot landed as fresh and the row went on saying `open`. What that costs on screen
        // is the MISSING 마감 badge, not a wrong one: `OpenPositionRow` draws a status badge only
        // when `marketStatus !== 'open'`, so the holding is listed with no sign that the market
        // can no longer be traded. No figure is wrong — a close writes no price tick and no
        // arithmetic here reads the status — which is why this is P3 and not higher.
        //
        // Unlike a dropped tick, NOTHING repairs it: a close publishes no `user:position`, so the
        // positions row cannot correct it, the closed market publishes no further tick, and the
        // success dispatch cleared the invalidation flag and restamped `dataUpdatedAt`, so the
        // row sits inside `staleTime` with nothing scheduled. Only a focus, a reconnect or a
        // remount does. The reachable transition is open → closed alone: draft → open cannot be
        // held (a draft is on no public route) and a terminal status arrives per holder as
        // `user:position`, which `liveMarketStatus` refuses as terminal anyway. Measured: bare invalidation → one
        // fetch and the row stays `open`; restarted → two and it reads `closed`.
        //
        // No gate and no throttle here, unlike the tick handler. This refetch is sanctioned on
        // EVERY status event whatever the cache holds, so `restartQueries` only adds the cancel
        // — and on a seeded or already-answered key it IS the plain invalidation (query-client.ts
        // cancels only a query with no data). Measured: 0 → 0 on a key nothing holds, 5 → 5 over
        // a load and four events on an answered one, 0 → 1 in the broken state, which is the
        // correction itself. It adds no new refetch site; it upgrades one that was already here.
        //
        // The ticks line is SYMMETRY, not a second fix, and saying so is the point: its hole is
        // inert. No transition writes a price tick (`market-admin.service.ts`; only a fill does,
        // N02 §5), so no status event can leave a held series behind.
        // `restartQueries` is still the right call there because it matches by PREFIX, which is
        // what these entries need: they are `['ticks', id, range]`, one per range this tab opened.
        void restartQueries(queryClient, marketKey(event.marketId));
        void restartQueries(queryClient, [...TICKS_KEY, event.marketId]);
      },

      'market:trade': (raw: unknown) => {
        const parsed = marketTradeEventSchema.safeParse(raw);
        if (!parsed.success) return;
        // Invalidate, never prepend a synthetic row: the event has no `amountP` while the REST
        // `Fill` does, and `['market-fills', id]` is SHARED with the admin detail, which
        // renders formatP(parsePAmount(fill.amountP)) and would throw on a null.
        refreshFills(parsed.data.marketId);
      },

      'user:balance': (raw: unknown) => {
        // Defence in depth for the window between a sign-out and the rebuilt handshake: the
        // gateway joins `user:<id>` from the handshake session, so this can never be another
        // account's event — only this account's, after the screen stopped being theirs.
        if (identity === null) return;
        const parsed = userBalanceEventSchema.safeParse(raw);
        if (!parsed.success || !balanceOrder.accept(parsed.data)) return;
        // 원장 is the other half of this event, and it was the one balance writer that moved the
        // chip and left the history behind: `useCharge`, `useRedeemCoupon` and the admin
        // adjustment all refresh `['me']` and `['ledger']` together ("the nav chip and the ledger
        // must never disagree", use-wallet.ts). A tab parked on /wallet showed the post-payout
        // balance above a newest row still asserting the pre-payout 잔고 후, with 정산 지급 absent
        // — self-contradicting rather than merely behind, which is what makes it worth a request.
        //
        // Both kinds of the RULE above, and the first one literally: the event carries the ID of
        // the row it cannot draw (a `LedgerEntry` is type, amount, 잔고 후, memo and instant; a
        // `UserBalanceEvent` is two figures, that id and a `ts`), and a /wallet on its first fetch
        // could not take it either. Not 남발: the accept gate is `ledger_entries.id`, the
        // account's own commit order, so an ACCEPTED event always names a row this tab has never
        // held and a late or duplicate delivery spends nothing.
        //
        // Above the `patch.kind` branch because that branch RETURNS, and the tab it returns for —
        // one whose `GET /me` is in flight — is on /wallet precisely the tab whose FIRST
        // `GET /me/ledger` is in flight too. `restartQueries` for that same reason: `['ledger']`
        // is never seeded and never SSR'd, so a bare invalidation would hand back the request
        // that left before the payout committed.
        //
        // 결제 내역 sits beside 원장 on /wallet and contradicts it the same way when left behind:
        // an admin refund claws the P back (a 결제 취소(환불) row) while the payment still says
        // 완료, and a 재통보 credit after the result notice stopped polling adds a 충전 row over
        // a payment still 처리 중 or 미완료. The event names no payment, so the list is asked again —
        // the same kind as the ledger's, and on the same accepted event, so it costs a request
        // only where 결제 내역 is on screen. Unseeded as well, hence `restartQueries` again.
        // Only as far as the P goes: a refund's claw-back is the one step that moves a balance,
        // so the list lands on 환불 처리 중, and its finish (환불 완료) — like a settle that moves
        // no P (환불 완료, 취소 확인, 실패로 닫기; a settle `credit` or `restore` does publish) —
        // publishes nothing; the list's own bounded poll while a row is still moving
        // (`paymentsPoll`, use-wallet.ts) carries that row the rest of the way.
        for (const queryKey of BALANCE_HISTORY_KEYS) void restartQueries(queryClient, queryKey);
        const patch = applyBalanceEvent(queryClient.getQueryData<Me>(ME_QUERY_KEY), parsed.data);
        // Kills an in-flight `GET /me` that would otherwise resolve after this write carrying
        // an older balance. A charge or a coupon also reaches the chip through its own answer's
        // refetch (an Idempotency-Key replay publishes NO event); a payout reaches it only here.
        //
        // The cancel is synchronous down to the state change (query-core's retryer rejects and
        // calls `onCancel` in the same tick), so both branches below act on a query that is
        // already idle.
        void queryClient.cancelQueries({ queryKey: ME_QUERY_KEY, exact: true });
        if (patch.kind === 'refetch') {
          // Nothing to patch, and the cancel has just REVERTED the first `GET /me` to the
          // state it had before it started — `pending` with no data, and no observer left
          // fetching. So the request has to be re-issued, or the balance chip and the 잔고
          // 요약 spin until the next window focus. Issued after the event was received, so
          // its answer cannot be the snapshot this event already superseded.
          void queryClient.invalidateQueries({
            queryKey: ME_QUERY_KEY,
            exact: true,
            refetchType: 'active',
          });
          return;
        }
        queryClient.setQueryData<Me>(ME_QUERY_KEY, patch.me);
      },

      'user:position': (raw: unknown) => {
        if (identity === null) return;
        const parsed = userPositionEventSchema.safeParse(raw);
        if (!parsed.success) return;
        const event = parsed.data;
        // Every cached variant of the list — `['positions']` and `['positions', status]` both
        // hang off this root — and at most ONE refetch for all of them: the event carries no
        // marketSlug, marketTitle or marketLastPrice, so a row the cache does not hold cannot
        // be built and has to be asked for instead. Walked rather than written through
        // `setQueriesData` because the reducer answers a KIND, not a value, and reading that
        // decision out of an updater would hide a side effect inside a pure cache write.
        let refetch = false;
        for (const query of queryClient.getQueryCache().findAll({ queryKey: POSITIONS_KEY })) {
          const held = queryClient.getQueryData<Position[]>(query.queryKey);
          // WHICH list this is, read off the key `positionsKey` built (`['positions', status]`).
          // Without it the reducer cannot tell an absence that is a GAP from one that is the
          // list's own definition, and every ordinary trade restarted both lists — see
          // `applyPositionEvent`. An unsuffixed root answers `undefined` and keeps the old path.
          const patch = applyPositionEvent(held, event, listStatusOf(query.queryKey));
          if (patch.kind === 'refetch') refetch = true;
          if (patch.kind === 'replace') {
            queryClient.setQueryData<Position[]>(query.queryKey, patch.positions);
          }
        }
        // 주문 이력 has no reducer and no event of its own: an `Order` carries its id, status,
        // filledQty, amountP, priceAvgBp and the market's slug and title, none of which any
        // `user:` event does, so a row cannot be built and has to be asked for — the same answer
        // `market:trade` gives 체결 내역. Without it /portfolio moved its balance and its holding
        // on this event and left the order list a row short until a focus or a reconnect.
        //
        // A SETTLING event is excluded because a settlement writes no order row at all, so the request could only answer what the list already holds. `refetchType`
        // stays at its default `'active'`, so every tab not showing 주문 이력 pays nothing and
        // is merely marked stale.
        if (wroteAnOrder(event)) void restartQueries(queryClient, ORDERS_KEY);
        if (refetch) {
          // `restartQueries`, not a bare invalidation: a list that has answered nothing yet
          // would otherwise subscribe to the request it already has instead of issuing one,
          // and that request left before the trade this event announces — 보유 없음 on a
          // market the account just bought into. Lists that DO hold rows are refetched exactly
          // as before.
          void restartQueries(queryClient, POSITIONS_KEY);
        }
      },
    } satisfies Record<RealtimeEventType, (raw: unknown) => void>;

    for (const [event, handler] of Object.entries(handlers)) socket.on(event, handler);

    return () => {
      rooms.detach(socket);
      socket.removeAllListeners();
      socket.disconnect();
      // A trailing fills refetch belongs to the socket that earned it: firing it after the
      // teardown would invalidate on behalf of a connection this tab no longer has.
      for (const cancel of fillsPending.values()) cancel();
      fillsPending.clear();
    };
  }, [identity, queryClient]);

  return <RealtimeContext value={registry}>{children}</RealtimeContext>;
}
