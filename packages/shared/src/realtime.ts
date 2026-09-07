import * as z from 'zod';
import { pAmountSchema } from './api/p-amount.js';
import { uuidSchema } from './api/uuid.js';
import { BP_MAX, PRICE_MAX, PRICE_MIN } from './constants.js';
import { marketStatusSchema, orderSideSchema, outcomeSchema } from './enums.js';

/**
 * Socket.IO event payloads (PLAN 8). The API publishes them to Redis after a trade or a
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
 * `market:status` is the exception: it carries no key, and a client keeps the higher status
 * rank in `MARKET_STATUSES` order (`enums.ts`). That is a total order only while no
 * transition repeats a status — it holds through M3 (draft → open → closed, and void from
 * open/closed/resolving, with `settled` never voidable) and it is what a REST snapshot can
 * be compared against, which no event id would be. M5's `result_changed` repeats
 * `resolving` with a new result and dispute deadline, so before it publishes its first
 * event `market:status` must gain a strict key — `market_events.id` of the transition,
 * which is drawn under the market's row lock and is therefore in commit order per market —
 * and the market DTOs must carry that key so a snapshot can seed it (A-M3-19, Q-M3-8).
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

/** Room `market:<id>`: price and stats after a trade (or a tick-writing transition). */
export const marketTickEventSchema = z
  .object({
    type: z.literal('market:tick'),
    marketId: z.uuid(),
    pYesBp: bpSchema,
    lastPrice: z.number().int().min(PRICE_MIN).max(PRICE_MAX),
    volumeP: pAmountSchema,
    tradeCount: z.number().int().min(0),
    ts: tsSchema,
  })
  .meta({ id: 'MarketTickEvent' });
export type MarketTickEvent = z.infer<typeof marketTickEventSchema>;

/** Room `market:<id>`: one anonymous fill. `fillId` is `Fill.id` (strict per market). */
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

/** Room `market:<id>`: a status transition (open, close, resolve, finalize, void). */
export const marketStatusEventSchema = z
  .object({
    type: z.literal('market:status'),
    marketId: z.uuid(),
    status: marketStatusSchema,
    resolvedResult: outcomeSchema.nullish(),
    disputeUntil: z.iso.datetime().nullish(),
    ts: tsSchema,
  })
  .meta({ id: 'MarketStatusEvent' });
export type MarketStatusEvent = z.infer<typeof marketStatusEventSchema>;

/**
 * Room `user:<id>`: the balance after a trade, refund or payout. `ledgerEntryId` is the
 * ledger row that recorded the change — the account's strict order key (see `supersedes`).
 */
export const userBalanceEventSchema = z
  .object({
    type: z.literal('user:balance'),
    availableP: pAmountSchema,
    lockedP: pAmountSchema,
    ledgerEntryId: serialIdSchema,
    ts: tsSchema,
  })
  .meta({ id: 'UserBalanceEvent' });
export type UserBalanceEvent = z.infer<typeof userBalanceEventSchema>;

/**
 * Room `user:<id>`: one position row after it changed. `version` is the row's, bumped on
 * every write (`Position.version` on the REST snapshot is the same number); `settled` tells
 * a void or settlement apart from a full sell (both leave qty 0).
 */
export const userPositionEventSchema = z
  .object({
    type: z.literal('user:position'),
    marketId: z.uuid(),
    outcome: outcomeSchema,
    qty: z.number().int().min(0),
    costBasisP: pAmountSchema,
    realizedPnlP: pAmountSchema,
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
 * joining a room stays a synchronous in-process operation, so the ack a client waits on
 * before reading its REST snapshot (A-M3-19) cannot race a Redis round trip, and the
 * reconnect re-arm of Q-M3-7 is two idempotent commands instead of a rebuilt set. They must
 * keep matching what `marketChannel`/`userChannel` publish to.
 */
export const MARKET_CHANNEL_PATTERN = 'market:*';
export const USER_CHANNEL_PATTERN = 'user:*';

/** Market rooms one `subscribe` may add — one page of `GET /markets` (PAGE_LIMIT_MAX). */
export const REALTIME_SUBSCRIBE_MAX = 100;
/** Market rooms one socket may hold at once (~10 pages of the list). */
export const REALTIME_ROOMS_MAX = 200;
/** Largest client message the gateway accepts; 100 uuids in JSON is ~4 KB. */
export const REALTIME_MAX_MESSAGE_BYTES = 16_384;

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
