import * as z from 'zod';
import { coinAmountSchema } from './api/coin-amount.js';
import { uuidSchema } from './api/uuid.js';
import { BP_MAX, PRICE_MAX, PRICE_MIN } from './constants.js';
import {
  MARKET_STATUSES,
  marketStatusSchema,
  orderSideSchema,
  outcomeSchema,
  type MarketStatus,
} from './enums.js';

/**
 * Socket.IO event payloads (PLAN 8). The API publishes them to Redis after a fill or a
 * status change commits (M3); the M4 gateway forwards them to rooms and the client parses
 * them with the same schemas.
 *
 * Ordering. Events may reach a client out of commit order (two API instances, a Redis
 * offline queue flushed late), and the millisecond `ts` two serialised writes carry can tie,
 * so every event whose entity can change again carries a strictly ordered key the client
 * compares with `supersedes`: `user:balance.ledgerEntryId` (the ledger row of the change —
 * drawn under the account's balance lock, so strictly increasing per account in commit
 * order; `/me/ledger` shows the current one), `user:position.version` (the row's version,
 * bumped on every write under the market lock), `market:tick.tradeCount` and
 * `market:trade.fillId` (both per market, under the market lock). `ts` is for display, and
 * keys are compared within one event type, never across them (they come from different
 * sequences).
 *
 * `market:status` is ordered by `statusEventId` — the `market_events.id` of the transition,
 * drawn while the writer holds the market row FOR UPDATE and therefore the market's commit
 * order — and the market DTOs carry the same key (`MarketSummary.statusEventId`) so a REST
 * snapshot seeds the comparison (A-M3-19, Q-M3-8 (3), M5). Until M5 the event carried no key
 * and a client kept the higher status rank in `MARKET_STATUSES` order, which was a total order
 * only while no transition repeated a status; M5's `result_changed` repeated its dispute-stage
 * status with a new result and deadline (removed with the dispute stage, ADR-0046), and an admin edit still
 * republishes an unchanged status (A-M4-36), so the key stays the rule. The rank stays as the
 * FALLBACK for a row with no key (`statusSupersedes`): a row written outside the transition
 * paths — a test factory — has none, and rank is still the one order such a row can join.
 *
 * Families. `realtimeEventSchema` is the publisher's union — everything that may reach
 * Redis. The gateway never parses an inbound message with it: a `market:*` message is
 * parsed with `marketRealtimeEventSchema` and a `user:*` message with
 * `userRealtimeEventSchema`, so parsing per family IS the authorization check. A
 * `user:balance` that appears on a market channel — a publisher bug, or anything else able
 * to write to Redis — then fails to parse instead of being fanned out to every subscriber
 * of that public room, which the wide union would have waved through.
 */
export const REALTIME_EVENT_TYPES = [
  'market:tick',
  'market:trade',
  'market:status',
  'user:balance',
  'user:position',
] as const;
export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];

const bpSchema = z.number().int().min(0).max(BP_MAX);
const tsSchema = z.iso.datetime();
/** A bigserial as a decimal string (ledger entries, fills): the ordering key of an event. */
const serialIdSchema = z.string().regex(/^[1-9]\d*$/, 'must be a positive integer string');

/**
 * Whether `incoming` is newer than `current` by ordering key — the rule a client applies
 * per entity before taking an event (or a REST snapshot) over what it holds. Keys are
 * decimal strings or integers; compared as integers, since '10' < '9' as strings. Equal is
 * a duplicate, smaller is late: both are dropped. Nothing held yet takes anything.
 */
export function supersedes(
  incoming: string | number,
  current: string | number | null | undefined,
): boolean {
  if (current === null || current === undefined) return true;
  return BigInt(incoming) > BigInt(current);
}

/** What `statusSupersedes` reads off an event or a market DTO. */
export interface StatusKeyed {
  status: MarketStatus;
  statusEventId: string | null | undefined;
}

/** Position in `MARKET_STATUSES`: the transition order, and the fallback order below. */
export function statusRank(status: MarketStatus): number {
  return MARKET_STATUSES.indexOf(status);
}

/**
 * Whether `incoming` describes a LATER transition than `held` — the rule for `market:status`
 * against a cached row, and for one REST snapshot against another.
 *
 * With a key on both sides it is `supersedes` on `statusEventId`, which is strict: a repeat of
 * the same status (an admin edit republishes it unchanged, A-M4-36) and a late or duplicate
 * delivery both answer false, while the same status with a NEWER event id (M5's legacy
 * `result_changed`) answers true. Without a key on either side it falls back to the status rank, the order
 * every row can join; that path is only ever taken for rows a test factory wrote, but it keeps
 * the function total rather than throwing on a null.
 */
export function statusSupersedes(incoming: StatusKeyed, held: StatusKeyed): boolean {
  if (incoming.statusEventId != null && held.statusEventId != null) {
    return supersedes(incoming.statusEventId, held.statusEventId);
  }
  return statusRank(incoming.status) > statusRank(held.status);
}

