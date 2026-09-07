import { describe, expect, it } from 'vitest';
import {
  REALTIME_EVENT_TYPES,
  marketChannel,
  marketStatusEventSchema,
  marketTickEventSchema,
  marketTradeEventSchema,
  realtimeEventSchema,
  supersedes,
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
  fillId: '7',
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
const balance = { type: 'user:balance', availableP: '9480', lockedP: '0', ledgerEntryId: '42', ts };
const position = {
  type: 'user:position',
  marketId,
  outcome: 'YES',
  qty: 10,
  costBasisP: '520',
  realizedPnlP: '0',
  settled: false,
  version: 1,
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

describe('ordering keys', () => {
  it('requires a strictly ordered key on every event whose entity can change again', () => {
    // A millisecond ts can tie between two serialised writes (PLAN 8, ADR-0027): the key
    // is what the client orders by, so an event without one is refused.
    const { fillId: _fillId, ...tradeWithoutKey } = trade;
    expect(marketTradeEventSchema.safeParse(tradeWithoutKey).success).toBe(false);
    const { ledgerEntryId: _ledgerEntryId, ...balanceWithoutKey } = balance;
    expect(userBalanceEventSchema.safeParse(balanceWithoutKey).success).toBe(false);
    for (const bad of ['0', '', 'abc', '1.5', '-1']) {
      expect(userBalanceEventSchema.safeParse({ ...balance, ledgerEntryId: bad }).success).toBe(
        false,
      );
    }
    const { version: _version, ...positionWithoutKey } = position;
    expect(userPositionEventSchema.safeParse(positionWithoutKey).success).toBe(false);
    for (const bad of [0, 1.5, -1, '1']) {
      expect(userPositionEventSchema.safeParse({ ...position, version: bad }).success).toBe(false);
    }
    const { settled: _settled, ...positionWithoutSettled } = position;
    expect(userPositionEventSchema.safeParse(positionWithoutSettled).success).toBe(false);
  });

  it('supersedes compares keys as integers, not as strings', () => {
    expect(supersedes('10', '9')).toBe(true); // '10' < '9' as strings: the reason it exists
    expect(supersedes('9', '10')).toBe(false);
    expect(supersedes('10', '10')).toBe(false); // a duplicate is dropped
    expect(supersedes(2, 1)).toBe(true);
    expect(supersedes('10', 9)).toBe(true);
    expect(supersedes('1', null)).toBe(true); // nothing held yet takes anything
    expect(supersedes(1, undefined)).toBe(true);
  });
});
