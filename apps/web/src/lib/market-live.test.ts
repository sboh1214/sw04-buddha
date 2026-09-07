import {
  BP_MAX,
  MARKET_STATUSES,
  type MarketStatus,
  type MarketStatusEvent,
  type MarketTickEvent,
  type Outcome,
  PRICE_MAX,
  PRICE_MIN,
  SPARKLINE_MAX_POINTS,
  type UserBalanceEvent,
  type UserPositionEvent,
} from '@buddha/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type Market,
  type MarketListItem,
  type MarketSummary,
  type Me,
  type Position,
} from './api';
import {
  BalanceOrder,
  type MarketPages,
  Throttle,
  applyBalance,
  applyPositionEvent,
  applyStatus,
  applyTick,
  applyToPages,
  joinMarket,
  joinMarketPages,
  statusRank,
} from './market-live';

const ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const OTHER_ID = '9c858901-8a57-4791-81fe-4c455b099bc9';
const THIRD_ID = 'b7c9a1d2-6f34-4e58-9b0a-2d1e5f8c7a46';

const summary: MarketSummary = {
  id: ID,
  slug: 'rate-cut-2026',
  title: '기준금리 인하?',
  category: { slug: 'economy', nameKo: '경제' },
  imageUrl: null,
  status: 'open',
  lastPrice: 50,
  pYesBp: 5000,
  volumeP: '120000',
  tradeCount: 10,
  traderCount: 4,
  closeAt: '2026-10-01T00:00:00.000Z',
  openAt: '2026-09-01T00:00:00.000Z',
  resolvedResult: null,
  createdAt: '2026-08-30T00:00:00.000Z',
};

/** A list card: the same volatile fields plus the drawn samples. */
const card: MarketListItem = { ...summary, sparkline: [4800, 4900, 5000] };

/** The detail: the same volatile fields plus the ones only a resolution moves. */
const detail: Market = {
  ...summary,
  description: null,
  rules: '한국은행 발표 기준.',
  resolutionSource: null,
  resolvedAt: null,
  disputeUntil: null,
  settledAt: null,
  voidedAt: null,
};

const tick = (patch: Partial<MarketTickEvent> = {}): MarketTickEvent => ({
  type: 'market:tick',
  marketId: ID,
  pYesBp: 6300,
  lastPrice: 63,
  volumeP: '130000',
  tradeCount: 11,
  ts: '2026-09-07T00:00:00.000Z',
  ...patch,
});

const statusEvent = (patch: Partial<MarketStatusEvent> = {}): MarketStatusEvent => ({
  type: 'market:status',
  marketId: ID,
  status: 'closed',
  resolvedResult: null,
  disputeUntil: null,
  ts: '2026-09-07T00:00:00.000Z',
  ...patch,
});

const position: Position = {
  marketId: ID,
  marketSlug: 'rate-cut-2026',
  marketTitle: '기준금리 인하?',
  marketStatus: 'open',
  marketLastPrice: 50,
  resolvedResult: null,
  outcome: 'YES',
  qty: 10,
  costBasisP: '5000',
  realizedPnlP: '0',
  settled: false,
  version: 3,
  updatedAt: '2026-09-06T00:00:00.000Z',
};

const otherPosition: Position = { ...position, marketId: OTHER_ID, outcome: 'NO', version: 1 };

const positionEvent = (patch: Partial<UserPositionEvent> = {}): UserPositionEvent => ({
  type: 'user:position',
  marketId: ID,
  outcome: 'YES',
  qty: 14,
  costBasisP: '7000',
  realizedPnlP: '0',
  settled: false,
  version: 4,
  ts: '2026-09-07T00:00:00.000Z',
  ...patch,
});

const balanceEvent = (patch: Partial<UserBalanceEvent> = {}): UserBalanceEvent => ({
  type: 'user:balance',
  availableP: '90000',
  lockedP: '0',
  ledgerEntryId: '9',
  ts: '2026-09-07T00:00:00.000Z',
  ...patch,
});

const me: Me = {
  id: 'user-1',
  email: 'a@example.com',
  emailVerified: true,
  profile: { nickname: '테스터', role: 'user', createdAt: '2026-08-01T00:00:00.000Z' },
  balance: { availableP: '100000', lockedP: '0' },
  linkedAccounts: [],
};

/** The infinite-list shape: the last page ends the list, and the first page has no cursor. */
const pagesOf = (...pages: MarketListItem[][]): MarketPages => ({
  pages: pages.map((items, index) => ({
    items,
    nextCursor: index === pages.length - 1 ? null : `cursor-${String(index)}`,
  })),
  pageParams: [undefined, ...pages.slice(1).map((_page, index) => `cursor-${String(index)}`)],
});