/**
 * Room `market:<id>`: price and stats after a fill. Nothing publishes it until the CLOB fills
 * orders (#119): the direct AMM trade that did is gone (#125).
 */
export const marketTickEventSchema = z
  .object({
    type: z.literal('market:tick'),
    marketId: z.uuid(),
    /** `MarketSummary.lastPrice`: null until the market's first fill. */
    lastPrice: z.number().int().min(PRICE_MIN).max(PRICE_MAX).nullable(),
    volumeCoin: coinAmountSchema,
    tradeCount: z.number().int().min(0),
    /**
     * Raised by a fill from an account new to this market. It moves with the same fill, so it
     * rides in the same patch: a client that patched every other fill-derived field kept the old
     * participant count for as long as the market stayed busy.
     */
    traderCount: z.number().int().min(0),
    ts: tsSchema,
  })
  .meta({ id: 'MarketTickEvent' });
export type MarketTickEvent = z.infer<typeof marketTickEventSchema>;

/**
 * Room `market:<id>`: one anonymous fill (no publisher until #119). `fillId` is `Fill.id`
 * (strict per market).
 */
export const marketTradeEventSchema = z
  .object({
    type: z.literal('market:trade'),
    marketId: z.uuid(),
    fillId: serialIdSchema,
    outcome: outcomeSchema,
    side: orderSideSchema,
    qty: z.number().int().min(1),
    priceAvgBp: bpSchema,
    ts: tsSchema,
  })
  .meta({ id: 'MarketTradeEvent' });
export type MarketTradeEvent = z.infer<typeof marketTradeEventSchema>;

/**
 * Room `market:<id>`: a status transition (open, close, resolve, finalize), or the same status republished so subscribers refetch a descriptive edit (A-M4-36,
 * `MarketAdminService` `update`). `statusEventId` is the transition's `market_events.id` — the
 * key `statusSupersedes` orders by — and the repeat carries the UNCHANGED one, which is what
 * makes it safe: a client drops it as not newer, and only the REST snapshot it triggers
 * carries `closeAt`, `title` or `rules`. Required (nullable, never absent) so every publisher
 * states it; null only from a row that has no transition event.
 */
export const marketStatusEventSchema = z
  .object({
    type: z.literal('market:status'),
    marketId: z.uuid(),
    status: marketStatusSchema,
    resolvedResult: outcomeSchema.nullish(),
    statusEventId: serialIdSchema.nullable(),
    ts: tsSchema,
  })
  .meta({ id: 'MarketStatusEvent' });
export type MarketStatusEvent = z.infer<typeof marketStatusEventSchema>;

/**
 * Room `user:<id>`: the balance after a ledger entry changed it (a fill, a payout).
 * `ledgerEntryId` is that ledger row — the account's strict order key (see `supersedes`).
 */
export const userBalanceEventSchema = z
  .object({
    type: z.literal('user:balance'),
    availableCoin: coinAmountSchema,
    lockedCoin: coinAmountSchema,
    ledgerEntryId: serialIdSchema,
    ts: tsSchema,
  })
  .meta({ id: 'UserBalanceEvent' });
export type UserBalanceEvent = z.infer<typeof userBalanceEventSchema>;

/**
 * Room `user:<id>`: one position row after it changed. `version` is the row's, bumped on
 * every write (`Position.version` on the REST snapshot is the same number); `settled` tells
 * a settlement apart from a full sell (both leave qty 0).
 */
export const userPositionEventSchema = z
  .object({
    type: z.literal('user:position'),
    marketId: z.uuid(),
    outcome: outcomeSchema,
    qty: z.number().int().min(0),
    costBasisCoin: coinAmountSchema,
    realizedPnlCoin: coinAmountSchema,
    settled: z.boolean(),
    version: z.number().int().min(1),
    ts: tsSchema,
  })
  .meta({ id: 'UserPositionEvent' });
export type UserPositionEvent = z.infer<typeof userPositionEventSchema>;

export const realtimeEventSchema = z
  .discriminatedUnion('type', [
    marketTickEventSchema,
    marketTradeEventSchema,
    marketStatusEventSchema,
    userBalanceEventSchema,
    userPositionEventSchema,
  ])
  .meta({ id: 'RealtimeEvent' });
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;

export type MarketRealtimeEvent = MarketTickEvent | MarketTradeEvent | MarketStatusEvent;
export type UserRealtimeEvent = UserBalanceEvent | UserPositionEvent;

/** Redis channel and Socket.IO room for one market (public). */
export function marketChannel(marketId: string): `market:${string}` {
  return `market:${marketId}`;
}

/** Redis channel and Socket.IO room for one user (private). */
export function userChannel(userId: string): `user:${string}` {
  return `user:${userId}`;
}

/** PLAN 8 namespace. The browser connects to `${NEXT_PUBLIC_API_URL}/ws` (ADR-0017). */
export const REALTIME_NAMESPACE = '/ws';

