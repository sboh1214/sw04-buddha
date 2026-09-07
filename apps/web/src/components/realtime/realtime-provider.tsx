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
import { type Market, type Me, type Position, type PriceSeries } from '@/lib/api';
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
  applyBalance,
  applyPositionEvent,
  applyStatus,
  applyTick,
  applyToPages,
  chunkIds,
} from '@/lib/market-live';
import { appendTick } from '@/lib/ticks';

/**
 * The tab's ONE Socket.IO connection (PLAN 8, 11.5): the room registry every screen drives
 * through `useMarketSocket`, and every cache write a realtime event causes.
 *
 * One socket for the whole tab rather than one per screen, because the `market:*` handlers are
 * pure cache writes keyed by `event.marketId` — registering them once is correct wherever the
 * market happens to be on screen — while `user:balance` and `user:position` have to be live on
 * every page, since the balance chip lives in Nav.
 *
 * Every write goes through the reducers in lib/market-live.ts and lib/ticks.ts, which the HTTP
 * trade answer writes through as well: one ordering rule for both deliveries, so whichever
 * arrives second is a no-op instead of a rollback. Nothing here restates a reducer.
 */

/**
 * The API origin, mirroring api.server.ts and session.server.ts — with the difference that
 * this one is read in the BROWSER: next.config.ts rewrites `/api/:path*` only, and a rewrite
 * does not proxy a WebSocket upgrade, so the socket dials the API directly (ADR-0009 →
 * ADR-0017). `withCredentials` then carries the SameSite=Lax session cookie, which needs web
 * and API to stay same-site (localhost:3000 / localhost:4000; never 127.0.0.1 for the web
 * host, ADR-0015).
 */
const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

/** At most one fills refetch per market per second — a busy market publishes a fill per trade. */
const FILLS_INVALIDATE_MS = 1_000;

/** The public caches a reconnect re-reads; any of them may have moved during the gap. */
const SNAPSHOT_KEYS = [MARKET_KEY, MARKETS_KEY, TICKS_KEY, MARKET_FILLS_KEY] as const;
/** The same for a signed-in tab. Never SSR'd, so they exist only once the client has fetched. */
const PRIVATE_SNAPSHOT_KEYS = [ME_QUERY_KEY, POSITIONS_KEY, ORDERS_KEY] as const;

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
     */
    const resnapshot = () => {
      balanceOrder.reset();
      const keys = identity === null ? SNAPSHOT_KEYS : [...SNAPSHOT_KEYS, ...PRIVATE_SNAPSHOT_KEYS];
      for (const queryKey of keys) {
        void queryClient.invalidateQueries({ queryKey, refetchType: 'active' });
      }
    };

    /**
     * One fills refetch per market per window, LEADING and trailing.
     *
     * The trailing edge is not an optimisation: `['market-fills', id]` has no other writer for
     * somebody else's trade — the trader's own fill is written by `applyTradeResult`, and
     * `useMarketFills` carries no `refetchInterval` — so a refused invalidation that is simply
     * dropped leaves the 체결 내역 list one row short until an unrelated trigger happens by.
     * A refusal therefore schedules itself for the rest of the window and every event inside
     * it coalesces into that one late refetch; re-entering rather than invalidating from the
     * timer keeps a single statement of when a refetch is allowed.
     */
    const refreshFills = (marketId: string) => {
      const now = Date.now();
      if (fills.take(marketId, now)) {
        void queryClient.invalidateQueries({
          queryKey: marketFillsKey(marketId),
          refetchType: 'active',
        });
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
      // The tab's FIRST connect must not invalidate: the SSR payload IS the snapshot, and
      // re-reading it would cost a request per mounted observer on every single page load.
      // Every connect after it re-snapshots, whether this socket reconnected or a new one
      // replaced it — the ADR's "두 번째 connect부터" is per tab (ADR-0031).
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
    // and the envelope names no ids, so there is nothing to drop from the registry. This is a
    // developer-facing warning about that tail, and a reload is the recovery.
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
        queryClient.setQueryData<Market>(marketKey(event.marketId), (held) =>
          applyTick(held, event),
        );
        // Every filtered list at once: the same market sits in as many cache entries as the
        // tab has visited filters, and `applyToPages` answers undefined for the ones that do
        // not hold it, so those cost nothing.
        queryClient.setQueriesData<MarketPages>({ queryKey: MARKETS_KEY }, (held) =>
          applyToPages(held, (row) => applyTick(row, event)),
        );
        // And every range of this market's series, so the open chart's right edge moves
        // without a refetch (PLAN 11.5: an event must not become a request).
        queryClient.setQueriesData<PriceSeries>(
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
        // The reducer above has already moved the badge and disabled the panel; this fills in
        // what the event does not carry. A transition carries no price, yet `open` writes a
        // price tick and moves lastPrice/pYesBp while publishing only `market:status`
        // (market-admin.service.ts), and create/update publish nothing at all — so this is the
        // second, and last, sanctioned refetch.
        void queryClient.invalidateQueries({
          queryKey: marketKey(event.marketId),
          refetchType: 'active',
        });
        void queryClient.invalidateQueries({
          queryKey: [...TICKS_KEY, event.marketId],
          refetchType: 'active',
        });
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
        const event = parsed.data;
        // Kills an in-flight `GET /me` that would otherwise resolve after this write carrying
        // an older balance. The primary path for the trading AC is still `TradeResult.balance`
        // from the HTTP answer (an Idempotency-Key replay publishes NO event); this is the
        // redundant second delivery, and the only delivery on a void refund or a payout.
        void queryClient.cancelQueries({ queryKey: ME_QUERY_KEY, exact: true });
        queryClient.setQueryData<Me>(ME_QUERY_KEY, (held) => applyBalance(held, event));
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
          const patch = applyPositionEvent(held, event);
          if (patch.kind === 'refetch') refetch = true;
          if (patch.kind === 'replace') {
            queryClient.setQueryData<Position[]>(query.queryKey, patch.positions);
          }
        }
        if (refetch) {
          void queryClient.invalidateQueries({ queryKey: POSITIONS_KEY, refetchType: 'active' });
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