describe('applyTick', () => {
  it('patches the volatile fields and leaves everything a REST answer owns alone', () => {
    expect(applyTick(detail, tick())).toEqual({
      ...detail,
      pYesBp: 6300,
      lastPrice: 63,
      volumeP: '130000',
      tradeCount: 11,
    });
  });

  it('writes nothing for a duplicate, a late event, another market or an empty cache', () => {
    // Equal is a duplicate and smaller is late: both cost no write, so `dataUpdatedAt` and
    // therefore `staleTime` stay where the last real answer left them.
    expect(applyTick(detail, tick({ tradeCount: detail.tradeCount }))).toBeUndefined();
    expect(applyTick(detail, tick({ tradeCount: detail.tradeCount - 1 }))).toBeUndefined();
    expect(applyTick(detail, tick({ marketId: OTHER_ID }))).toBeUndefined();
    expect(applyTick(undefined, tick())).toBeUndefined();
  });

  it('replaces the newest sparkline sample instead of pushing one', () => {
    // Pushing would slide the fixed hourly grid left on every trade and the drawn shape would
    // crawl, which is what PLAN 11.1-11.5 buys with a card that never moves under the cursor.
    const next = applyTick(card, tick());
    expect(next?.sparkline).toEqual([4800, 4900, 6300]);
    expect(next?.sparkline).toHaveLength(card.sparkline.length);
  });

  it('gives an empty sparkline one sample and never outgrows the grid', () => {
    expect(applyTick({ ...card, sparkline: [] }, tick())?.sparkline).toEqual([6300]);
    const full = { ...card, sparkline: Array.from({ length: SPARKLINE_MAX_POINTS }, () => 5000) };
    expect(applyTick(full, tick())?.sparkline).toHaveLength(SPARKLINE_MAX_POINTS);
  });
});

describe('statusRank', () => {
  /**
   * Every transition M3 can publish. `market:status` carries no ordering key, so this table is
   * the whole ordering argument (A-M3-19): M5's `result_changed` repeats `resolving` with a new
   * result, and the day it is added here this assertion goes red — which is the point. Fixing
   * it means putting `market_events.id` on the event and on the market DTOs, not widening this.
   */
  const TRANSITIONS: [MarketStatus, MarketStatus][] = [
    ['draft', 'open'],
    ['open', 'closed'],
    ['closed', 'resolving'],
    ['resolving', 'settled'],
    ['open', 'voided'],
    ['closed', 'voided'],
    ['resolving', 'voided'],
  ];

  it('rises on every M3 transition', () => {
    for (const [from, to] of TRANSITIONS) {
      expect(statusRank(to)).toBeGreaterThan(statusRank(from));
    }
  });

  it('gives each status its own rank, which is what makes the order total', () => {
    const ranks = MARKET_STATUSES.map(statusRank);
    expect(new Set(ranks).size).toBe(MARKET_STATUSES.length);
  });
});

describe('applyStatus', () => {
  const resolving: Market = {
    ...detail,
    status: 'resolving',
    resolvedResult: 'YES',
    disputeUntil: '2026-10-02T00:00:00.000Z',
  };

  it('replaces the result and the deadline, so a void clears both', () => {
    const next = applyStatus(resolving, statusEvent({ status: 'voided' }));
    expect(next?.status).toBe('voided');
    expect(next?.resolvedResult).toBeNull();
    expect(next?.disputeUntil).toBeNull();
  });

  it('writes nothing when the rank does not move forward', () => {
    const settled: Market = { ...detail, status: 'settled', resolvedResult: 'NO' };
    expect(applyStatus(settled, statusEvent({ status: 'resolving' }))).toBeUndefined();
    expect(applyStatus(settled, statusEvent({ status: 'settled' }))).toBeUndefined();
    expect(applyStatus(detail, statusEvent({ marketId: OTHER_ID }))).toBeUndefined();
    expect(applyStatus(undefined, statusEvent())).toBeUndefined();
  });

  it('never gives a card a dispute deadline it has no field for', () => {
    const proposed = statusEvent({
      status: 'resolving',
      resolvedResult: 'YES',
      disputeUntil: '2026-10-02T00:00:00.000Z',
    });
    expect(applyStatus(card, proposed)).toEqual({
      ...card,
      status: 'resolving',
      resolvedResult: 'YES',
    });
  });
});

