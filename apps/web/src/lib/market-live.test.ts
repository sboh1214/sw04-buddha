import {
  MARKET_STATUSES,
  type MarketStatusEvent,
  type MarketResult,
  type MarketTickEvent,
  PRICE_MAX,
  PRICE_MIN,
  REALTIME_SUBSCRIBE_MAX,
  type UserBalanceEvent,
  type UserPositionEvent,
  supersedes,
} from '@buddha/shared';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { SRC } from '@/test/screen-text';
import { positionFixture } from '@/test/positions';
import { type Market, type MarketSummary, type Me, type Order, type Position } from './api';
import {
  MY_ORDERS_LIVE_KEY,
  ORDERS_KEY,
  isOrderHistoryKey,
  isWalletLiveOrdersKey,
  marketBookKey,
  myFillHistoryKey,
  myMarketFillsKey,
  myOrderFillsKey,
  myOrderHistoryKey,
  myOrderKey,
  myOrdersLiveKey,
  mySettlementsKey,
  sellableKey,
  walletLiveOrdersKey,
} from './market-keys';
import {
  BALANCE_HISTORY_INVALIDATE_MS,
  BalanceOrder,
  type MarketPages,
  MarketWindow,
  RoundWindow,
  SellableRotation,
  Throttle,
  TrailingGate,
  applyBalanceEvent,
  applyPositionEvent,
  applyStatus,
  applyStats,
  applyTick,
  applyToPages,
  bookRestartsOwnOrders,
  bookRestartsSellable,
  chunkIds,
  joinMarket,
  joinMarketPages,
  joinPositions,
  ownLiveOrderIds,
  ownOrderHistoryKeys,
  ownOrdersRefreshKeys,
  ownOrdersStatusKeys,
  ownSettlementKeys,
  positionReopensMarket,
  positionRestartsOrder,
  walletMissesMarket,
  wroteASettlement,
  wroteAnOrder,
} from './market-live';
import { restartQueries } from './query-client';

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
  judgementDelayed: false,
  disputeUnderReview: false,
  lastPrice: 50,
  lastFillAt: '2026-09-06T23:00:00.000Z',
  volumeCoin: '120000',
  tradeCount: 10,
  traderCount: 4,
  statsRevision: '10',
  closeAt: '2026-10-01T00:00:00.000Z',
  openAt: '2026-09-01T00:00:00.000Z',
  scheduledOpenAt: '2026-09-01T00:00:00.000Z',
  resolvedResult: null,
  judgementVersion: null,
  disputeDeadline: null,
  disputeOpen: false,
  // The `opened` event (`created` is 1): the key every transition below is compared against.
  statusEventId: '2',
  createdAt: '2026-08-30T00:00:00.000Z',
};

/** A list card: the row `GET /markets` answers, which is the summary itself. */
const card: MarketSummary = { ...summary };

/** The detail: the same volatile fields plus the ones only a resolution moves. */
const detail: Market = {
  ...summary,
  lastPrice24hAgo: null,
  description: null,
  yesCondition: '한국은행 발표 기준.',
  noCondition: '',
  eventDeadline: null,
  primarySource: null,
  fallbackSources: [],
  fallbackCondition: '',
  longDelayDays: null,
  delayHandling: '',
  // #22's times: none, as on a market opened before them.
  scheduledOpenAt: null,
  scheduledAnnouncementAt: null,
  scheduledJudgementAt: null,
  judgementTimeZone: null,
  resolvedAt: null,
  settledAt: null,
  tags: [],
  // No rule version (#80): not opened yet, or opened before #80 (D4).
  ruleVersion: null,
  judgingRecord: {
    versions: [],
    pauses: [],
    delays: [],
    disputes: { total: 0, byVersion: [], decisions: [] },
    cancellation: null,
    payoutDelayed: false,
    correction: null,
  },
  ruleVersions: [],
  // No 판정 지연 기록 (#142): not reading 판정 지연.
  judgementDelay: null,
};

