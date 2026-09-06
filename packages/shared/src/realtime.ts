import * as z from 'zod';
import { pAmountSchema } from './api/p-amount.js';
import { BP_MAX, PRICE_MAX, PRICE_MIN } from './constants.js';
import { marketStatusSchema, orderSideSchema, outcomeSchema } from './enums.js';

/**
 * Socket.IO event payloads (PLAN 8). The API publishes them to Redis after a trade or a
 * status change commits (M3); the M4 gateway forwards them to rooms and the client parses
 * them with the same schemas. Every event carries `ts` (the commit-side clock) because two
 * trades on one market may be published out of commit order — the client keeps the newest.
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

/** Room `market:<id>`: one anonymous fill. */
export const marketTradeEventSchema = z
  .object({
    type: z.literal('market:trade'),
    marketId: z.uuid(),
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

/** Room `user:<id>`: the balance after a trade, refund or payout. */
export const userBalanceEventSchema = z
  .object({
    type: z.literal('user:balance'),
    availableP: pAmountSchema,
    lockedP: pAmountSchema,
    ts: tsSchema,
  })
  .meta({ id: 'UserBalanceEvent' });
export type UserBalanceEvent = z.infer<typeof userBalanceEventSchema>;

/** Room `user:<id>`: one position row after it changed. */
export const userPositionEventSchema = z
  .object({
    type: z.literal('user:position'),
    marketId: z.uuid(),
    outcome: outcomeSchema,
    qty: z.number().int().min(0),
    costBasisP: pAmountSchema,
    realizedPnlP: pAmountSchema,
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