describe('applyToPages', () => {
  const otherCard: MarketListItem = { ...card, id: OTHER_ID, slug: 'other', sparkline: [] };

  it('patches the page that holds the market and keeps the others by reference', () => {
    const held = pagesOf([card], [otherCard]);
    const next = applyToPages(held, (row) => applyTick(row, tick()));
    expect(next?.pages[0]?.items[0]?.pYesBp).toBe(6300);
    expect(next?.pages[1]).toBe(held.pages[1]);
    expect(next?.pageParams).toEqual(held.pageParams);
  });

  it('writes nothing when no page holds the market', () => {
    const held = pagesOf([otherCard]);
    expect(applyToPages(held, (row) => applyTick(row, tick()))).toBeUndefined();
    expect(applyToPages(undefined, (row) => applyTick(row, tick()))).toBeUndefined();
  });
});

describe('joinMarket', () => {
  const live: Market = {
    ...detail,
    pYesBp: 6300,
    lastPrice: 63,
    volumeP: '130000',
    tradeCount: 11,
  };
  const stale: Market = { ...detail, title: '10월 기준금리 인하?', traderCount: 9 };

  it('keeps the live stats under an older snapshot while taking its descriptive fields', () => {
    const joined = joinMarket(live, stale);
    expect(joined.pYesBp).toBe(6300);
    expect(joined.lastPrice).toBe(63);
    expect(joined.volumeP).toBe('130000');
    expect(joined.tradeCount).toBe(11);
    expect(joined.title).toBe(stale.title);
    expect(joined.traderCount).toBe(9);
  });

  it('keeps the higher status rank in both directions', () => {
    const closed: Market = { ...detail, status: 'closed' };
    expect(joinMarket(closed, detail).status).toBe('closed');
    expect(joinMarket(detail, closed).status).toBe('closed');
  });

  it('is idempotent, and answers the incoming row for an empty or foreign cache', () => {
    const joined = joinMarket(live, stale);
    expect(joinMarket(joined, stale)).toEqual(joined);
    expect(joinMarket(detail, detail)).toBe(detail);
    expect(joinMarket(undefined, detail)).toBe(detail);
    expect(joinMarket({ ...detail, id: OTHER_ID }, detail)).toBe(detail);
  });

  it('moves the newest sparkline sample with the probability it kept', () => {
    // The grid comes from the newer fetch, its last sample from the price we are keeping:
    // a card whose badge says 63% must not draw a line that ends at 50%.
    const liveCard: MarketListItem = {
      ...card,
      pYesBp: 6300,
      lastPrice: 63,
      tradeCount: 11,
      sparkline: [4800, 4900, 6300],
    };
    const staleCard: MarketListItem = { ...card, sparkline: [4900, 5000, 5000] };
    expect(joinMarket(liveCard, staleCard).sparkline).toEqual([4900, 5000, 6300]);
  });

  it('never lets either side lose ground, whichever snapshot arrives second', () => {
    const liveArb: fc.Arbitrary<Market> = fc
      .record({
        status: fc.constantFrom(...MARKET_STATUSES),
        lastPrice: fc.integer({ min: PRICE_MIN, max: PRICE_MAX }),
        pYesBp: fc.integer({ min: 0, max: BP_MAX }),
        volumeP: fc.integer({ min: 0, max: 1_000_000 }).map(String),
        tradeCount: fc.integer({ min: 0, max: 1000 }),
        resolvedResult: fc.constantFrom<Outcome | null>('YES', 'NO', null),
      })
      .map((fields) => ({ ...detail, ...fields }));

    fc.assert(
      fc.property(liveArb, liveArb, (held, incoming) => {
        const joined = joinMarket(held, incoming);
        expect(joined.tradeCount).toBe(Math.max(held.tradeCount, incoming.tradeCount));
        expect(statusRank(joined.status)).toBe(
          Math.max(statusRank(held.status), statusRank(incoming.status)),
        );
        // Absorbing: replaying the older snapshot over the join changes nothing, which is what
        // makes a duplicated refetch (two tabs, a reconnect) free.
        expect(joinMarket(joined, incoming)).toEqual(joined);
      }),
    );
  });
});

