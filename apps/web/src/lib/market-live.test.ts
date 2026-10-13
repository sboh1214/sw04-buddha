import {
  MARKET_STATUSES,
  type MarketStatusEvent,
  type MarketTickEvent,
  type Outcome,
  PRICE_MAX,
  PRICE_MIN,
  REALTIME_SUBSCRIBE_MAX,
  SPARKLINE_MAX_POINTS,
  type UserBalanceEvent,
  type UserPositionEvent,
  supersedes,
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
  applyBalanceEvent,
  applyPositionEvent,
  applyStatus,
  applyTick,
  applyToPages,
  chunkIds,
  joinMarket,
  joinMarketPages,
  joinPositions,
  wroteAnOrder,
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
  volumeP: '120000',
  tradeCount: 10,
  traderCount: 4,
  closeAt: '2026-10-01T00:00:00.000Z',
  openAt: '2026-09-01T00:00:00.000Z',
  resolvedResult: null,
  // The `opened` event (`created` is 1): the key every transition below is compared against.
  statusEventId: '2',
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
  settledAt: null,
  voidedAt: null,
};

const tick = (patch: Partial<MarketTickEvent> = {}): MarketTickEvent => ({
  type: 'market:tick',
  marketId: ID,
  lastPrice: 63,
  volumeP: '130000',
  tradeCount: 11,
  traderCount: 5,
  ts: '2026-09-07T00:00:00.000Z',
  ...patch,
});

const statusEvent = (patch: Partial<MarketStatusEvent> = {}): MarketStatusEvent => ({
  type: 'market:status',
  marketId: ID,
  status: 'closed',
  resolvedResult: null,
  // One transition after the `opened` the fixtures hold, so the default event is newer.
  statusEventId: '3',
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
  contact: null,
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
      lastPrice: 63,
      volumeP: '130000',
      tradeCount: 11,
      // Moves with the same trade, so the patch carries it: a first-time buyer raises it, and
      // leaving it behind kept the header's 참여자 stale for as long as the market stayed busy.
      traderCount: 5,
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

  it('samples the fill price in the sparkline basis points, and nothing without one', () => {
    // The samples are tick basis points and a fill's price is a whole percent.
    expect(applyTick(card, tick({ lastPrice: 41 }))?.sparkline).toEqual([4800, 4900, 4100]);
    // No fill price (체결 없음): the line stays as fetched rather than ending on a made-up level.
    const next = applyTick(card, tick({ lastPrice: null }));
    expect(next?.lastPrice).toBeNull();
    expect(next?.sparkline).toEqual(card.sparkline);
  });
});

