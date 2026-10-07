import { describe, expect, it } from 'vitest';
import {
  MARKET_CHANNEL_PATTERN,
  REALTIME_EVENT_TYPES,
  REALTIME_MAX_MESSAGE_BYTES,
  REALTIME_NAMESPACE,
  REALTIME_ROOMS_MAX,
  REALTIME_SUBSCRIBE_MAX,
  REALTIME_EXCEPTION_EVENT,
  RESYNC_EVENT,
  USER_CHANNEL_PATTERN,
  marketChannel,
  marketRealtimeEventSchema,
  marketStatusEventSchema,
  marketTickEventSchema,
  marketTradeEventSchema,
  realtimeEventSchema,
  statusRank,
  statusSupersedes,
  subscribeBodySchema,
  supersedes,
  userBalanceEventSchema,
  userChannel,
  userPositionEventSchema,
  userRealtimeEventSchema,
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
  traderCount: 1,
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
  status: 'resolved',
  resolvedResult: 'YES',
  statusEventId: '12',
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

  it('lets a status event omit or null the resolution fields, but never its ordering key', () => {
    const opened = { type: 'market:status', marketId, status: 'open', statusEventId: '3', ts };
    expect(realtimeEventSchema.parse(opened)).toEqual(opened);
    expect(realtimeEventSchema.parse({ ...opened, resolvedResult: null })).toEqual({
      ...opened,
      resolvedResult: null,
    });
    expect(realtimeEventSchema.safeParse({ ...opened, status: 'paused' }).success).toBe(false);
    // The key may be null (a row with no transition event) but a publisher must say so.
    expect(realtimeEventSchema.parse({ ...opened, statusEventId: null }).type).toBe(
      'market:status',
    );
    const { statusEventId: _key, ...withoutKey } = opened;
    expect(marketStatusEventSchema.safeParse(withoutKey).success).toBe(false);
    expect(marketStatusEventSchema.safeParse({ ...opened, statusEventId: '0' }).success).toBe(
      false,
    );
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

  it('orders market:status by the transition event id, and by rank only without one', () => {
    const resolvedYes = { status: 'resolved', statusEventId: '10' } as const;
    // The same status with a newer event id is a later transition (M5's legacy result_changed)
    // — the case rank order could not express, and the reason the key exists (A-M3-19).
    expect(statusSupersedes({ status: 'resolved', statusEventId: '11' }, resolvedYes)).toBe(true);
    // The admin edit's repeat (A-M4-36) and a duplicate carry the SAME id: dropped.
    expect(statusSupersedes({ status: 'resolved', statusEventId: '10' }, resolvedYes)).toBe(false);
    // A late event with a lower id loses even when its status ranks higher: the key, not the
    // rank, is the order once both sides have one. The API publishes `resolved` and the worker
    // `settled` moments apart, so they can arrive in either order; `settled` must stay.
    expect(statusSupersedes({ status: 'settled', statusEventId: '9' }, resolvedYes)).toBe(false);
    expect(statusSupersedes({ status: 'settled', statusEventId: '12' }, resolvedYes)).toBe(true);
    expect(statusSupersedes(resolvedYes, { status: 'settled', statusEventId: '12' })).toBe(false);
    // Rank is the fallback for a row without a key (a test factory's), on either side.
    expect(
      statusSupersedes(
        { status: 'closed', statusEventId: '5' },
        { status: 'open', statusEventId: null },
      ),
    ).toBe(true);
    expect(
      statusSupersedes(
        { status: 'open', statusEventId: null },
        { status: 'closed', statusEventId: '5' },
      ),
    ).toBe(false);
    expect(
      statusSupersedes(
        { status: 'open', statusEventId: undefined },
        { status: 'open', statusEventId: null },
      ),
    ).toBe(false);
    expect(statusRank('draft')).toBe(0);
    expect(statusRank('voided')).toBe(5);
  });
});

describe('subscribe payload', () => {
  const maxIds = Array.from({ length: REALTIME_SUBSCRIBE_MAX }, () => marketId);

  it('canonicalises ids so a socket joins the room the publisher writes to (A-M3-17)', () => {
    expect(subscribeBodySchema.parse({ marketIds: [marketId.toUpperCase()] })).toEqual({
      marketIds: [marketId],
    });
  });

  it('bounds the batch and refuses anything that is not a list of uuids', () => {
    expect(subscribeBodySchema.safeParse({ marketIds: maxIds }).success).toBe(true);
    expect(subscribeBodySchema.safeParse({ marketIds: [...maxIds, marketId] }).success).toBe(false);
    expect(subscribeBodySchema.safeParse({ marketIds: [] }).success).toBe(false);
    expect(subscribeBodySchema.safeParse({ marketIds: marketId }).success).toBe(false);
    expect(subscribeBodySchema.safeParse({}).success).toBe(false);
    expect(subscribeBodySchema.safeParse([marketId]).success).toBe(false);
    expect(subscribeBodySchema.safeParse(marketId).success).toBe(false);
    expect(subscribeBodySchema.safeParse(undefined).success).toBe(false);
  });

  it('names the offending element, so the ack can say which id was refused', () => {
    const result = subscribeBodySchema.safeParse({ marketIds: [marketId, 'not-a-uuid'] });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['marketIds', 1]);
    expect(result.error?.issues[0]?.message).toBe('must be a uuid');
  });
});