describe('joinMarketPages', () => {
  const otherCard: MarketListItem = { ...card, id: OTHER_ID, slug: 'other', sparkline: [] };
  const thirdCard: MarketListItem = { ...card, id: THIRD_ID, slug: 'third', sparkline: [] };

  it('takes the page shape from the incoming answer, so a moved row is not duplicated', () => {
    const held = pagesOf([card, otherCard], [thirdCard]);
    const incoming = pagesOf([otherCard, thirdCard], [card]);
    const joined = joinMarketPages(held, incoming);
    const ids = joined.pages.flatMap((page) => page.items.map((row) => row.id));
    expect(ids).toEqual([OTHER_ID, THIRD_ID, ID]);
    expect(joined.pages.map((page) => page.nextCursor)).toEqual(
      incoming.pages.map((page) => page.nextCursor),
    );
  });

  it('keeps a held row over the stale copy of it, and passes an unknown row through', () => {
    const held = pagesOf([{ ...card, pYesBp: 6300, lastPrice: 63, tradeCount: 11 }]);
    const incoming = pagesOf([card, otherCard]);
    const joined = joinMarketPages(held, incoming);
    expect(joined.pages[0]?.items[0]?.pYesBp).toBe(6300);
    expect(joined.pages[0]?.items[0]?.tradeCount).toBe(11);
    expect(joined.pages[0]?.items[1]).toBe(otherCard);
  });

  it('answers the incoming pages when nothing is held', () => {
    const incoming = pagesOf([card]);
    expect(joinMarketPages(undefined, incoming)).toBe(incoming);
  });
});

describe('applyPositionEvent', () => {
  const held = [position, otherPosition];

  it('replaces the row the event names and leaves the others alone', () => {
    const patch = applyPositionEvent(held, positionEvent());
    expect(patch).toEqual({
      kind: 'replace',
      positions: [
        {
          ...position,
          qty: 14,
          costBasisP: '7000',
          version: 4,
          updatedAt: '2026-09-07T00:00:00.000Z',
        },
        otherPosition,
      ],
    });
    // The held array is never mutated: react-query compares references to decide a re-render.
    expect(held[0]).toBe(position);
  });

  it('asks for a refetch rather than synthesising a row it cannot build', () => {
    // The event has no marketSlug/marketTitle/marketStatus/marketLastPrice, so an unknown
    // (market, outcome) pair can only be filled in by asking the API.
    expect(applyPositionEvent(held, positionEvent({ marketId: THIRD_ID }))).toEqual({
      kind: 'refetch',
    });
    expect(applyPositionEvent(held, positionEvent({ outcome: 'NO' }))).toEqual({ kind: 'refetch' });
  });

  it('ignores a duplicate or late version, and an empty cache', () => {
    expect(applyPositionEvent(held, positionEvent({ version: 3 }))).toEqual({ kind: 'none' });
    expect(applyPositionEvent(held, positionEvent({ version: 2 }))).toEqual({ kind: 'none' });
    expect(applyPositionEvent(undefined, positionEvent())).toEqual({ kind: 'none' });
  });
});

describe('applyBalance', () => {
  it('patches the balance and leaves the rest of the profile alone', () => {
    expect(applyBalance(me, balanceEvent({ availableP: '80000', lockedP: '1200' }))).toEqual({
      ...me,
      balance: { availableP: '80000', lockedP: '1200' },
    });
  });

  it('never invents a Me for a visitor who is not signed in', () => {
    expect(applyBalance(undefined, balanceEvent())).toBeUndefined();
  });
});

describe('BalanceOrder', () => {
  it('takes the first event, then only strictly newer ledger rows', () => {
    const order = new BalanceOrder();
    expect(order.accept(balanceEvent({ ledgerEntryId: '9' }))).toBe(true);
    expect(order.accept(balanceEvent({ ledgerEntryId: '9' }))).toBe(false);
    expect(order.accept(balanceEvent({ ledgerEntryId: '8' }))).toBe(false);
    // Compared as integers, not as strings, where '10' would sort before '9'.
    expect(order.accept(balanceEvent({ ledgerEntryId: '10' }))).toBe(true);
  });

  it('takes the first event again after a reset, whatever it has seen', () => {
    const order = new BalanceOrder();
    expect(order.accept(balanceEvent({ ledgerEntryId: '100' }))).toBe(true);
    order.reset();
    expect(order.accept(balanceEvent({ ledgerEntryId: '1' }))).toBe(true);
  });
});

describe('Throttle', () => {
  it('allows one action per key per window', () => {
    const throttle = new Throttle(1000);
    expect(throttle.take(ID, 0)).toBe(true);
    expect(throttle.take(ID, 999)).toBe(false);
    expect(throttle.take(ID, 1000)).toBe(true);
  });

  it('counts each key on its own', () => {
    const throttle = new Throttle(1000);
    expect(throttle.take(ID, 0)).toBe(true);
    expect(throttle.take(OTHER_ID, 0)).toBe(true);
    expect(throttle.take(OTHER_ID, 500)).toBe(false);
  });
});