describe('applyStatus', () => {
  /** The market after the admin judged 예: the `resolved` event is event 4 of this market. */
  const resolved: Market = {
    ...detail,
    status: 'resolved',
    resolvedResult: 'YES',
    statusEventId: '4',
  };

  it('walks closed → resolved → settled, each event carrying the result its transition wrote', () => {
    // ADR-0046: the 판정 is final at once (`resolved`, published by the API) and the worker's
    // settlement follows moments later (`settled`). Every row on screen holds exactly the
    // status group the latest transition delivered — nothing else (the detail has no dispute
    // deadline to carry any more).
    const closed = applyStatus(detail, statusEvent({ status: 'closed', statusEventId: '3' }));
    expect(closed).toEqual({ ...detail, status: 'closed', statusEventId: '3' });
    const judged = applyStatus(
      closed,
      statusEvent({ status: 'resolved', resolvedResult: 'YES', statusEventId: '4' }),
    );
    expect(judged).toEqual(resolved);
    const settled = applyStatus(
      judged,
      statusEvent({ status: 'settled', resolvedResult: 'YES', statusEventId: '5' }),
    );
    expect(settled).toEqual({ ...resolved, status: 'settled', statusEventId: '5' });
    expect(settled).not.toHaveProperty('disputeUntil');
  });

  it('keeps settled when the judgement arrives after it', () => {
    // The API publishes `resolved` and the worker `settled` from two processes, moments apart,
    // so the socket may deliver them in either order. The key decides: `resolved` (4) is not
    // newer than `settled` (5), and the screen stays on 정산 완료.
    const settled: Market = { ...resolved, status: 'settled', statusEventId: '5' };
    expect(
      applyStatus(
        settled,
        statusEvent({ status: 'resolved', resolvedResult: 'YES', statusEventId: '4' }),
      ),
    ).toBeUndefined();
  });

  it('replaces the result, so a void clears the one a row held', () => {
    // Nothing voids a market since #125 (VOID comes back as a 판정 with #152) — but the reducer
    // replaces rather than merges, so an event never inherits a result its own
    // transition did not carry.
    const next = applyStatus(resolved, statusEvent({ status: 'voided', statusEventId: '5' }));
    expect(next?.status).toBe('voided');
    expect(next?.resolvedResult).toBeNull();
    expect(next?.statusEventId).toBe('5');
  });

  it('takes the same status under a newer key as a later transition', () => {
    // THE DAY the rank order stopped holding (A-M3-19): M5's legacy `result_changed` repeated a
    // status with a new result, and rank alone could only drop it. The event id says it is a
    // LATER transition, so the whole status group is replaced — a rule the reducer keeps for
    // any transition that repeats a status.
    const repeated = statusEvent({ status: 'resolved', resolvedResult: 'NO', statusEventId: '5' });
    expect(applyStatus(resolved, repeated)).toEqual({
      ...resolved,
      resolvedResult: 'NO',
      statusEventId: '5',
    });
  });

  it('drops an equal or lower key even when the status itself ranks higher', () => {
    // Equal is a duplicate and lower is late, whatever the status says: a `settled` under key 4
    // cannot be newer than the `resolved` key 4 wrote, and a status is not a counter. The
    // out-of-band cases — another market, an empty cache — write nothing either.
    expect(
      applyStatus(resolved, statusEvent({ status: 'settled', statusEventId: '4' })),
    ).toBeUndefined();
    expect(
      applyStatus(resolved, statusEvent({ status: 'settled', statusEventId: '3' })),
    ).toBeUndefined();
    expect(applyStatus(detail, statusEvent({ marketId: OTHER_ID }))).toBeUndefined();
    expect(applyStatus(undefined, statusEvent())).toBeUndefined();
  });

  it('falls back to the status rank when either side has no key, in both directions', () => {
    // A row a test factory wrote carries no `statusEventId`, and neither does an event
    // published for one. Rank is the one order such a row can still join, so a keyed event
    // over an unkeyed row and an unkeyed event over a keyed row both go by status alone.
    const unkeyed: Market = { ...detail, statusEventId: null };
    expect(applyStatus(unkeyed, statusEvent({ status: 'closed' }))?.status).toBe('closed');
    expect(
      applyStatus(unkeyed, statusEvent({ status: 'open', statusEventId: '9' })),
    ).toBeUndefined();
    const closedByNull = applyStatus(
      detail,
      statusEvent({ status: 'closed', statusEventId: null }),
    );
    expect(closedByNull?.status).toBe('closed');
    // The key follows the event even when it is null: the row now reads as an unkeyed one.
    expect(closedByNull?.statusEventId).toBeNull();
    expect(
      applyStatus(detail, statusEvent({ status: 'open', statusEventId: null })),
    ).toBeUndefined();
  });

  it('drops the repeat an admin edit publishes, so the edit arrives by refetch alone', () => {
    // `update` republishes the unchanged status under the UNCHANGED key after an edit that moves
    // an open market (A-M4-36). The event carries no `closeAt`, so applying it could only restate
    // the row — and a later `closed` under a newer key still wins, which is why a repeat is safe.
    expect(
      applyStatus(detail, statusEvent({ status: 'open', statusEventId: '2' })),
    ).toBeUndefined();
    expect(applyStatus(card, statusEvent({ status: 'open', statusEventId: '2' }))).toBeUndefined();
    expect(applyStatus(detail, statusEvent({ status: 'closed' }))?.status).toBe('closed');
  });

  it('moves a card by the same status group, and nothing else', () => {
    const judged = statusEvent({ status: 'resolved', resolvedResult: 'YES', statusEventId: '4' });
    expect(applyStatus(card, judged)).toEqual({
      ...card,
      status: 'resolved',
      resolvedResult: 'YES',
      statusEventId: '4',
    });
  });

  it('ignores a disputeUntil an old publisher still sends', () => {
    // During the deploy window an API or worker built before ADR-0046 may still publish the
    // field; `marketStatusEventSchema` strips it on parse, and the reducer never reads it, so
    // the row gains no field the DTO no longer has.
    const legacy = {
      ...statusEvent({ status: 'settled', resolvedResult: 'NO', statusEventId: '5' }),
      disputeUntil: '2026-10-02T00:00:00.000Z',
    } as MarketStatusEvent;
    const next = applyStatus(detail, legacy);
    expect(next?.status).toBe('settled');
    expect(next).not.toHaveProperty('disputeUntil');
  });
});