describe('per-family event unions', () => {
  const marketEvents = [tick, trade, status];
  const userEvents = [balance, position];

  it('parses its own family and refuses the other, which is the authorization check', () => {
    for (const event of marketEvents) {
      expect(marketRealtimeEventSchema.parse(event)).toEqual(event);
      // A market:* message carrying a user event must not reach that public room.
      expect(userRealtimeEventSchema.safeParse(event).success).toBe(false);
    }
    for (const event of userEvents) {
      expect(userRealtimeEventSchema.parse(event)).toEqual(event);
      expect(marketRealtimeEventSchema.safeParse(event).success).toBe(false);
    }
  });

  it('together claim every published type exactly once, and gate as strictly as the union', () => {
    const claimed = [...marketEvents, ...userEvents].map((event) => event.type);
    expect([...REALTIME_EVENT_TYPES].sort()).toEqual([...claimed].sort());
    expect(marketRealtimeEventSchema.safeParse({ ...tick, pYesBp: 10_001 }).success).toBe(false);
    expect(marketRealtimeEventSchema.safeParse({ ...trade, fillId: '0' }).success).toBe(false);
    expect(userRealtimeEventSchema.safeParse({ ...balance, availableP: 9480 }).success).toBe(false);
    expect(userRealtimeEventSchema.safeParse({}).success).toBe(false);
  });
});

describe('gateway protocol (M4)', () => {
  it('keeps realtime:resync out of the published union', () => {
    // A control event the gateway raises on its own after re-arming its Redis subscription:
    // it is never published to Redis, so nothing may parse it as a RealtimeEvent.
    expect(RESYNC_EVENT).toBe('realtime:resync');
    // Both sides of the socket read these two names from here, so a drift is a test failure
    // rather than a client that silently never hears a refusal.
    expect(REALTIME_EXCEPTION_EVENT).toBe('exception');
    expect(REALTIME_EVENT_TYPES).not.toContain(REALTIME_EXCEPTION_EVENT);
    expect(REALTIME_EVENT_TYPES).not.toContain(RESYNC_EVENT);
    expect(realtimeEventSchema.safeParse({ type: RESYNC_EVENT }).success).toBe(false);
    expect(realtimeEventSchema.safeParse({ type: RESYNC_EVENT, marketId, ts }).success).toBe(false);
    expect(marketRealtimeEventSchema.safeParse({ type: RESYNC_EVENT, marketId, ts }).success).toBe(
      false,
    );
  });

  it('psubscribes to patterns that cover the channels the publisher writes', () => {
    expect(REALTIME_NAMESPACE).toBe('/ws');
    expect(marketChannel(marketId).startsWith(MARKET_CHANNEL_PATTERN.slice(0, -1))).toBe(true);
    expect(userChannel('user-1').startsWith(USER_CHANNEL_PATTERN.slice(0, -1))).toBe(true);
  });

  it('sizes the caps so a full subscribe fits in one accepted frame', () => {
    // A socket fills its room budget over several messages, so one batch stays the smaller cap.
    expect(REALTIME_SUBSCRIBE_MAX).toBeLessThanOrEqual(REALTIME_ROOMS_MAX);
    const largest = JSON.stringify({
      marketIds: Array.from({ length: REALTIME_SUBSCRIBE_MAX }, () => marketId),
    });
    expect(largest.length).toBeLessThan(REALTIME_MAX_MESSAGE_BYTES);
  });
});
