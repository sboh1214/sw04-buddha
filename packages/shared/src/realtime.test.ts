import { describe, expect, it } from 'vitest';
import {
  REALTIME_EVENT_TYPES,
  marketChannel,
  marketStatusEventSchema,
  marketTickEventSchema,
  marketTradeEventSchema,
  realtimeEventSchema,
  userBalanceEventSchema,
  userChannel,
  userPositionEventSchema,
} from './realtime.js';

const marketId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const ts = '2026-09-05T00:00:00.000Z';

const tick = {
  type: 'market:tick',
  marketId,
  pYesBp: 5250,
  lastPrice: 52,
  volumeP: '520',
  tradeCount: 1,
  ts,
};
const trade = {
  type: 'market:trade',
  marketId,
  outcome: 'YES',
  side: 'buy',
  qty: 10,
  priceAvgBp: 5200,
  ts,
};
const status = {
  type: 'market:status',
  marketId,
  status: 'resolving',
  resolvedResult: 'YES',
  disputeUntil: ts,
  ts,
};
const balance = { type: 'user:balance', availableP: '9480', lockedP: '0', ts };
const position = {
  type: 'user:position',
  marketId,
  outcome: 'YES',
  qty: 10,
  costBasisP: '520',
  realizedPnlP: '0',
  ts,
};

describe('realtime events (PLAN 8)', () => {
  it('parses every event through its own schema and the union', () => {
    expect(marketTickEventSchema.parse(tick)).toEqual(tick);
    expect(marketTradeEventSchema.parse(trade)).toEqual(trade);
    expect(marketStatusEventSchema.parse(status)).toEqual(status);
    expect(userBalanceEventSchema.parse(balance)).toEqual(balance);
    expect(userPositionEventSchema.parse(position)).toEqual(position);
    for (const event of [tick, trade, status, balance, position]) {
      const parsed = realtimeEventSchema.parse(event);
      expect(parsed).toEqual(event);
      expect(REALTIME_EVENT_TYPES).toContain(parsed.type);
    }
  });

  it('discriminates on type: a payload under the wrong type is refused', () => {
    expect(realtimeEventSchema.safeParse({ ...tick, type: 'market:trade' }).success).toBe(false);
    expect(realtimeEventSchema.safeParse({ ...balance, type: 'user:position' }).success).toBe(
      false,
    );
    expect(realtimeEventSchema.safeParse({ ...tick, type: 'market:price' }).success).toBe(false);
    expect(realtimeEventSchema.safeParse({}).success).toBe(false);
  });

  it('carries P amounts as strings and requires a timestamp', () => {
    expect(realtimeEventSchema.safeParse({ ...tick, volumeP: 520 }).success).toBe(false);
    expect(realtimeEventSchema.safeParse({ ...balance, availableP: 9480 }).success).toBe(false);
    expect(realtimeEventSchema.safeParse({ ...position, costBasisP: '1.5' }).success).toBe(false);
    for (const event of [tick, trade, status, balance, position]) {
      expect(realtimeEventSchema.safeParse({ ...event, ts: undefined }).success).toBe(false);
      expect(realtimeEventSchema.safeParse({ ...event, ts: '2026-09-05 09:00' }).success).toBe(
        false,
      );
    }
  });

  it('bounds the numeric fields', () => {
    expect(realtimeEventSchema.safeParse({ ...tick, lastPrice: 0 }).success).toBe(false);
    expect(realtimeEventSchema.safeParse({ ...tick, pYesBp: 10_001 }).success).toBe(false);
    expect(realtimeEventSchema.safeParse({ ...trade, qty: 0 }).success).toBe(false);
    expect(realtimeEventSchema.safeParse({ ...trade, side: 'short' }).success).toBe(false);
    expect(realtimeEventSchema.safeParse({ ...position, qty: -1 }).success).toBe(false);
    expect(realtimeEventSchema.parse({ ...position, qty: 0 }).type).toBe('user:position');
  });

  it('lets a status event omit or null the resolution fields', () => {
    const opened = { type: 'market:status', marketId, status: 'open', ts };
    expect(realtimeEventSchema.parse(opened)).toEqual(opened);
    expect(
      realtimeEventSchema.parse({ ...opened, resolvedResult: null, disputeUntil: null }),
    ).toEqual({ ...opened, resolvedResult: null, disputeUntil: null });
    expect(realtimeEventSchema.safeParse({ ...opened, status: 'paused' }).success).toBe(false);
  });
});

describe('channels', () => {
  it('name the Redis channel and Socket.IO room per market and per user', () => {
    expect(marketChannel(marketId)).toBe(`market:${marketId}`);
    expect(userChannel('user-1')).toBe('user:user-1');
  });
});