describe('applyToPages', () => {
  const otherCard: MarketListItem = { ...card, id: OTHER_ID, slug: 'other', sparkline: [] };

  it('patches the page that holds the market and keeps the others by reference', () => {
    const held = pagesOf([card], [otherCard]);
    const next = applyToPages(held, (row) => applyTick(row, tick()));
    expect(next?.pages[0]?.items[0]?.lastPrice).toBe(63);
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
    lastPrice: 63,
    volumeP: '130000',
    tradeCount: 11,
    traderCount: 7,
  };
  const stale: Market = { ...detail, title: '10월 기준금리 인하?', traderCount: 9 };

  it('keeps the live stats under an older snapshot while taking its descriptive fields', () => {
    const joined = joinMarket(live, stale);
    expect(joined.lastPrice).toBe(63);
    expect(joined.volumeP).toBe('130000');
    expect(joined.tradeCount).toBe(11);
    expect(joined.title).toBe(stale.title);
    // `traderCount` rides with the price, NOT with the descriptive fields: a trade moves it, so
    // an older snapshot must not drag the participant count back under a newer probability —
    // even though this stale answer names a higher one.
    expect(joined.traderCount).toBe(7);
  });

  it('keeps the newer transition in both directions', () => {
    const closed: Market = { ...detail, status: 'closed', statusEventId: '3' };
    expect(joinMarket(closed, detail).status).toBe('closed');
    expect(joinMarket(detail, closed).status).toBe('closed');
  });

  it('keeps the higher key with its result, whatever the status says', () => {
    // THE RACE the key exists for: the socket delivered the worker's `settled` (key 5), and a
    // `GET /markets/:id` that left before the 판정 lands after it — `closed`, no result. The group
    // moves as one: a row that kept `settled` with the snapshot's null result would badge
    // 정산 완료 over no answer at all.
    const closed: Market = { ...detail, status: 'closed', statusEventId: '3' };
    const settled: Market = {
      ...detail,
      status: 'settled',
      resolvedResult: 'NO',
      statusEventId: '5',
    };
    for (const joined of [joinMarket(settled, closed), joinMarket(closed, settled)]) {
      expect(joined.status).toBe('settled');
      expect(joined.statusEventId).toBe('5');
      expect(joined.resolvedResult).toBe('NO');
    }
    // And the key, not the status, decides. Synthetic — `settled` is terminal, so no market ever
    // produces this pair — but it pins that the status is never consulted while both sides carry
    // a key: a lower key is an earlier commit, and the row follows the commit.
    const resolved: Market = { ...settled, status: 'resolved', statusEventId: '6' };
    const staleSettled: Market = { ...settled, statusEventId: '4' };
    expect(joinMarket(resolved, staleSettled).status).toBe('resolved');
    expect(joinMarket(staleSettled, resolved).status).toBe('resolved');
  });

  it('falls back to rank for a snapshot with no key, so a factory row still joins', () => {
    const unkeyedClosed: Market = { ...detail, status: 'closed', statusEventId: null };
    expect(joinMarket(unkeyedClosed, detail).status).toBe('closed');
    expect(joinMarket(detail, unkeyedClosed).status).toBe('closed');
  });

  it('is idempotent, and answers the incoming row for an empty or foreign cache', () => {
    const joined = joinMarket(live, stale);
    expect(joinMarket(joined, stale)).toEqual(joined);
    expect(joinMarket(detail, detail)).toBe(detail);
    expect(joinMarket(undefined, detail)).toBe(detail);
    expect(joinMarket({ ...detail, id: OTHER_ID }, detail)).toBe(detail);
  });

  it('moves the newest sparkline sample with the price it kept', () => {
    // The grid comes from the newer fetch, its last sample from the price we are keeping:
    // a card whose pill says 63% must not draw a line that ends at 50%.
    const liveCard: MarketListItem = {
      ...card,
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
        lastPrice: fc.option(fc.integer({ min: PRICE_MIN, max: PRICE_MAX })),
        volumeP: fc.integer({ min: 0, max: 1_000_000 }).map(String),
        tradeCount: fc.integer({ min: 0, max: 1000 }),
        resolvedResult: fc.constantFrom<Outcome | null>('YES', 'NO', null),
        // Keyed on both sides: the status is then never consulted, so it is drawn freely above
        // and the assertion is on the key alone. The unkeyed fallback has its own test.
        statusEventId: fc.integer({ min: 1, max: 1000 }).map(String),
      })
      .map((fields) => ({ ...detail, ...fields }));

    fc.assert(
      fc.property(liveArb, liveArb, (held, incoming) => {
        const joined = joinMarket(held, incoming);
        expect(joined.tradeCount).toBe(Math.max(held.tradeCount, incoming.tradeCount));
        // Compared as integers, the way `supersedes` compares: '10' is later than '9'.
        expect(Number(joined.statusEventId)).toBe(
          Math.max(Number(held.statusEventId), Number(incoming.statusEventId)),
        );
        // The whole group rides with the key: the status is the one the winning key wrote.
        const winner = supersedes(held.statusEventId ?? '0', incoming.statusEventId ?? '0')
          ? held
          : incoming;
        expect(joined.status).toBe(winner.status);
        expect(joined.resolvedResult).toBe(winner.resolvedResult);
        // Absorbing: replaying the older snapshot over the join changes nothing, which is what
        // makes a duplicated refetch (two tabs, a reconnect) free.
        expect(joinMarket(joined, incoming)).toEqual(joined);
        // Order-independent up to a tie, where `incoming` wins because `supersedes` is strict —
        // so with both keys distinct, the two interleavings end on the same row.
        if (
          held.statusEventId !== incoming.statusEventId &&
          held.tradeCount !== incoming.tradeCount
        ) {
          expect(joinMarket(incoming, held)).toEqual(joined);
        }
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
    const held = pagesOf([{ ...card, lastPrice: 63, tradeCount: 11 }]);
    const incoming = pagesOf([card, otherCard]);
    const joined = joinMarketPages(held, incoming);
    expect(joined.pages[0]?.items[0]?.lastPrice).toBe(63);
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

  it('ignores a duplicate or late version', () => {
    expect(applyPositionEvent(held, positionEvent({ version: 3 }))).toEqual({ kind: 'none' });
    expect(applyPositionEvent(held, positionEvent({ version: 2 }))).toEqual({ kind: 'none' });
  });

  it('asks again for a list that has answered nothing yet, rather than dropping the event', () => {
    // The caller only asks about a query the cache already HOLDS, so an empty list is not an
    // absent screen — it is one whose FIRST `GET /me/positions` is in flight, and that request
    // left before the trade this event announces. Answering `none` let the pre-trade answer
    // land and stand: 보유 없음 on a market the account had just bought into.
    expect(applyPositionEvent(undefined, positionEvent())).toEqual({ kind: 'refetch' });
  });

  it('asks rather than writing a settled row back into the list it just left', () => {
    // THE HAZARD: `settled` is the flag `GET /me/positions?status=` filters on, so a settlement
    // MOVES the row to the other list. Writing it back in place broke the invariant
    // `realizedPnlAcross` states in writing — "a row MOVES between the two lists … so it is
    // never in both and this cannot double count" — and the double count was the visible half:
    // the finished row stayed in `['positions', 'open']` carrying its realised PnL while 정산
    // 이력 fetched the same row, and 총 실현 손익 printed 500P for one 250P row. The write also
    // refreshed `dataUpdatedAt`, so the poisoned list sat inside `staleTime` and the next mount
    // did not correct it.
    expect(applyPositionEvent(held, positionEvent({ settled: true, version: 5 }))).toEqual({
      kind: 'refetch',
    });
    // Not a policy about the word `settled`: it is the CHANGE that moves the row. A settled row
    // taking a settled event is an ordinary patch of the list it is already in.
    const settledHeld = held.map((row) => ({ ...row, settled: true }));
    expect(applyPositionEvent(settledHeld, positionEvent({ settled: true, version: 5 })).kind).toBe(
      'replace',
    );
  });

  it('says nothing to the settled list about an unsettled event, which is the storm', () => {
    // THE HAZARD: `refetch` is this reducer's answer for a row the cache does not hold, and the
    // settled list holds no UNSETTLED row by definition — so on /portfolio, where both lists are
    // mounted, every ordinary trade reported an expected absence as a gap and the handler
    // restarted the whole `['positions']` root. Measured before the fix: five of the account's
    // own trades cost ten requests, with the open list already patched in place each time.
    expect(applyPositionEvent([], positionEvent(), 'settled')).toEqual({ kind: 'none' });
    expect(applyPositionEvent(held, positionEvent(), 'settled')).toEqual({ kind: 'none' });
    // Sound only because settlement is TERMINAL: nothing ever writes `settled: false` over an
    // existing row (trade.service.ts writes it on INSERT alone), so such a row was never in the
    // settled list and cannot have left it.
  });

  it('still restarts the OPEN list on a settlement, even when that list holds no such row', () => {
    // The half that must NOT be swept up with it: a settled event means the row LEFT the open
    // list, and that list's first fetch may be in flight and about to land with it still
    // unsettled. This is the membership guard from the other side, so the general form ("ignore
    // any list the event does not belong to") is deliberately not what the branch above says.
    expect(applyPositionEvent(undefined, positionEvent({ settled: true }), 'open')).toEqual({
      kind: 'refetch',
    });
    expect(applyPositionEvent([], positionEvent({ settled: true }), 'open')).toEqual({
      kind: 'refetch',
    });
    // And a held row that has just moved out of this list still asks, as it did before.
    expect(applyPositionEvent(held, positionEvent({ settled: true, version: 5 }), 'open')).toEqual({
      kind: 'refetch',
    });
  });

  it('is unchanged for a key that names no list', () => {
    // An unsuffixed `['positions']` root is not built anywhere today, but the reducer must not
    // guess at one: no status means the old, safe reading.
    expect(applyPositionEvent([], positionEvent()).kind).toBe('refetch');
    expect(applyPositionEvent([], positionEvent(), undefined).kind).toBe('refetch');
  });

  it('orders before it asks, so a late settlement event costs no request', () => {
    // The membership test sits AFTER the version check: a duplicate delivery of the same
    // settlement would otherwise buy a private refetch per copy, in every signed-in tab.
    expect(applyPositionEvent(held, positionEvent({ settled: true, version: 3 }))).toEqual({
      kind: 'none',
    });
  });
});

describe('wroteAnOrder', () => {
  it('asks for 주문 이력 on a trade and never on a settlement, which writes no order row', () => {
    // 주문 이력 has no reducer and no event of its own — an `Order` carries an id, status,
    // filledQty, amountP and priceAvgBp that no `user:` event does — so a trade's row can only
    // be asked for. A settlement moves positions and balances and inserts NO order, so the same
    // request could answer only what the list holds:
    // one private refetch per holder per settled market, for nothing.
    expect(wroteAnOrder(positionEvent())).toBe(true);
    expect(wroteAnOrder(positionEvent({ settled: true }))).toBe(false);
    // The flag, not the shape of the change: a settlement that closes a row out to qty 0 and a
    // sell that does the same are told apart by `settled` alone.
    expect(wroteAnOrder(positionEvent({ qty: 0, settled: false }))).toBe(true);
    expect(wroteAnOrder(positionEvent({ qty: 0, settled: true }))).toBe(false);
  });
});

describe('joinPositions', () => {
  /** The row as a REST answer that left BEFORE the trade carries it: one version behind. */
  const stale: Position = { ...position, qty: 10, costBasisP: '5000', version: 3 };
  /** The same row after a `user:position` event applied the trade. */
  const live: Position = {
    ...position,
    qty: 14,
    costBasisP: '7000',
    realizedPnlP: '120',
    version: 4,
    updatedAt: '2026-09-07T00:00:00.000Z',
  };

  it('keeps the newer held row under a late answer while taking its descriptive fields', () => {
    // THE RACE: a mount or a focus refetch left before another tab's trade and lands after the
    // event. Without the join 내 포지션 and 평가손익 fall back to the pre-trade row and
    // nothing is scheduled to correct them.
    const renamed = { ...stale, marketTitle: '기준금리 인하? (수정)', marketLastPrice: 63 };
    expect(joinPositions([live], [renamed])).toEqual([
      {
        ...renamed,
        qty: 14,
        costBasisP: '7000',
        realizedPnlP: '120',
        settled: false,
        version: 4,
        updatedAt: '2026-09-07T00:00:00.000Z',
      },
    ]);
  });

  it('takes a strictly newer answer whole, including a tie', () => {
    // `supersedes` is strict, so an answer at the same version wins: it is the fuller row.
    expect(joinPositions([stale], [live])).toEqual([live]);
    expect(joinPositions([live], [live])).toEqual([live]);
  });

  it('takes the list from the incoming answer, which is the only thing that knows it', () => {
    // A settled market moves the row to the other list, and a first trade adds one. Neither is
    // knowable from the held array, so membership is never merged.
    expect(joinPositions([live, otherPosition], [live])).toEqual([live]);
    expect(joinPositions([live], [live, otherPosition])).toEqual([live, otherPosition]);
    expect(joinPositions(undefined, [stale])).toEqual([stale]);
  });

  it('keys on (marketId, outcome), so the other side of one market is untouched', () => {
    const otherSide: Position = { ...live, outcome: 'NO', qty: 2, version: 9 };
    expect(joinPositions([otherSide], [stale])).toEqual([stale]);
  });

  it('is idempotent and order-independent, whichever snapshot arrives second', () => {
    const once = joinPositions([live], [stale]);
    expect(joinPositions(once, [stale])).toEqual(once);
    // Both interleavings end on the same row, which is what makes the join safe for a cache
    // more than one writer shares (REST, socket).
    expect(joinPositions(joinPositions([stale], [live]), [stale])).toEqual(once);
  });
});

describe('applyBalanceEvent', () => {
  it('patches the balance and leaves the rest of the profile alone', () => {
    expect(applyBalanceEvent(me, balanceEvent({ availableP: '80000', lockedP: '1200' }))).toEqual({
      kind: 'replace',
      me: { ...me, balance: { availableP: '80000', lockedP: '1200' } },
    });
  });

  it('asks for the profile rather than inventing one it cannot build', () => {
    // Never a `Me` synthesised from the event — it carries two amounts and no profile — and
    // never "do nothing" either: the caller cancels the in-flight `GET /me` before it writes,
    // so a tab that is still loading would be left on a skeleton with nothing to restart it.
    expect(applyBalanceEvent(undefined, balanceEvent())).toEqual({ kind: 'refetch' });
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

  it('keeps its watermark for the life of the tab, because there is nothing to clear it with', () => {
    // The guard is the ABSENCE of a `reset()`. It had one, called from `resnapshot()` on every
    // reconnect and every `realtime:resync` — which threw away a bound that was still true and
    // re-opened the one window this class cannot order (its first event, which `supersedes(x,
    // null)` takes whatever it says). `ledger_entries.id` is drawn under the ACCOUNT's balance
    // lock, so it is that account's commit order, not the connection's.
    const order = new BalanceOrder();
    expect(order.accept(balanceEvent({ ledgerEntryId: '100' }))).toBe(true);
    expect('reset' in order).toBe(false);
    // So a delayed event from before the gap is still refused after one.
    expect(order.accept(balanceEvent({ ledgerEntryId: '1' }))).toBe(false);
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

  it('reports what a refused key must wait, which is what buys the trailing edge', () => {
    // A leading-edge-only throttle DROPS the last event of a burst, and nothing else writes
    // `['market-fills', id]` for somebody ELSE's trade — the trader's own fill comes from the
    // HTTP answer, and the query has no refetchInterval. So the provider sleeps exactly this
    // long and takes again: a burst costs one late refetch instead of a missing row.
    const throttle = new Throttle(1000);
    expect(throttle.retryDelay(ID, 0)).toBe(0);
    expect(throttle.take(ID, 0)).toBe(true);
    expect(throttle.take(ID, 400)).toBe(false);
    expect(throttle.retryDelay(ID, 400)).toBe(600);
    expect(throttle.take(ID, 1000)).toBe(true);
    // Never negative, whatever the caller's clock does past the end of a window.
    expect(throttle.retryDelay(ID, 2500)).toBe(0);
  });
});

describe('chunkIds', () => {
  /**
   * The two realtime caps differ on purpose — 100 ids per MESSAGE, 200 rooms per SOCKET — and
   * the gateway refuses an over-long message whole, joining no room at all. The home grid
   * crosses 100 rooms after five 더 보기, so a single frame left the tab with no live card at
   * all rather than with the tail missing.
   */
  it('splits a room set larger than one message into full messages, in order', () => {
    const ids = Array.from({ length: 120 }, (_value, index) => `market-${String(index)}`);
    const chunks = chunkIds(ids, REALTIME_SUBSCRIBE_MAX);
    expect(chunks.map((chunk) => chunk.length)).toEqual([REALTIME_SUBSCRIBE_MAX, 20]);
    // Every id is sent exactly once and in the order it was held: a dropped or repeated id
    // would leave the registry and `socket.data.marketRooms` disagreeing about a room.
    expect(chunks.flat()).toEqual(ids);
  });

  it('sends one message for a set that fits and nothing at all for an empty one', () => {
    expect(chunkIds([ID, OTHER_ID], REALTIME_SUBSCRIBE_MAX)).toEqual([[ID, OTHER_ID]]);
    expect(chunkIds([], REALTIME_SUBSCRIBE_MAX)).toEqual([]);
  });

  it('never leaves an empty trailing message when the set divides exactly', () => {
    // An empty `marketIds` fails `subscribeBodySchema`'s `.min(1)`, so a trailing empty slice
    // would turn a perfectly sized set into a VALIDATION_ERROR on `exception`.
    expect(chunkIds([ID, OTHER_ID, THIRD_ID], 3)).toEqual([[ID, OTHER_ID, THIRD_ID]]);
    expect(chunkIds([ID, OTHER_ID], 1)).toEqual([[ID], [OTHER_ID]]);
  });

  it('never spins on a non-positive size', () => {
    expect(chunkIds([ID, OTHER_ID], 0)).toEqual([[ID], [OTHER_ID]]);
  });
});