/**
 * The two Redis patterns the gateway holds. Fixed patterns, not one SUBSCRIBE per room:
 * joining a room stays a synchronous in-process operation, so a `subscribe` never waits on
 * a Redis round trip that `commandTimeout` could reject, and the gap between an emit and
 * the join stays one event-loop tick instead of a network hop.
 *
 * That tick is all this pattern choice has to cover — it is NOT all the protocol leaves
 * uncovered, which this comment used to say. A-M3-19's order is "subscribe, then take the REST
 * snapshot", and a first page load runs it BACKWARDS by construction: the server takes the
 * snapshot, and the room is joined only after the HTML has streamed, hydrated, waited on the
 * session and completed a handshake. Everything published in that window reaches no socket of
 * that tab, and it is hundreds of milliseconds to seconds wide, not one tick. It is accepted
 * (A-M4-8, ADR-0031) because the ordering keys self-heal it: `market:tick` and `market:status`
 * carry ABSOLUTE values, so the market's next event repairs the reading in full at no request
 * cost. The residue is a market that trades once inside the gap and then goes quiet.
 *
 * The reconnect re-arm of Q-M3-7 is two idempotent commands rather than a rebuilt subscription
 * set. They must keep matching what `marketChannel`/`userChannel` publish to.
 */
export const MARKET_CHANNEL_PATTERN = 'market:*';
export const USER_CHANNEL_PATTERN = 'user:*';

/**
 * Market ids one `subscribe`/`unsubscribe` MESSAGE may carry — one page of `GET /markets`
 * (PAGE_LIMIT_MAX). A per-message cap, not a per-socket one: `REALTIME_ROOMS_MAX` is
 * deliberately higher, so a caller that holds more rooms than this (the home grid after a
 * few "load more" presses, a portfolio with many positions) MUST slice its ids into chunks
 * of this size. The gateway validates the whole payload before it joins anything, so one
 * over-long message is refused entire and joins zero rooms.
 */
export const REALTIME_SUBSCRIBE_MAX = 100;
/** Market rooms one socket may hold at once (~10 pages of the list). */
export const REALTIME_ROOMS_MAX = 200;
/** Largest client message the gateway accepts; 100 uuids in JSON is ~4 KB. */
export const REALTIME_MAX_MESSAGE_BYTES = 16_384;
/**
 * Messages one CONNECTION may send per RATE_LIMIT_WINDOW_SECONDS before the gateway answers
 * `RATE_LIMITED` (A-M4-5; M6). Generous next to what a screen does — the home grid subscribes
 * once per page of cards and the detail view once — and low enough that a socket cannot spend
 * the event loop on validation.
 *
 * Counted on the socket itself rather than in Redis, unlike every other limit in PLAN 7.5: a
 * connection lives in exactly one process, so its own message rate is not shared state and
 * PLAN 16's "no rate-limit state in process memory" has nothing to be true of here. The state
 * dies with the socket, which is the only thing it describes.
 */
export const REALTIME_MESSAGES_PER_WINDOW = 120;

/**
 * Gateway-only control event: the Redis subscription was lost and re-armed, so events in
 * the gap are gone and the client must re-run its REST snapshots (A-M3-19). NOT a
 * `RealtimeEvent` — it is never published to Redis, so it is deliberately absent from
 * `REALTIME_EVENT_TYPES` and `realtimeEventSchema`, and it carries no payload.
 */
export const RESYNC_EVENT = 'realtime:resync';

/**
 * Gateway-only error channel: the answer to a `subscribe`/`unsubscribe` the gateway refused,
 * carrying the same `{ error: { code, message, details? } }` envelope a REST route would
 * (PLAN 7.4). The client protocol has no acks, so this is the only way a refusal reaches the
 * browser — and it lives here rather than beside the filter so the two sides cannot drift.
 * `exception` is socket.io's own convention for a server-side handler failure.
 */
export const REALTIME_EXCEPTION_EVENT = 'exception';

/**
 * `subscribe` / `unsubscribe` payload. The ids are canonicalised here — A-M3-17's third
 * boundary: an upper-case uuid would join a room no publisher ever writes to, and the
 * socket would sit silent rather than fail.
 */
export const subscribeBodySchema = z.object({
  marketIds: z.array(uuidSchema).min(1).max(REALTIME_SUBSCRIBE_MAX),
});
export type SubscribeBody = z.infer<typeof subscribeBodySchema>;

/**
 * The `market:<id>` room's events; a `market:*` message parses with this and nothing else.
 * Infers `MarketRealtimeEvent`. No `.meta({ id })` on this or the mirror below: neither
 * reaches a controller, and a dangling `components['schemas']` entry is the swagger trap.
 */
export const marketRealtimeEventSchema = z.discriminatedUnion('type', [
  marketTickEventSchema,
  marketTradeEventSchema,
  marketStatusEventSchema,
]);

/**
 * The `user:<id>` room's events; infers `UserRealtimeEvent`. Splitting the union is what
 * keeps a `user:balance` published on a market channel from reaching every subscriber of
 * that market — see the family paragraph at the top of this module.
 */
export const userRealtimeEventSchema = z.discriminatedUnion('type', [
  userBalanceEventSchema,
  userPositionEventSchema,
]);