const tick = (patch: Partial<MarketTickEvent> = {}): MarketTickEvent => ({
  type: 'market:tick',
  marketId: ID,
  lastPrice: 63,
  volumeCoin: '130000',
  tradeCount: 11,
  traderCount: 5,
  statsRevision: String(patch.tradeCount ?? 11),
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

const position: Position = positionFixture({
  marketId: ID,
  marketLastPrice: 50,
  qty: 10,
  version: 3,
  updatedAt: '2026-09-06T00:00:00.000Z',
});

const otherPosition: Position = { ...position, marketId: OTHER_ID, outcome: 'NO', version: 1 };

const positionEvent = (patch: Partial<UserPositionEvent> = {}): UserPositionEvent => ({
  type: 'user:position',
  marketId: ID,
  outcome: 'YES',
  qty: 14,
  costBasisCoin: '7000',
  realizedPnlCoin: '0',
  settled: false,
  version: 4,
  ts: '2026-09-07T00:00:00.000Z',
  ...patch,
});

const balanceEvent = (patch: Partial<UserBalanceEvent> = {}): UserBalanceEvent => ({
  type: 'user:balance',
  availableCoin: '90000',
  lockedCoin: '0',
  ledgerEntryId: '9',
  ts: '2026-09-07T00:00:00.000Z',
  ...patch,
});

const me: Me = {
  id: 'user-1',
  email: 'a@example.com',
  emailVerified: true,
  profile: {
    publicId: 'k7m2p9qx4z',
    nickname: '테스터',
    role: 'user',
    createdAt: '2026-08-01T00:00:00.000Z',
    timeZone: null,
    nicknameChangeAvailableAt: null,
    interestCategoryIds: [],
    bio: null,
    imageUrl: null,
  },
  balance: { availableCoin: '100000', lockedCoin: '0' },
  linkedAccounts: [],
  verification: null,
  startGrant: null,
  firstOrderPlaced: false,
  onboarding: {
    consent: false,
    verification: false,
    nickname: false,
    completed: false,
    interests: false,
    nextStep: 'consent',
    consents: [],
  },
};

/** The infinite-list shape: the last page ends the list, and the first page has no cursor. */
const pagesOf = (...pages: MarketSummary[][]): MarketPages => ({
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
      // The tick's `ts` is the last fill's server time (#121, ADR-0116): the row's 갱신시각.
      lastFillAt: '2026-09-07T00:00:00.000Z',
      volumeCoin: '130000',
      tradeCount: 11,
      // Moves with the same trade, so the patch carries it: a first-time buyer raises it, and
      // leaving it behind kept the header's 참여자 stale for as long as the market stayed busy.
      traderCount: 5,
      statsRevision: '11',
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

  it('moves the 참여자 on a card with the trade, and adds no other key', () => {
    // The card's footer shows `traderCount` (ADR-0062), so a tick on the home grid must move it
    // with the price. The patch is the detail's, field for field: since ADR-0062 a card carries
    // no samples of its own for a tick to move.
    expect(applyTick(card, tick())).toEqual({
      ...card,
      lastPrice: 63,
      lastFillAt: '2026-09-07T00:00:00.000Z',
      volumeCoin: '130000',
      tradeCount: 11,
      traderCount: 5,
      statsRevision: '11',
    });
  });

  it("takes the tick's price as it comes, a null one included", () => {
    // Not the fixture's default, so the patch is seen taking the event's value.
    expect(applyTick(card, tick({ lastPrice: 41 }))?.lastPrice).toBe(41);
    // No fill price (체결 없음): the row says so, rather than keeping the price it held.
    expect(applyTick(card, tick({ lastPrice: null }))?.lastPrice).toBeNull();
    expect(applyTick(detail, tick({ lastPrice: null }))?.lastPrice).toBeNull();
  });

  it("moves the fill time with the price, from the tick's ts, and never with a late tick (#121)", () => {
    const at = '2026-09-07T03:04:05.678Z';
    expect(applyTick(card, tick({ ts: at }))?.lastFillAt).toBe(at);
    expect(applyTick(detail, tick({ ts: at }))?.lastFillAt).toBe(at);
    // A late tick (an older `tradeCount`) brings neither its price nor its time.
    const held = { ...detail, lastPrice: 63, lastFillAt: at, tradeCount: 11 };
    expect(
      applyTick(held, tick({ tradeCount: 10, ts: '2026-09-07T03:00:00.000Z' })),
    ).toBeUndefined();
  });
});

describe('applyStatus', () => {
  it('clears status-specific public delay flags while retaining recorded history (#24)', () => {
    const held: Market = {
      ...detail,
      status: 'settling',
      statusEventId: '8',
      judgingRecord: {
        ...detail.judgingRecord,
        payoutDelayed: true,
        delays: [{ reason: '자료 확인', nextReviewAt: '2026-11-10T00:00:00.000Z', current: true }],
      },
    };
    const next = applyStatus(held, statusEvent({ status: 'settled', statusEventId: '9' }));
    expect(next?.judgingRecord).toEqual({
      ...held.judgingRecord,
      payoutDelayed: false,
      delays: [{ ...held.judgingRecord.delays[0], current: false }],
    });
    expect(next?.judgingRecordStale).toBe(true);
    expect(applyStatus(card, statusEvent())).not.toHaveProperty('judgingRecord');
    expect(applyStatus(card, statusEvent())).not.toHaveProperty('judgingRecordStale');
  });
  /** The market judged YES: the transition that wrote the result is event 4 of this market. */
  const resolved: Market = {
    ...detail,
    status: 'resolved',
    resolvedResult: 'YES',
    statusEventId: '4',
  };

  it('walks closed → provisional → resolved → settled, each event carrying the result its transition wrote', () => {
    // #152 (ADR-0103): the approved judgement publishes 잠정 결과 with its result (`provisional`,
    // published by the API), the worker confirms it at the dispute deadline (`resolved`) and its
    // settlement follows moments later (`settled`). Every row on screen holds exactly the status
    // group the latest transition delivered — nothing else: the 이의 기한 and the judgement version
    // (public since #175, ADR-0104) are no event's, and come with the REST refetch beside it.
    const closed = applyStatus(detail, statusEvent({ status: 'closed', statusEventId: '3' }));
    expect(closed).toEqual({
      ...detail,
      status: 'closed',
      statusEventId: '3',
      judgingRecordStale: true,
    });
    const provisional = applyStatus(
      closed,
      statusEvent({ status: 'provisional', resolvedResult: 'YES', statusEventId: '4' }),
    );
    expect(provisional).toEqual({ ...resolved, status: 'provisional', judgingRecordStale: true });
    const judged = applyStatus(
      provisional,
      statusEvent({ status: 'resolved', resolvedResult: 'YES', statusEventId: '5' }),
    );
    expect(judged).toEqual({ ...resolved, statusEventId: '5', judgingRecordStale: true });
    const settled = applyStatus(
      judged,
      statusEvent({ status: 'settled', resolvedResult: 'YES', statusEventId: '6' }),
    );
    expect(settled).toEqual({
      ...resolved,
      status: 'settled',
      statusEventId: '6',
      judgingRecordStale: true,
    });
    expect(settled).not.toHaveProperty('disputeUntil');
  });

  it('resets the display flags read for the old status, so none labels the new one (#175)', () => {
    // ADR-0104: a held PROVISIONAL market reads '이의 검토 중' and, past its deadline, '판정 지연';
    // a CLOSED one past its scheduled judgement reads '판정 지연' too. A flag the row read for one
    // status says nothing of the next — the refetch the handler fires beside the event fills them.
    const late: Market = {
      ...detail,
      status: 'closed',
      statusEventId: '3',
      judgementDelayed: true,
    };
    const provisional = applyStatus(
      late,
      statusEvent({ status: 'provisional', resolvedResult: 'NO', statusEventId: '4' }),
    );
    expect(provisional?.status).toBe('provisional');
    expect(provisional?.judgementDelayed).toBe(false);
    const held: Market = {
      ...detail,
      status: 'provisional',
      resolvedResult: 'NO',
      statusEventId: '4',
      judgementVersion: 1,
      disputeDeadline: '2026-10-02T00:00:00.000Z',
      judgementDelayed: true,
      disputeUnderReview: true,
      disputeOpen: true,
    };
    const confirmed = applyStatus(
      held,
      statusEvent({ status: 'resolved', resolvedResult: 'NO', statusEventId: '5' }),
    );
    expect(confirmed).toEqual({
      ...held,
      status: 'resolved',
      statusEventId: '5',
      judgementDelayed: false,
      disputeUnderReview: false,
      disputeOpen: false,
      judgingRecordStale: true,
    });
    // A repeat on the same key (a dispute's submission republishes it, A-M4-36) writes nothing:
    // the refetch beside it brings the new flags.
    expect(
      applyStatus(
        held,
        statusEvent({ status: 'provisional', resolvedResult: 'NO', statusEventId: '4' }),
      ),
    ).toBeUndefined();
    // An approved correction (#176, ADR-0105: `judgement_corrected` moves the key, no status
    // change) writes its result and resets the flags; the version and the new deadline come with
    // the refetch, as the first 잠정 결과's do. A correction's registration, 반려 or 철회 republishes
    // the same key — nothing written, the refetch brings 판정 지연 or its end.
    expect(
      applyStatus(
        held,
        statusEvent({ status: 'provisional', resolvedResult: 'YES', statusEventId: '6' }),
      ),
    ).toEqual({
      ...held,
      resolvedResult: 'YES',
      statusEventId: '6',
      judgementDelayed: false,
      disputeUnderReview: false,
      disputeOpen: false,
      judgingRecordStale: true,
    });
  });

  it('resets the 판정 지연 기록 read with the old status, and adds none to a card (#142)', () => {
    // ADR-0106: `judgementDelay` is the current record of the status it was read with — a CLOSED
    // market's must not stand on the 잠정 결과 the approval brings; the refetch fills it in.
    const late: Market = {
      ...detail,
      status: 'closed',
      statusEventId: '3',
      judgementDelayed: true,
      judgementDelay: {
        reason: '출처의 발표가 늦어지고 있습니다.',
        nextReviewAt: '2026-10-05T00:00:00.000Z',
        nextReviewPassed: true,
      },
    };
    const approved = statusEvent({
      status: 'provisional',
      resolvedResult: 'NO',
      statusEventId: '4',
    });
    expect(applyStatus(late, approved)).toMatchObject({
      status: 'provisional',
      judgementDelayed: false,
      judgementDelay: null,
    });
    // A record's own repeat (A-M4-36: the key unchanged) writes nothing; its refetch brings it.
    expect(
      applyStatus(late, statusEvent({ status: 'closed', statusEventId: '3' })),
    ).toBeUndefined();
    // A card carries no record, and the event gives it none.
    const moved = applyStatus({ ...card, status: 'closed', statusEventId: '3' }, approved);
    expect(moved === undefined ? true : 'judgementDelay' in moved).toBe(false);
  });

  it('writes nothing for a status no member sees: a scheduled market sent back (#78)', () => {
    // ADR-0099: 되돌리기 from 개장 예정 publishes `draft` under a newer key. The card and the detail
    // keep 개장 예정 rather than call it 초안, an admin's label; the refetch beside it answers 404.
    const scheduled: Market = { ...detail, status: 'scheduled', statusEventId: '2' };
    for (const status of ['draft', 'review'] as const) {
      expect(applyStatus(scheduled, statusEvent({ status, statusEventId: '9' })), status).toBe(
        undefined,
      );
    }
    // Approved again later: a public status under a newer key applies as ever.
    expect(
      applyStatus(scheduled, statusEvent({ status: 'scheduled', statusEventId: '10' })),
    ).toEqual({ ...scheduled, statusEventId: '10', judgingRecordStale: true });
  });

  it('keeps settled when the judgement arrives after it', () => {
    // The API publishes `resolved` and the worker `settling` and `settled` from two processes,
    // moments apart, so the socket may deliver them in any order. The key decides: `resolved` (4)
    // is not newer than `settled` (5), and the screen stays on 지급 완료.
    const settled: Market = { ...resolved, status: 'settled', statusEventId: '5' };
    expect(
      applyStatus(
        settled,
        statusEvent({ status: 'resolved', resolvedResult: 'YES', statusEventId: '4' }),
      ),
    ).toBeUndefined();
  });

  it('replaces the result, so an event without one clears the one a row held', () => {
    // No transition takes a judged market to a result-less status today (a cancelled market
    // never had one, ADR-0093 decision 1, item 10) — but the reducer replaces rather than
    // merges, so an event never inherits a result its own transition did not carry.
    const next = applyStatus(resolved, statusEvent({ status: 'settling', statusEventId: '5' }));
    expect(next?.status).toBe('settling');
    expect(next?.resolvedResult).toBeNull();
    expect(next?.statusEventId).toBe('5');
  });

  it('carries a VOID result as it is, the result type the event carries (#174)', () => {
    const next = applyStatus(
      resolved,
      statusEvent({ status: 'settling', resolvedResult: 'VOID', statusEventId: '5' }),
    );
    expect(next?.resolvedResult).toBe('VOID');
  });

  it('takes PAUSED → OPEN, which goes back in rank, by its newer key (#174)', () => {
    // OPEN ↔ PAUSED (ADR-0093 decision 1, item 3): `open` sorts before `paused`, so a rank
    // comparison would drop the resume and leave 거래 일시 중단 on screen. The key says it is later.
    const paused = { ...detail, status: 'paused' as const, statusEventId: '6' };
    const resumed = applyStatus(paused, statusEvent({ status: 'open', statusEventId: '7' }));
    expect(resumed?.status).toBe('open');
    expect(resumed?.statusEventId).toBe('7');
    // A late delivery of the pause it already moved past is dropped all the same.
    expect(
      applyStatus(resumed, statusEvent({ status: 'paused', statusEventId: '6' })),
    ).toBeUndefined();
  });

  it('takes the same status under a newer key as a later transition', () => {
    // THE DAY the rank order stopped holding (A-M3-19): M5's `result_changed` repeated a status
    // with a new result, and rank alone could only drop it — as a correction in PROVISIONAL does
    // (#176, ADR-0105: `judgement_corrected` moves the key). The event id says it is a LATER
    // transition, so the whole status group is replaced — a rule the reducer keeps for any
    // transition that repeats a status.
    const repeated = statusEvent({ status: 'resolved', resolvedResult: 'NO', statusEventId: '5' });
    expect(applyStatus(resolved, repeated)).toEqual({
      ...resolved,
      resolvedResult: 'NO',
      statusEventId: '5',
      judgingRecordStale: true,
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
  const otherCard: MarketSummary = { ...card, id: OTHER_ID, slug: 'other' };

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
  it.each(['5', '6'])(
    'keeps corrected history stale through old REST/ticks until REST key %s arrives (#24)',
    (freshKey) => {
      const previous: Market = {
        ...detail,
        status: 'provisional',
        statusEventId: '4',
        resolvedResult: 'YES',
        judgingRecord: {
          ...detail.judgingRecord,
          versions: [
            {
              version: 1,
              result: 'YES',
              source: null,
              fallbackReason: null,
              voidReason: null,
              correctionReason: null,
              evidence: {
                links: ['https://example.com/evidence'],
                collectedAt: '2026-11-09T00:00:00.000Z',
              },
              description: '정정 전 근거',
              ruleVersion: 1,
              publishedAt: '2026-11-09T01:00:00.000Z',
              disputeDeadline: '2026-11-10T01:00:00.000Z',
            },
          ],
        },
      };
      const correction = statusEvent({
        status: 'provisional',
        resolvedResult: 'NO',
        statusEventId: '5',
      });
      const moved = applyStatus(previous, correction);
      expect(moved?.resolvedResult).toBe('NO');
      expect(moved?.judgingRecordStale).toBe(true);
      expect(moved?.judgingRecord.versions[0]?.result).toBe('YES');

      // The old request can complete after the correction event, but cannot certify its record.
      const joined = joinMarket(moved, previous);
      expect(joined.statusEventId).toBe('5');
      expect(joined.judgingRecordStale).toBe(true);
      expect(joinMarket(joined, previous).judgingRecordStale).toBe(true);
      expect(applyTick(joined, tick())?.judgingRecordStale).toBe(true);
      expect(applyStatus(joined, correction)).toBeUndefined();

      const fresh: Market = {
        ...previous,
        statusEventId: freshKey,
        resolvedResult: 'NO',
        judgingRecord: {
          ...previous.judgingRecord,
          versions: previous.judgingRecord.versions.map((version) => ({
            ...version,
            version: 2,
            result: 'NO',
            correctionReason: '정정된 근거',
          })),
        },
      };
      const recovered = joinMarket(joined, fresh);
      expect(recovered.judgingRecordStale).toBeUndefined();
      expect(recovered.judgingRecord).toEqual(fresh.judgingRecord);
      expect(recovered.judgingRecord.versions[0]?.result).toBe('NO');
      // A duplicate/later delivery of this same event cannot hide freshly read history again.
      expect(applyStatus(recovered, correction)).toBeUndefined();
    },
  );

  it('keeps public history and completion times with their newer status snapshot (#24)', () => {
    const older: Market = {
      ...detail,
      status: 'settling',
      statusEventId: '8',
      judgingRecord: { ...detail.judgingRecord, payoutDelayed: true },
    };
    const newer: Market = {
      ...detail,
      status: 'settled',
      statusEventId: '9',
      resolvedAt: '2026-11-09T00:00:00.000Z',
      settledAt: '2026-11-09T00:01:00.000Z',
      judgingRecord: {
        ...detail.judgingRecord,
        disputes: { ...detail.judgingRecord.disputes, total: 2 },
      },
    };
    for (const joined of [joinMarket(newer, older), joinMarket(older, newer)]) {
      expect(joined.judgingRecord).toEqual(newer.judgingRecord);
      expect(joined.resolvedAt).toBe(newer.resolvedAt);
      expect(joined.settledAt).toBe(newer.settledAt);
    }
    // A repeated status event can accompany newly recorded public facts: same-key REST wins.
    expect(
      joinMarket(newer, { ...newer, judgingRecord: older.judgingRecord }).judgingRecord,
    ).toEqual(older.judgingRecord);
    expect(joinMarket({ ...card, statusEventId: '9' }, card)).not.toHaveProperty('judgingRecord');
  });
  const live: Market = {
    ...detail,
    lastPrice: 63,
    lastFillAt: '2026-09-07T00:00:00.000Z',
    volumeCoin: '130000',
    tradeCount: 11,
    traderCount: 7,
    statsRevision: '11',
  };
  const stale: Market = {
    ...detail,
    title: '10월 기준금리 인하?',
    yesCondition: '10월 회의에서 기준금리를 내리면 YES.',
    primarySource: { name: '한국은행', url: 'https://www.bok.or.kr' },
    traderCount: 9,
  };

  it('keeps the live stats under an older snapshot while taking its descriptive fields', () => {
    const joined = joinMarket(live, stale);
    expect(joined.lastPrice).toBe(63);
    // The fill time rides with the price (#121): the older snapshot's earlier one stays out.
    expect(joined.lastFillAt).toBe(live.lastFillAt);
    expect(joined.volumeCoin).toBe('130000');
    expect(joined.tradeCount).toBe(11);
    expect(joined.title).toBe(stale.title);
    // The rule items (#23) are descriptive too: only a REST answer carries an admin's edit of them.
    expect(joined.yesCondition).toBe(stale.yesCondition);
    expect(joined.primarySource).toEqual(stale.primarySource);
    // `traderCount` rides with the price, NOT with the descriptive fields: a trade moves it, so
    // an older snapshot must not drag the participant count back under a newer probability —
    // even though this stale answer names a higher one.
    expect(joined.traderCount).toBe(7);
  });

  it("takes a card's scheduled open from the answer, and no status event moves it (#61)", () => {
    // Descriptive, like the title: a reschedule before the open reaches a card by its next read,
    // never by an event (ADR-0136). An older answer's own value is the one it carries.
    const held: MarketSummary = {
      ...card,
      status: 'scheduled',
      openAt: null,
      scheduledOpenAt: '2026-09-02T00:00:00.000Z',
    };
    const moved = { ...held, scheduledOpenAt: '2026-09-03T00:00:00.000Z' };
    expect(joinMarket(held, moved).scheduledOpenAt).toBe('2026-09-03T00:00:00.000Z');
    // The open's `market:status` changes the status alone; the card stops drawing the time by it.
    const opened = applyStatus(held, statusEvent({ status: 'open', statusEventId: '3' }));
    expect(opened?.status).toBe('open');
    expect(opened?.scheduledOpenAt).toBe('2026-09-02T00:00:00.000Z');
    expect(opened?.openAt).toBeNull();
  });

  it('keeps the newer transition in both directions', () => {
    const closed: Market = { ...detail, status: 'closed', statusEventId: '3' };
    expect(joinMarket(closed, detail).status).toBe('closed');
    expect(joinMarket(detail, closed).status).toBe('closed');
  });

  it('keeps the display flags with the status they were read for (#175)', () => {
    // A `GET` that left while the market was CLOSED past its scheduled judgement lands after the
    // approval's `provisional` (flags reset): its '판정 지연' was the CLOSED market's, and joined
    // to the 잠정 결과 held it would read 판정 지연 — which a held PROVISIONAL market past its
    // deadline means now (ADR-0104).
    const late: Market = {
      ...detail,
      status: 'closed',
      statusEventId: '3',
      judgementDelayed: true,
    };
    const provisional: Market = {
      ...detail,
      status: 'provisional',
      resolvedResult: 'NO',
      statusEventId: '4',
      judgementVersion: 1,
      disputeDeadline: '2026-11-04T05:00:00.000Z',
      disputeOpen: true,
    };
    for (const joined of [joinMarket(provisional, late), joinMarket(late, provisional)]) {
      expect(joined.status).toBe('provisional');
      expect(joined.judgementDelayed).toBe(false);
      // The version and the 이의 기한 the same transition wrote, never the snapshot's nulls.
      expect(joined).toMatchObject({
        judgementVersion: 1,
        disputeDeadline: '2026-11-04T05:00:00.000Z',
        disputeOpen: true,
      });
    }
    // The same key: the REST answer's flags, read for that very status, win (the refetch a
    // dispute's republish fires delivers '이의 검토 중' this way).
    const held: Market = { ...provisional, disputeUnderReview: true, disputeOpen: true };
    expect(joinMarket(provisional, held)).toMatchObject({
      disputeUnderReview: true,
      disputeOpen: true,
    });
  });

  it('keeps the 판정 지연 기록 with the status it was read for, and takes a tie’s new one (#142)', () => {
    // ADR-0106: a `GET` that left while the market was CLOSED and delayed lands after the
    // approval's `provisional`: its record was the CLOSED market's and must not label the 잠정 결과.
    const record = {
      reason: '출처의 발표가 늦어지고 있습니다.',
      nextReviewAt: '2026-11-05T00:00:00.000Z',
      nextReviewPassed: false,
    };
    const late: Market = {
      ...detail,
      status: 'closed',
      statusEventId: '3',
      judgementDelayed: true,
      judgementDelay: record,
    };
    const provisional: Market = {
      ...detail,
      status: 'provisional',
      resolvedResult: 'NO',
      statusEventId: '4',
      judgementVersion: 1,
    };
    for (const joined of [joinMarket(provisional, late), joinMarket(late, provisional)]) {
      expect(joined.judgementDelay).toBeNull();
    }
    // The same key: a new record's republish keeps it, so the refetch's record comes in whole.
    const renewed: Market = {
      ...late,
      judgementDelay: { ...record, reason: '다음 주에 다시 확인합니다.' },
    };
    expect(joinMarket(late, renewed).judgementDelay).toEqual(renewed.judgementDelay);
    // A card has none, and the join gives it none.
    const joinedCard = joinMarket({ ...card, statusEventId: '4' }, card);
    expect('judgementDelay' in joinedCard).toBe(false);
  });

  it('keeps the higher key with its result, whatever the status says', () => {
    // THE RACE the key exists for: the socket delivered the worker's `settled` (key 5), and a
    // `GET /markets/:id` that left before the 판정 lands after it — `closed`, no result. The group
    // moves as one: a row that kept `settled` with the snapshot's null result would badge
    // 지급 완료 over no answer at all.
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

  it('never lets either side lose ground, whichever snapshot arrives second', () => {
    const liveArb: fc.Arbitrary<Market> = fc
      .record({
        status: fc.constantFrom(...MARKET_STATUSES),
        lastPrice: fc.option(fc.integer({ min: PRICE_MIN, max: PRICE_MAX })),
        volumeCoin: fc.integer({ min: 0, max: 1_000_000 }).map(String),
        tradeCount: fc.integer({ min: 0, max: 1000 }),
        resolvedResult: fc.constantFrom<MarketResult | null>('YES', 'NO', 'VOID', null),
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
  const otherCard: MarketSummary = { ...card, id: OTHER_ID, slug: 'other' };
  const thirdCard: MarketSummary = { ...card, id: THIRD_ID, slug: 'third' };

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
          costBasisCoin: '7000',
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
    // 이력 fetched the same row, and 총 실현 손익 printed 500 Coin for one 250 Coin row. The write also
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
    // settled list holds no UNSETTLED row by definition — so on MY's summary, where both lists are
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
    // filledQty, amountCoin and priceAvgBp that no `user:` event does — so a trade's row can only
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

describe('wroteASettlement and ownSettlementKeys (#124, ADR-0143 결정 9)', () => {
  const ACCOUNT = 'a1e1c0de-0000-4000-8000-0000000000aa';
  const OTHER_ACCOUNT = 'a1e1c0de-0000-4000-8000-0000000000ff';
  const pages = { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] };

  it('asks for 정산 기록 on a settlement and never on a trade, which writes no record', () => {
    // The other half of `wroteAnOrder`: a settlement retires the holding and writes its record in
    // one transaction, and the event carries no result, payout, cost or time to build a line from.
    expect(wroteASettlement(positionEvent({ settled: true }))).toBe(true);
    expect(wroteASettlement(positionEvent())).toBe(false);
    expect(wroteASettlement(positionEvent({ qty: 0, settled: true }))).toBe(true);
    expect(wroteASettlement(positionEvent({ qty: 0, settled: false }))).toBe(false);
    // Exactly one of the two is asked for by any event.
    for (const settled of [true, false]) {
      const event = positionEvent({ settled });
      expect(wroteASettlement(event)).not.toBe(wroteAnOrder(event));
    }
  });

  it("reads again every filter's list of this account, and no other account's", () => {
    const client = new QueryClient();
    try {
      client.setQueryData(mySettlementsKey({}, ACCOUNT), pages);
      client.setQueryData(mySettlementsKey({ period: '7d', market: ID }, ACCOUNT), pages);
      client.setQueryData(mySettlementsKey({}, OTHER_ACCOUNT), pages);
      // The history's orders and fills are another root: a settlement writes neither.
      client.setQueryData(myOrderHistoryKey({}, ACCOUNT), pages);
      expect(ownSettlementKeys(client, ACCOUNT)).toEqual([
        mySettlementsKey({}, ACCOUNT),
        mySettlementsKey({ period: '7d', market: ID }, ACCOUNT),
      ]);
      expect(ownSettlementKeys(client, OTHER_ACCOUNT)).toEqual([
        mySettlementsKey({}, OTHER_ACCOUNT),
      ]);
      // No account known (a visitor's socket, `['me']` not read): nothing.
      expect(ownSettlementKeys(client, undefined)).toEqual([]);
    } finally {
      client.clear();
    }
  });

  it('is what the socket restarts on a settling user:position, beside the order lists’ rule', () => {
    const handler = readFileSync(
      path.join(SRC, 'components/realtime/realtime-provider.tsx'),
      'utf8',
    );
    const position = handler.slice(handler.indexOf("'user:position': (raw: unknown) => {"));
    expect(position).toMatch(
      /if \(wroteAnOrder\(event\)\) \{\s*void restartQueries\(queryClient, ORDERS_KEY, positionRestartsOrder\);/,
    );
    // Through the per-connection gate (#34, ADR-0145 결정 3-10), dropped with the socket.
    expect(position).toMatch(
      /if \(wroteASettlement\(event\)\) \{\s*settlementRestart\.arm\(\(\) => \{\s*for \(const key of ownSettlementKeys\(queryClient, identity \?\? undefined\)\) \{\s*void restartQueries\(queryClient, key\);/,
    );
    expect(handler).toContain('const settlementRestart = new TrailingGate(SETTLEMENT_RESTART_MS);');
    expect(handler.slice(handler.indexOf('socket.removeAllListeners();'))).toContain(
      'settlementRestart.cancel();',
    );
    // …and a reconnect re-reads the root: a missed settling event is a record the list lacks.
    const privateKeys = handler.slice(
      handler.indexOf('const PRIVATE_SNAPSHOT_KEYS = ['),
      handler.indexOf('] as const;', handler.indexOf('const PRIVATE_SNAPSHOT_KEYS = [')),
    );
    expect(privateKeys).toContain('SETTLEMENTS_KEY');
    expect(privateKeys).toContain('ORDERS_KEY');
  });

  it('restarts each list of the account once per payout, not per event (#34, ADR-0145)', () => {
    // A YES and NO holder gets two settling events from one payout. Each used to restart the
    // lists, cancelling the read the one before began — and the detail's list, turned on by the
    // payout's `market:status`, joined that burst. The handler below is the provider's.
    vi.useFakeTimers();
    const client = new QueryClient();
    try {
      client.setQueryData(mySettlementsKey({}, ACCOUNT), pages);
      client.setQueryData(mySettlementsKey({}, OTHER_ACCOUNT), pages);
      const invalidate = vi.spyOn(client, 'invalidateQueries');
      const restarted = () => invalidate.mock.calls.map(([filters]) => filters?.queryKey);
      const gate = new TrailingGate(50);
      const onPosition = (event: UserPositionEvent) => {
        if (!wroteASettlement(event)) return;
        gate.arm(() => {
          for (const key of ownSettlementKeys(client, ACCOUNT)) void restartQueries(client, key);
        });
      };
      onPosition(positionEvent({ outcome: 'YES', qty: 0, settled: true }));
      // The detail's list of this market mounts between the two: read when the gate fires.
      client.setQueryData(mySettlementsKey({ market: ID }, ACCOUNT), pages);
      onPosition(positionEvent({ outcome: 'NO', qty: 0, settled: true }));
      // A trade writes no record and does not arm it.
      onPosition(positionEvent());
      expect(restarted()).toEqual([]);
      vi.advanceTimersByTime(49);
      expect(restarted()).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(restarted()).toEqual([
        mySettlementsKey({}, ACCOUNT),
        mySettlementsKey({ market: ID }, ACCOUNT),
      ]);
      // Nothing trails it: one restart per list for the whole payout.
      vi.advanceTimersByTime(1_000);
      expect(restarted()).toHaveLength(2);
      // A later payout is its own burst, again once per list.
      onPosition(positionEvent({ marketId: OTHER_ID, qty: 0, settled: true }));
      onPosition(positionEvent({ marketId: OTHER_ID, outcome: 'NO', qty: 0, settled: true }));
      vi.advanceTimersByTime(50);
      expect(restarted()).toHaveLength(4);
      // The socket torn down drops a run not made yet.
      onPosition(positionEvent({ marketId: THIRD_ID, qty: 0, settled: true }));
      gate.cancel();
      vi.advanceTimersByTime(1_000);
      expect(restarted()).toHaveLength(4);
    } finally {
      client.clear();
      vi.useRealTimers();
    }
  });
});

describe('positionReopensMarket (#67, ADR-0142 결정 2-2)', () => {
  /** The contract sold out of: the open list keeps the row at 0 (F4). */
  const soldOut: Position = { ...position, qty: 0 };

  it('answers for a sold-out market bought back, the one whose tick MY missed', () => {
    // THE HAZARD: `useHoldings` joins and reads only the markets held at 1 or more, so a sold-out
    // market's room is left. The buy back's `market:tick` goes by, this event carries no price,
    // and the `['market', id]` entry — inside `staleTime` — is taken as fresh by the observer
    // mounted again: the holding valued at the price from before its own fill.
    expect(positionReopensMarket([soldOut, otherPosition], positionEvent())).toBe(true);
    // The other contract of that market at 0 as well: still a market MY was not in.
    const otherSide: Position = { ...soldOut, outcome: 'NO', version: 1 };
    expect(positionReopensMarket([soldOut, otherSide], positionEvent())).toBe(true);
  });

  it('costs nothing for a market already held at 1 or more', () => {
    // An ordinary buy on a held contract: MY is in the room and the tick arrives.
    expect(positionReopensMarket([position, otherPosition], positionEvent())).toBe(false);
    // YES bought back while NO is held: the market never left the screen.
    const heldNo: Position = { ...position, outcome: 'NO', qty: 5, version: 1 };
    expect(positionReopensMarket([soldOut, heldNo], positionEvent())).toBe(false);
    // A holding in ANOTHER market does not stand in for this one.
    expect(positionReopensMarket([soldOut, { ...otherPosition, qty: 5 }], positionEvent())).toBe(
      true,
    );
  });

  it('leaves a row the list does not hold to the list’s own refetch', () => {
    // `applyPositionEvent` answers `refetch` there, and that answer carries the market's price
    // with its fill count — `markToLiveMarket` takes the later pair, so no second request.
    expect(positionReopensMarket(undefined, positionEvent())).toBe(false);
    expect(positionReopensMarket([], positionEvent())).toBe(false);
    expect(positionReopensMarket([otherPosition], positionEvent())).toBe(false);
    expect(positionReopensMarket([soldOut], positionEvent({ outcome: 'NO' }))).toBe(false);
  });

  it('answers once per change: not for a duplicate, a sell or a settlement', () => {
    expect(positionReopensMarket([soldOut], positionEvent({ version: 3 }))).toBe(false);
    expect(positionReopensMarket([soldOut], positionEvent({ version: 2 }))).toBe(false);
    expect(positionReopensMarket([soldOut], positionEvent({ qty: 0 }))).toBe(false);
    expect(positionReopensMarket([soldOut], positionEvent({ settled: true }))).toBe(false);
    expect(positionReopensMarket([{ ...soldOut, settled: true }], positionEvent())).toBe(false);
    // The patched list no longer answers: the next event on the holding is an ordinary one.
    const patch = applyPositionEvent([soldOut], positionEvent());
    if (patch.kind !== 'replace') throw new Error(`expected replace, got ${patch.kind}`);
    expect(positionReopensMarket(patch.positions, positionEvent({ qty: 20, version: 5 }))).toBe(
      false,
    );
  });

  it('is wired into user:position: read before the patch, one holdings restart after it', () => {
    // The provider is a component this runner cannot mount, so its wiring is pinned in source.
    const provider = readFileSync(
      path.join(SRC, 'components', 'realtime', 'realtime-provider.tsx'),
      'utf8',
    );
    const handler = provider.slice(provider.indexOf("'user:position': (raw: unknown) => {"));
    const read = handler.indexOf('if (positionReopensMarket(held, event)) reopensMarket = true;');
    const write = handler.indexOf('queryClient.setQueryData<Position[]>(query.queryKey');
    expect(read).toBeGreaterThan(-1);
    // Before the patch: afterwards the row reads 1 or more and nothing would answer.
    expect(read).toBeLessThan(write);
    // MY's rows are the holdings chunks since #300 (ADR-0147): the ones naming this market, each
    // by its own hash.
    expect(handler).toMatch(
      /if \(reopensMarket\) \{\s*for \(const query of holdingChunksToRead\(queryClient, event\.marketId\)\) \{\s*void restartQueries\(queryClient, query\.queryKey, sameChunk\(query\)\);\s*\}\s*\}/,
    );
    // Only behind the decision: an unconditional restart is a request per own trade on screen.
    expect(handler.split('holdingChunksToRead(').length - 1).toBe(1);
    expect(handler.split('restartQueries(queryClient, marketKey(').length - 1).toBe(0);
  });
});

describe('MY’s holdings chunks in the provider (#300, ADR-0147)', () => {
  it('restarts the chunks naming a market on its status, and a first read on its tick', () => {
    const provider = readFileSync(
      path.join(SRC, 'components', 'realtime', 'realtime-provider.tsx'),
      'utf8',
    );
    const tickAt = provider.indexOf("'market:tick': (raw: unknown) => {");
    const statusAt = provider.indexOf("'market:status': (raw: unknown) => {");
    const bookAt = provider.indexOf("'market:book': (raw: unknown) => {");
    expect([tickAt, statusAt, bookAt].every((at) => at > 0)).toBe(true);
    const tick = provider.slice(tickAt, statusAt);
    const status = provider.slice(statusAt, bookAt);
    // The tick: the card loop moves a chunk with rows; a chunk on its first read is read once
    // more after its answer, by its own hash — never cancelled.
    expect(tick).toMatch(
      /for \(const query of holdingMarketsFirstReads\(queryClient, event\.marketId\)\) \{\s*afterHoldingFirstRead\(query, \(\) => \{\s*void restartQueries\(queryClient, query\.queryKey, sameChunk\(query\)\);\s*\}\);\s*\}/,
    );
    expect(tick.indexOf('for (const queryKey of CARD_PAGES_KEYS)')).toBeLessThan(
      tick.indexOf('holdingMarketsFirstReads('),
    );
    // The status: `applyStatus` on the card pages, then the read that brings the flags back.
    expect(status).toMatch(
      /for \(const query of holdingChunksToRead\(queryClient, event\.marketId\)\) \{\s*void restartQueries\(queryClient, query\.queryKey, sameChunk\(query\)\);\s*\}/,
    );
    expect(status.split('holdingChunksToRead(').length - 1).toBe(1);
    // A reconnect forgets every chunk's read before the snapshot keys are read again.
    const resnapshot = provider.slice(provider.indexOf('const resnapshot = () => {'));
    expect(resnapshot.indexOf('forgetHoldingReads();')).toBeGreaterThan(0);
    expect(resnapshot.indexOf('forgetHoldingReads();')).toBeLessThan(
      resnapshot.indexOf('for (const queryKey of snapshotKeys)'),
    );
    // `MARKETS_KEY` is a snapshot key and a card key: the chunks are resnapshotted on reconnect
    // and moved by every card reducer with no line of their own.
    expect(provider).toMatch(/const SNAPSHOT_KEYS = \[\s*MARKET_KEY,\s*MARKETS_KEY,/);
    expect(provider).toContain(
      'const CARD_PAGES_KEYS = [MARKETS_KEY, WATCHLIST_PAGES_KEY] as const;',
    );
  });
});

describe('joinPositions', () => {
  /** The row as a REST answer that left BEFORE the trade carries it: one version behind. */
  const stale: Position = { ...position, qty: 10, costBasisCoin: '5000', version: 3 };
  /** The same row after a `user:position` event applied the trade. */
  const live: Position = {
    ...position,
    qty: 14,
    costBasisCoin: '7000',
    realizedPnlCoin: '120',
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
        costBasisCoin: '7000',
        realizedPnlCoin: '120',
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
    expect(
      applyBalanceEvent(me, balanceEvent({ availableCoin: '80000', lockedCoin: '1200' })),
    ).toEqual({
      kind: 'replace',
      me: { ...me, balance: { availableCoin: '80000', lockedCoin: '1200' } },
    });
  });

  it('asks for the profile rather than inventing one it cannot build', () => {
    // Never a `Me` synthesised from the event — it carries two amounts and no profile — and
    // never "do nothing" either: the caller cancels the in-flight `GET /me` before it writes,
    // so a tab that is still loading would be left on a skeleton with nothing to restart it.
    expect(applyBalanceEvent(undefined, balanceEvent())).toEqual({ kind: 'refetch' });
  });

  it('writes the balance and asks for the profile again while the start Coin waits (#70)', () => {
    // The worker's payment of a waiting grant reaches the tab as nothing but this event, which
    // cannot say it was the grant: without the second request the wallet kept its "준비되는 대로
    // 지급됩니다" over a balance that already held the start Coin.
    const waiting: Me = {
      ...me,
      balance: { availableCoin: '0', lockedCoin: '0' },
      startGrant: { status: 'pending', amountCoin: null, grantedAt: null },
    };
    expect(
      applyBalanceEvent(waiting, balanceEvent({ availableCoin: '10000', lockedCoin: '0' })),
    ).toEqual({
      kind: 'replaceAndRefetch',
      // The grant is left as held: only `GET /me` may say it is paid.
      me: { ...waiting, balance: { availableCoin: '10000', lockedCoin: '0' } },
    });
  });

  it('costs no request once the start Coin is paid, or for an account with no grant', () => {
    const granted: Me = {
      ...me,
      startGrant: {
        status: 'granted',
        amountCoin: '10000',
        grantedAt: '2026-10-18T00:00:00.000Z',
      },
    };
    for (const held of [granted, { ...me, startGrant: null }]) {
      expect(applyBalanceEvent(held, balanceEvent()).kind, String(held.startGrant?.status)).toBe(
        'replace',
      );
    }
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

describe('independent participant freshness (#132)', () => {
  const classified = { ...detail, traderCount: 0, statsRevision: '12' };
  const stats = {
    type: 'market:stats' as const,
    marketId: ID,
    traderCount: 0,
    statsRevision: '12',
  };
  it('updates only participants while leaving price, volume, chart ordering and status intact', () => {
    expect(applyStats(detail, stats)).toEqual(classified);
    expect(applyStats(undefined, stats)).toBeUndefined();
    expect(applyStats(detail, { ...stats, marketId: OTHER_ID })).toBeUndefined();
    expect(applyStats(classified, stats)).toBeUndefined();
  });
  it('accepts a newer participant count even on an equal or older trade counter', () => {
    for (const tradeCount of [9, 10]) {
      const next = applyTick(detail, tick({ tradeCount, statsRevision: '12', traderCount: 0 }));
      expect(next).toEqual(classified);
    }
  });
  it('accepts new price/raw trade facts without resurrecting excluded participants', () => {
    const next = applyTick(
      classified,
      tick({ tradeCount: 11, statsRevision: '11', traderCount: 5 }),
    );
    expect(next).toMatchObject({
      lastPrice: 63,
      volumeCoin: '130000',
      tradeCount: 11,
      traderCount: 0,
      statsRevision: '12',
    });
    expect(next?.lastFillAt).toBe(tick().ts);
  });
  it('holds newer participants against old REST independently of trade and status groups', () => {
    const fetched = {
      ...detail,
      tradeCount: 11,
      volumeCoin: '130000',
      lastPrice: 63,
      traderCount: 5,
      statsRevision: '11',
    };
    expect(joinMarket(classified, fetched)).toMatchObject({
      tradeCount: 11,
      lastPrice: 63,
      traderCount: 0,
      statsRevision: '12',
    });
    expect(joinMarket(fetched, classified)).toMatchObject({
      tradeCount: 11,
      lastPrice: 63,
      traderCount: 0,
      statsRevision: '12',
    });
    expect(
      joinMarketPages(pagesOf([classified]), pagesOf([fetched])).pages[0]?.items[0],
    ).toMatchObject({ tradeCount: 11, traderCount: 0, statsRevision: '12' });
  });
  it('takes a subsequent normal-fill participant count after exclusion without conflating counters', () => {
    const next = applyTick(
      classified,
      tick({ tradeCount: 11, statsRevision: '13', traderCount: 2 }),
    );
    expect(next).toMatchObject({ tradeCount: 11, traderCount: 2, statsRevision: '13' });
    expect(applyStats(next, stats)).toBeUndefined();
  });
});

describe('the account’s own live orders on a market signal (#123, ADR-0141 결정 10)', () => {
  const ACCOUNT = 'account-a';
  const live = (over: Partial<Order> = {}): Order => ({
    id: OTHER_ID,
    requestId: 'request-1',
    marketId: ID,
    marketSlug: 'rate-cut-2026',
    marketTitle: '기준금리 인하?',
    outcome: 'YES',
    side: 'buy',
    timeInForce: 'gtc',
    limitPriceCoin: 40,
    protectedLimitPriceCoin: 40,
    qty: 1,
    budgetCoin: null,
    filledQty: 0,
    filledAmountCoin: '0',
    cancelledQty: 0,
    unspentCoin: null,
    status: 'open',
    rejectReason: null,
    cancelReason: null,
    createdAt: '2026-11-16T00:00:00.000Z',
    endedAt: null,
    awaitingRecovery: false,
    ...over,
  });
  const listed = (client: QueryClient, ...orders: Order[]) =>
    client.setQueryData(myOrdersLiveKey(ACCOUNT), {
      pages: [{ items: orders, nextCursor: null }],
      pageParams: [undefined],
    });

  it('restarts for a market the account holds a live order on, by any case of its id', () => {
    const client = new QueryClient();
    listed(client, live());
    expect(bookRestartsOwnOrders(client, ID, ACCOUNT)).toBe(true);
    expect(bookRestartsOwnOrders(client, ID.toUpperCase(), ACCOUNT)).toBe(true);
    expect(ownLiveOrderIds(client, ID, ACCOUNT)).toEqual([OTHER_ID]);
    expect(bookRestartsOwnOrders(client, THIRD_ID, ACCOUNT)).toBe(false);
  });

  it('counts an order’s detail too, and never an ended order or another account’s', () => {
    const client = new QueryClient();
    client.setQueryData(myOrderKey(OTHER_ID, ACCOUNT), live());
    expect(bookRestartsOwnOrders(client, ID, ACCOUNT)).toBe(true);
    client.setQueryData(myOrderKey(OTHER_ID, ACCOUNT), live({ status: 'filled', filledQty: 1 }));
    expect(bookRestartsOwnOrders(client, ID, ACCOUNT)).toBe(false);
    listed(client, live());
    expect(bookRestartsOwnOrders(client, ID, 'account-b')).toBe(false);
    // Signed out, or `['me']` not read yet.
    expect(bookRestartsOwnOrders(client, ID, undefined)).toBe(false);
  });

  it('leaves it to the screen that reads the market’s book (the detail’s budget, ADR-0138)', () => {
    const client = new QueryClient();
    listed(client, live());
    const observer = new QueryObserver(client, {
      queryKey: marketBookKey(ID),
      queryFn: () => ({}),
      enabled: false,
    });
    const unsubscribe = observer.subscribe(() => undefined);
    expect(bookRestartsOwnOrders(client, ID, ACCOUNT)).toBe(false);
    unsubscribe();
    expect(bookRestartsOwnOrders(client, ID, ACCOUNT)).toBe(true);
  });

  it('keeps every market signalled inside the shared window for the trailing round', () => {
    const shared = new MarketWindow(10_000);
    // The leading round reads A at once.
    expect(shared.offer(ID, 0)).toEqual({ markets: [ID] });
    // A again, then B (the user went from MY to B's order detail): both refused, both kept.
    expect(shared.offer(ID, 1_000)).toEqual({ wait: 9_000 });
    expect(shared.offer(THIRD_ID.toUpperCase(), 2_000)).toEqual({ wait: 8_000 });
    // The trailing timer offers nothing of its own and reads every market kept, once each.
    expect(shared.offer(undefined, 10_000)).toEqual({ markets: [ID, THIRD_ID] });
    // One round per window: the next signal waits, and a round reads only what came since.
    expect(shared.offer(THIRD_ID, 10_001)).toEqual({ wait: 9_999 });
    expect(shared.offer(undefined, 20_000)).toEqual({ markets: [THIRD_ID] });
    // A torn-down socket's markets are not read by the next one's round.
    expect(shared.offer(ID, 20_001)).toEqual({ wait: 9_999 });
    shared.clear();
    expect(shared.offer(undefined, 30_000)).toEqual({ markets: [] });
  });

  it('reads the live lists and the live details of every market of the round', () => {
    const client = new QueryClient();
    const DETAIL = '0b0b0b0b-0000-4000-8000-0000000000aa';
    // MY listed A's order; B's order is held by its detail, the screen now shown.
    listed(client, live());
    client.setQueryData(myOrderKey(DETAIL, ACCOUNT), live({ id: DETAIL, marketId: THIRD_ID }));
    expect(ownOrdersRefreshKeys(client, [ID, THIRD_ID], ACCOUNT)).toEqual([
      MY_ORDERS_LIVE_KEY,
      myOrderKey(OTHER_ID, ACCOUNT),
      myOrderKey(DETAIL, ACCOUNT),
    ]);
    // A round of A alone left B's detail out — the hole: the lists' prefix does not cover it.
    expect(ownOrdersRefreshKeys(client, [ID], ACCOUNT)).not.toContainEqual(
      myOrderKey(DETAIL, ACCOUNT),
    );
    expect(ownOrdersRefreshKeys(client, [ID, THIRD_ID], undefined)).toEqual([MY_ORDERS_LIVE_KEY]);
  });

  it('restarts on a status the first reads still on their way, held order or not', () => {
    const client = new QueryClient();
    const DETAIL = '0b0b0b0b-0000-4000-8000-0000000000bb';
    /** A first read that left and has not answered: no data, fetching. */
    const firstRead = (queryKey: readonly unknown[]) =>
      void client.prefetchQuery({ queryKey, queryFn: () => new Promise<never>(() => undefined) });
    // Nothing held, nothing on its way: nothing to restart (the old rule's whole case).
    expect(ownOrdersStatusKeys(client, ID, ACCOUNT)).toEqual([]);
    // The market detail's 내 대기 주문, MY's list and a detail, each still on its first read; and
    // reads that are not this market's or not this account's.
    firstRead(myOrdersLiveKey(ACCOUNT, ID));
    firstRead(myOrdersLiveKey(ACCOUNT));
    firstRead(myOrderKey(DETAIL, ACCOUNT));
    firstRead(myOrdersLiveKey(ACCOUNT, THIRD_ID));
    firstRead(myOrdersLiveKey('account-b', ID));
    expect(ownOrdersStatusKeys(client, ID.toUpperCase(), ACCOUNT)).toEqual([
      myOrdersLiveKey(ACCOUNT, ID),
      myOrdersLiveKey(ACCOUNT),
      myOrderKey(DETAIL, ACCOUNT),
    ]);
    expect(ownOrdersStatusKeys(client, ID, undefined)).toEqual([]);
    client.clear();
  });

  it('restarts every live list and the held orders’ details when the tab holds one there', () => {
    const client = new QueryClient();
    listed(client, live());
    expect(ownOrdersStatusKeys(client, ID, ACCOUNT)).toEqual([
      MY_ORDERS_LIVE_KEY,
      myOrderKey(OTHER_ID, ACCOUNT),
    ]);
    // An answered read is not a first one: another market's status restarts nothing of it.
    expect(ownOrdersStatusKeys(client, THIRD_ID, ACCOUNT)).toEqual([]);
  });

  it('is what the provider’s market:status restarts', () => {
    const source = readFileSync(
      path.join(SRC, 'components/realtime/realtime-provider.tsx'),
      'utf8',
    );
    expect(source).toMatch(
      /for \(const key of ownOrdersStatusKeys\(queryClient, event\.marketId, identity \?\? undefined\)\) \{\s*void restartQueries\(queryClient, key\);/,
    );
  });

  it('is what the provider’s market:book round reads, the trailing timer offering nothing', () => {
    const source = readFileSync(
      path.join(SRC, 'components/realtime/realtime-provider.tsx'),
      'utf8',
    );
    expect(source).toContain('const ownOrders = new MarketWindow(OWN_ORDERS_INVALIDATE_MS);');
    expect(source).toContain('const round = ownOrders.offer(marketId, now);');
    expect(source).toContain(
      'for (const key of ownOrdersRefreshKeys(queryClient, round.markets, identity ?? undefined)) {',
    );
    expect(source).toMatch(/ownOrdersPending = null;\s*refreshOwnOrders\(\);/);
    expect(source).toMatch(/ownOrdersPending = null;\s*ownOrders\.clear\(\);/);
  });

  it('reads the account’s ended-order lists with its live orders (#124, ADR-0143 결정 9)', () => {
    // A buy another tab cancelled, or a restriction, a pause, a recovery approval or a close ended,
    // sends `market:book` or `market:status` and no `user:` event: the round that drops it from
    // the live list must ask for the ended list it now belongs to, or MY's two previews both miss it.
    const client = new QueryClient();
    const pages = { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] };
    listed(client, live());
    client.setQueryData(myOrderHistoryKey({}, ACCOUNT), pages);
    client.setQueryData(myOrderHistoryKey({ period: '7d', market: ID }, ACCOUNT), pages);
    // Another account's entry, and the history's fills (a cancel writes no fill), are left alone.
    client.setQueryData(myOrderHistoryKey({}, 'account-b'), pages);
    client.setQueryData(myFillHistoryKey({}, ACCOUNT), pages);
    const own = [
      myOrderHistoryKey({}, ACCOUNT),
      myOrderHistoryKey({ period: '7d', market: ID }, ACCOUNT),
    ];
    expect(ownOrderHistoryKeys(client, ACCOUNT)).toEqual(own);
    expect(ownOrderHistoryKeys(client, undefined)).toEqual([]);
    expect(ownOrdersRefreshKeys(client, [ID], ACCOUNT)).toEqual([
      MY_ORDERS_LIVE_KEY,
      myOrderKey(OTHER_ID, ACCOUNT),
      ...own,
    ]);
    expect(ownOrdersStatusKeys(client, ID, ACCOUNT)).toEqual([
      MY_ORDERS_LIVE_KEY,
      ...own,
      myOrderKey(OTHER_ID, ACCOUNT),
    ]);
    // A status on a market the tab holds no live order on restarts no ended list: nothing it
    // knows of ended there.
    expect(ownOrdersStatusKeys(client, THIRD_ID, ACCOUNT)).toEqual([]);
    // Signed out, or `['me']` not read: the live lists only, as before.
    expect(ownOrdersRefreshKeys(client, [ID], undefined)).toEqual([MY_ORDERS_LIVE_KEY]);
  });
});

describe('SellableRotation: the 매도 가능액 read again for market:book (#67, ADR-0142)', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const C = '33333333-3333-4333-8333-333333333333';

  it('reads one market per gap, the longest waiting first, whatever the number held', () => {
    const rotation = new SellableRotation(6_000);
    rotation.mark(A, 0);
    rotation.mark(B, 10);
    rotation.mark(A, 20);
    rotation.mark(C, 30);
    expect(rotation.next(100)).toEqual({ marketId: A });
    expect(rotation.next(200)).toEqual({ wait: 5_900 });
    expect(rotation.next(6_100)).toEqual({ marketId: B });
    expect(rotation.next(12_100)).toEqual({ marketId: C });
    expect(rotation.next(18_100)).toBeNull();
    // Ten a minute at most: a market signalled every second still waits its turn.
    const busy = new SellableRotation(6_000);
    let reads = 0;
    for (let now = 0; now < 60_000; now += 1_000) {
      busy.mark(now % 2000 === 0 ? A : B, now);
      const round = busy.next(now);
      if (round !== null && 'marketId' in round) reads += 1;
    }
    expect(reads).toBeLessThanOrEqual(10);
  });

  it('skips a market read again by another path since its signal, and one dropped', () => {
    const rotation = new SellableRotation(6_000);
    rotation.mark(A, 0);
    rotation.mark(B, 0);
    rotation.mark(C, 0);
    rotation.drop(B.toUpperCase());
    // A's entry answered after its signal (a user:position, a focus): not read again.
    expect(rotation.next(100, (id) => id === A)).toEqual({ marketId: C });
    expect(rotation.size).toBe(0);
  });

  it('compares on the last signal: a read between two signals does not skip the second', () => {
    const rotation = new SellableRotation(6_000);
    rotation.mark(B, 0);
    expect(rotation.next(0)).toEqual({ marketId: B });
    // A waits its turn; a focus reads its entry at 2 s, and a new book change comes at 3 s.
    rotation.mark(A, 1_000);
    rotation.mark(A, 3_000);
    const readAt = 2_000;
    const readSince = (_id: string, markedAt: number) => readAt > markedAt;
    expect(rotation.next(6_000, readSince)).toEqual({ marketId: A });
    // With no second signal, the focus read covered it.
    const once = new SellableRotation(6_000);
    once.mark(A, 1_000);
    expect(once.next(6_000, readSince)).toBeNull();
  });

  it('never skips a mark made while a read was in flight: its answer is the older book', () => {
    // A read leaves at 0, the book changes at 5 ms, the answer lands at 15 ms: answered after the
    // signal, taken before the change.
    const answeredAt = 15;
    const readSince = (_id: string, markedAt: number) => answeredAt > markedAt;
    const rotation = new SellableRotation(6_000);
    rotation.mark(A, 5, true);
    expect(rotation.next(6_000, readSince)).toEqual({ marketId: A });
    // The last signal's flag: one with no read in flight is covered by a later answer, which left
    // after it and so saw the earlier change as well.
    const later = new SellableRotation(6_000);
    later.mark(A, 5, true);
    later.mark(A, 10);
    expect(later.next(6_000, readSince)).toBeNull();
  });

  it('keeps its line while the caller waits, and clears on a reconnect', () => {
    const rotation = new SellableRotation(6_000);
    rotation.mark(A, 0);
    expect(rotation.next(0)).toEqual({ marketId: A });
    rotation.mark(B, 1_000);
    rotation.mark(C, 2_000);
    // Hidden meanwhile: nothing is asked; shown again, the oldest goes first at the same gap.
    expect(rotation.next(60_000)).toEqual({ marketId: B });
    expect(rotation.next(61_000)).toEqual({ wait: 5_000 });
    rotation.clear();
    expect(rotation.next(70_000)).toBeNull();
  });
});

describe('bookRestartsSellable (#67, ADR-0142, R5)', () => {
  const ACCOUNT_A = 'a1e1c0de-0000-4000-8000-000000000001';
  const held = (outcome: 'YES' | 'NO', qty: number) => ({
    outcome,
    qty,
    unlockedQty: qty,
    restingSellQty: 0,
    quote: null,
  });
  const sellable = ([yes, no]: [number, number]) => ({
    marketId: ID,
    contracts: [held('YES', yes), held('NO', no)],
  });

  it('reads again only a holding there, of the account on screen', () => {
    const client = new QueryClient();
    try {
      expect(bookRestartsSellable(client, ID, ACCOUNT_A)).toBe(false);
      client.setQueryData(sellableKey(ID, ACCOUNT_A), sellable([0, 0]));
      // A member who holds nothing there (the detail's 0s) adds no request.
      expect(bookRestartsSellable(client, ID, ACCOUNT_A)).toBe(false);
      client.setQueryData(sellableKey(ID, ACCOUNT_A), sellable([0, 2]));
      expect(bookRestartsSellable(client, ID, ACCOUNT_A)).toBe(true);
      expect(bookRestartsSellable(client, ID.toUpperCase(), ACCOUNT_A)).toBe(true);
      // Every contract in resting sells: a restriction's or an admin grant's bulk cancel unlocks
      // them and publishes `market:book` alone, so this one is read again too.
      client.setQueryData(sellableKey(ID, ACCOUNT_A), {
        marketId: ID,
        contracts: [
          { outcome: 'YES', qty: 2, unlockedQty: 0, restingSellQty: 2, quote: null },
          held('NO', 0),
        ],
      });
      expect(bookRestartsSellable(client, ID, ACCOUNT_A)).toBe(true);
      // A visitor, or another account's entry.
      expect(bookRestartsSellable(client, ID, undefined)).toBe(false);
      expect(bookRestartsSellable(client, ID, 'someone-else')).toBe(false);
    } finally {
      client.clear();
    }
  });

  it('marks a first read still on its way, which answers with the book before the change (P2)', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const key = sellableKey(ID, ACCOUNT_A);
    let answer: (value: unknown) => void = () => undefined;
    try {
      const first = client.fetchQuery({
        queryKey: key,
        queryFn: () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      });
      // No answer yet, so whether the account holds anything there is not known: marked, and
      // the handler's `inFlight` reads the same state, so the answer cannot clear the mark.
      expect(client.getQueryState(key)?.fetchStatus).toBe('fetching');
      expect(client.getQueryData(key)).toBeUndefined();
      expect(bookRestartsSellable(client, ID, ACCOUNT_A)).toBe(true);
      // Another account's first read is not this account's.
      expect(bookRestartsSellable(client, ID, 'someone-else')).toBe(false);
      answer(sellable([0, 0]));
      await first;
      // Answered with nothing held: no request any more.
      expect(bookRestartsSellable(client, ID, ACCOUNT_A)).toBe(false);
    } finally {
      client.clear();
    }
  });

  it('does not mark a failed first read with nothing in flight', () => {
    const client = new QueryClient();
    try {
      client
        .getQueryCache()
        .build(client, { queryKey: sellableKey(ID, ACCOUNT_A) })
        .setState({ status: 'error', fetchStatus: 'idle', error: new Error('down') });
      expect(bookRestartsSellable(client, ID, ACCOUNT_A)).toBe(false);
    } finally {
      client.clear();
    }
  });
});

describe('market:book never moves a price or a holding (#67: 봇 호가는 참고 평가를 바꾸지 않는다)', () => {
  it('writes neither the market row nor the positions, only the book and the windows', () => {
    const provider = readFileSync(
      path.join(SRC, 'components', 'realtime', 'realtime-provider.tsx'),
      'utf8',
    );
    const start = provider.indexOf("'market:book': (raw: unknown) => {");
    const handler = provider.slice(start, provider.indexOf("'user:balance':", start));
    expect(handler).toContain('refreshBook(parsed.data.marketId);');
    expect(handler).toContain('bookRestartsSellable(queryClient, parsed.data.marketId');
    const writes = ['marketKey(', 'POSITIONS_KEY', 'positionsKey', 'setQueryData', 'TICKS_KEY'];
    for (const write of writes) {
      expect(handler, write).not.toContain(write);
    }
  });

  it('reads the sellable again on market:status, and patches only this account’s positions', () => {
    const provider = readFileSync(
      path.join(SRC, 'components', 'realtime', 'realtime-provider.tsx'),
      'utf8',
    );
    const status = provider.slice(
      provider.indexOf("'market:status': (raw: unknown) => {"),
      provider.indexOf("'market:trade':"),
    );
    expect(status).toContain(
      'void restartQueries(queryClient, marketSellableKey(event.marketId));',
    );
    const position = provider.slice(provider.indexOf("'user:position': (raw: unknown) => {"));
    expect(position).toContain('if (query.queryKey[2] !== identity) continue;');
  });
});

describe('a user:position keeps the holding’s market values (#67, ADR-0142)', () => {
  it('patches the holding and leaves the market’s price, time, fill count and status key', () => {
    // The event carries none of them; `market:tick` writes them on `['market', id]`.
    const row = {
      ...position,
      marketLastFillAt: '2026-09-06T12:00:00.000Z',
      marketTradeCount: 9,
      marketStatusEventId: '7',
    };
    const patch = applyPositionEvent([row], positionEvent());
    if (patch.kind !== 'replace') throw new Error(`expected replace, got ${patch.kind}`);
    expect(patch.positions[0]).toMatchObject({
      qty: 14,
      marketLastPrice: row.marketLastPrice,
      marketLastFillAt: '2026-09-06T12:00:00.000Z',
      marketTradeCount: 9,
      marketStatusEventId: '7',
    });
    // And a REST answer is where they come from (`joinPositions`).
    const answer = { ...row, marketTradeCount: 10, version: 1 };
    expect(joinPositions(patch.positions, [answer])[0]?.marketTradeCount).toBe(10);
  });
});

describe('the wallet’s live orders (#69, ADR-0144 결정 2-11)', () => {
  const ACCOUNT = 'account-a';
  const buy = { id: OTHER_ID, marketId: ID, status: 'open', side: 'buy' } as Order;
  const pages = (...items: Order[]) => ({
    pages: [{ items, nextCursor: null }],
    pageParams: [undefined],
  });

  it('is left out of the user:position order restart while on screen, with the history lists', async () => {
    const wallet = walletLiveOrdersKey(ACCOUNT);
    const shown = () => true;
    expect(wallet).toEqual(['orders', 'live', 'wallet', ACCOUNT]);
    expect(isWalletLiveOrdersKey(wallet)).toBe(true);
    expect(positionRestartsOrder({ queryKey: wallet, isActive: shown })).toBe(false);
    expect(
      positionRestartsOrder({ queryKey: walletLiveOrdersKey('account-b'), isActive: shown }),
    ).toBe(false);
    // Off screen it is reached: marked stale only, so a return inside `staleTime` reads it.
    expect(positionRestartsOrder({ queryKey: wallet, isActive: () => false })).toBe(true);
    const others = [
      myOrdersLiveKey(ACCOUNT),
      myOrdersLiveKey(ACCOUNT, ID),
      myOrderKey(OTHER_ID, ACCOUNT),
      myOrderFillsKey(OTHER_ID, ACCOUNT),
      myMarketFillsKey(ID, ACCOUNT),
    ];
    // 거래·정산 이력's two lists (#301, ADR-0148): on screen through the history window instead,
    // off screen reached (marked stale).
    for (const queryKey of [
      myOrderHistoryKey({}, ACCOUNT),
      myOrderHistoryKey({ market: ID, period: '30d' }, ACCOUNT),
      myFillHistoryKey({ period: '7d' }, ACCOUNT),
      myFillHistoryKey({}, 'account-b'),
    ]) {
      expect(isOrderHistoryKey(queryKey)).toBe(true);
      expect(positionRestartsOrder({ queryKey, isActive: shown }), JSON.stringify(queryKey)).toBe(
        false,
      );
      expect(positionRestartsOrder({ queryKey, isActive: () => false })).toBe(true);
    }
    for (const queryKey of others) {
      expect(isOrderHistoryKey(queryKey), JSON.stringify(queryKey)).toBe(false);
      for (const isActive of [shown, () => false]) {
        expect(positionRestartsOrder({ queryKey, isActive }), JSON.stringify(queryKey)).toBe(true);
      }
    }
    // Through `restartQueries`, as the provider calls it: every other entry is asked again, and
    // the wallet's entry on screen is not touched.
    const client = new QueryClient();
    const read = vi.fn(() => new Promise<never>(() => undefined));
    try {
      for (const queryKey of [wallet, ...others]) client.setQueryData(queryKey, pages());
      const stop = new QueryObserver(client, {
        queryKey: wallet,
        queryFn: read,
        staleTime: Number.POSITIVE_INFINITY,
      }).subscribe(() => undefined);
      try {
        await restartQueries(client, ORDERS_KEY, positionRestartsOrder);
        expect(client.getQueryState(wallet)?.isInvalidated).toBe(false);
        expect(read).not.toHaveBeenCalled();
        for (const queryKey of others) {
          expect(client.getQueryState(queryKey)?.isInvalidated, JSON.stringify(queryKey)).toBe(
            true,
          );
        }
      } finally {
        stop();
      }
    } finally {
      client.clear();
    }
  });

  it('is marked stale off screen by a fill, so a return inside staleTime reads it once', async () => {
    // The wallet was left; a fill in a market its list does not hold arrives meanwhile (a buy
    // another tab placed). `walletMissesMarket` looks at the entry on screen only, so the
    // restart is what makes the return read it — and join that market's room.
    const client = new QueryClient();
    const wallet = walletLiveOrdersKey(ACCOUNT);
    const read = vi.fn(() => new Promise<never>(() => undefined));
    try {
      client.setQueryData(wallet, pages(buy));
      await restartQueries(client, ORDERS_KEY, positionRestartsOrder);
      // Marked only: nothing on screen asks, so no request now.
      expect(client.getQueryState(wallet)?.isInvalidated).toBe(true);
      expect(client.getQueryState(wallet)?.fetchStatus).toBe('idle');
      // The wallet mounts again inside `staleTime` (30 s, the app's default): one read.
      const stop = new QueryObserver(client, {
        queryKey: wallet,
        queryFn: read,
        staleTime: 30_000,
      }).subscribe(() => undefined);
      try {
        expect(read).toHaveBeenCalledTimes(1);
      } finally {
        stop();
      }
    } finally {
      client.clear();
    }
  });

  it('is seen by the market:book round, which reads it by the live lists’ prefix', () => {
    const client = new QueryClient();
    try {
      client.setQueryData(walletLiveOrdersKey(ACCOUNT), pages(buy));
      expect(ownLiveOrderIds(client, ID, ACCOUNT)).toEqual([OTHER_ID]);
      expect(bookRestartsOwnOrders(client, ID, ACCOUNT)).toBe(true);
      expect(bookRestartsOwnOrders(client, ID, 'account-b')).toBe(false);
      expect(ownOrdersRefreshKeys(client, [ID], ACCOUNT)[0]).toEqual(MY_ORDERS_LIVE_KEY);
    } finally {
      client.clear();
    }
  });

  it('is asked for by a fill in a market it does not hold, while it is on screen', () => {
    const client = new QueryClient();
    const wallet = walletLiveOrdersKey(ACCOUNT);
    const elsewhere = '3f2504e0-4f89-11d3-9a0c-0305e82c33ff';
    try {
      client.setQueryData(wallet, pages(buy));
      // Not on screen: nothing (it is read whole when mounted).
      expect(walletMissesMarket(client, elsewhere, ACCOUNT)).toBe(false);
      const stop = new QueryObserver(client, {
        queryKey: wallet,
        queryFn: () => new Promise<never>(() => undefined),
        staleTime: Number.POSITIVE_INFINITY,
      }).subscribe(() => undefined);
      try {
        // The market of a buy it holds: the wallet is in that room already.
        expect(walletMissesMarket(client, ID, ACCOUNT)).toBe(false);
        expect(walletMissesMarket(client, ID.toUpperCase(), ACCOUNT)).toBe(false);
        // A market it does not hold, or holds only an ended order of: one read is asked for.
        expect(walletMissesMarket(client, elsewhere, ACCOUNT)).toBe(true);
        client.setQueryData(wallet, pages({ ...buy, status: 'filled' }));
        expect(walletMissesMarket(client, ID, ACCOUNT)).toBe(true);
        // Another account's entry, or no account: nothing.
        expect(walletMissesMarket(client, elsewhere, 'account-b')).toBe(false);
        expect(walletMissesMarket(client, elsewhere, undefined)).toBe(false);
      } finally {
        stop();
      }
    } finally {
      client.clear();
    }
  });

  it('is asked for through the book round’s window, never a request per fill', () => {
    const handler = readFileSync(
      path.join(SRC, 'components/realtime/realtime-provider.tsx'),
      'utf8',
    );
    const position = handler.slice(handler.indexOf("'user:position': (raw: unknown) => {"));
    expect(position).toMatch(
      /void restartQueries\(queryClient, ORDERS_KEY, positionRestartsOrder\);\s*if \(walletMissesMarket\(queryClient, event\.marketId, identity\)\) \{\s*refreshOwnOrders\(event\.marketId\);/,
    );
  });

  it('is restarted by a status while its first read is on its way, as every market’s list', () => {
    const client = new QueryClient();
    void client.prefetchQuery({
      queryKey: walletLiveOrdersKey(ACCOUNT),
      queryFn: () => new Promise<never>(() => undefined),
    });
    void client.prefetchQuery({
      queryKey: walletLiveOrdersKey('account-b'),
      queryFn: () => new Promise<never>(() => undefined),
    });
    expect(ownOrdersStatusKeys(client, ID, ACCOUNT)).toEqual([walletLiveOrdersKey(ACCOUNT)]);
    client.clear();
  });
});

describe('the balance-history window (#69, ADR-0144 결정 6)', () => {
  const W = BALANCE_HISTORY_INVALIDATE_MS;
  const MINUTE = 60_000;

  /**
   * The provider's `refreshBalanceHistory` on a virtual clock: the same `RoundWindow` it holds,
   * each step done as the provider does it — a round on `'run'`, the one timer armed on `wait`
   * and `fired` when it is due, nothing on `null`. The times rounds ran at.
   */
  function rounds(events: readonly number[]): number[] {
    const gate = new RoundWindow(W);
    let pendingAt: number | null = null;
    const ran: number[] = [];
    const take = (now: number, step: ReturnType<RoundWindow['offer']>) => {
      if (step === null) return;
      if (step === 'run') {
        ran.push(now);
        return;
      }
      // The provider arms one timer per `wait`; a second one here would be a window bug.
      expect(pendingAt).toBeNull();
      pendingAt = now + step.wait;
    };
    let next = 0;
    while (next < events.length || pendingAt !== null) {
      const event = events[next] ?? Number.POSITIVE_INFINITY;
      if (pendingAt !== null && pendingAt <= event) {
        const at = pendingAt;
        pendingAt = null;
        take(at, gate.fired(at));
      } else {
        take(event, gate.offer(event));
        next += 1;
      }
    }
    return ran;
  }

  /** The most rounds any closed 60 s window holds. */
  const busiestMinute = (ran: readonly number[]) =>
    Math.max(
      0,
      ...ran.map((start) => ran.filter((at) => at >= start && at <= start + MINUTE).length),
    );

  /** Every event has a round at or after it, within the window: no update is lost. */
  const noneLost = (events: readonly number[], ran: readonly number[]) =>
    events.every((event) => ran.some((at) => at >= event && at <= event + W));

  const every = (gap: number, span = MINUTE * 2) =>
    Array.from({ length: Math.floor(span / gap) + 1 }, (_, at) => at * gap);

  it('runs at most 7 rounds in any minute, and loses no event, at 100 ms, 1 s and 5 s', () => {
    for (const gap of [100, 1_000, 5_000]) {
      const events = every(gap);
      const ran = rounds(events);
      expect(busiestMinute(ran), `${String(gap)} ms`).toBeLessThanOrEqual(
        Math.floor(MINUTE / W) + 1,
      );
      expect(noneLost(events, ran), `${String(gap)} ms`).toBe(true);
    }
  });

  it('holds for any stream of events', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: MINUTE * 3 }), { maxLength: 200 }), (raw) => {
        const events = [...raw].sort((a, b) => a - b);
        const ran = rounds(events);
        return busiestMinute(ran) <= 7 && noneLost(events, ran);
      }),
    );
  });

  it('reads a lone event at once (the leading edge)', () => {
    expect(rounds([0])).toEqual([0]);
    // After a quiet longer than the window, the next event is read the moment it lands.
    expect(rounds([0, 3_000, W * 3])).toEqual([0, W, W * 3]);
  });

  it('arms one trailing round, and arms again once disarmed (a resnapshot read it all)', () => {
    const gate = new RoundWindow(W);
    expect(gate.offer(0)).toBe('run');
    expect(gate.offer(1_000)).toEqual({ wait: W - 1_000 });
    // Armed: later events inside the window ride on that round.
    expect(gate.offer(2_000)).toBeNull();
    expect(gate.fired(W)).toBe('run');
    expect(gate.offer(W + 1)).toEqual({ wait: W - 1 });
    // The caller cancelled its timer: without `disarm` the window would wait on a round that
    // never comes and drop every event after.
    gate.disarm();
    expect(gate.offer(W + 2)).toEqual({ wait: W - 2 });
  });
});
