import * as z from 'zod';
import { pAmountSchema } from './api/p-amount.js';
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
 * `market:trade.fillId` (both per market, under the market lock). `ts` is for display.
 * `market:status` is a monotone state machine and keeps the newest by `ts`.
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
