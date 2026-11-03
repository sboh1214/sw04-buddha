import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  INT4_MAX,
  MARKET_SLUG_PATTERN,
  MARKET_SLUG_STEM_MAX,
  MARKET_TEXT_MAX,
  TICKS_MAX_POINTS,
} from './constants.js';
import { findExcludedIdentifier } from './guards/excluded.js';
import { STORABLE_INSTANT_MIN, STORABLE_INSTANT_TOO_EARLY } from './market-rules.js';
import { TIME_ITEMS } from './market-times.js';
import {
  ALL_MARKET_STATUSES,
  DEFAULT_MARKET_SORT,
  MARKET_LIST_STATUSES,
  MARKET_SORTS,
  PUBLIC_MARKET_STATUSES,
  isPublicMarketStatus,
  RECOMMENDED_VOLUME_HOURS,
  adminMarketListQuerySchema,
  adminMarketSchema,
  categorySchema,
  createMarketBodySchema,
  fillSchema,
  marketEventSchema,
  marketListQuerySchema,
  marketSchema,
  marketSlugSchema,
  marketSummarySchema,
  orderSchema,
  positionSchema,
  positionsQuerySchema,
  priceSeriesSchema,
  priceTickSchema,
  slugify,
  ticksQuerySchema,
  updateMarketBodySchema,
} from './market.js';

const marketId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const at = '2026-09-05T00:00:00.000Z';

const issuePaths = (result: { error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path.join('.')) ?? [];

// ---- read models ---------------------------------------------------------------------
const summary = {
  id: marketId,
  slug: 'kospi-3000-2026',
  title: '2026년 안에 코스피 3000?',
  category: { slug: 'economy', nameKo: '경제' },
  imageUrl: null,
  status: 'open',
  judgementDelayed: false,
  lastPrice: 52,
  volumeCoin: '12345',
  tradeCount: 3,
  traderCount: 2,
  closeAt: at,
  openAt: at,
  resolvedResult: null,
  statusEventId: '2',
  createdAt: at,
};
// The full text of the market's rules (#80): every version item, as its v1 holds it.
const ruleContent = {
  title: summary.title,
  description: null,
  yesCondition: '12월 30일 코스피 종가가 3000 이상이면 YES.',
  noCondition: '사건 기한까지 3000 이상으로 마감하지 않으면 NO.',
  eventDeadline: '2026-12-30T06:30:00.000Z',
  primarySource: { name: '한국거래소', url: 'https://data.krx.co.kr' },
  fallbackSources: [{ name: '한국거래소 보도자료', url: 'https://www.krx.co.kr' }],
  fallbackCondition: '1차 출처에 종가가 없으면 대체 출처를 본다.',
  longDelayDays: 14,
  delayHandling: '장기 지연 기한까지 종가가 나오지 않으면 무효로 판정한다.',
  scheduledOpenAt: '2026-09-01T00:00:00.000Z',
  closeAt: at,
  scheduledAnnouncementAt: '2026-12-30T06:30:00.000Z',
  scheduledJudgementAt: '2026-12-31T01:00:00.000Z',
  judgementTimeZone: 'Asia/Seoul',
};
const versionOne = {
  version: 1,
  createdAt: at,
  changedItems: [],
  reason: null,
  content: ruleContent,
};
const { title: _title, closeAt: _closeAt, ...ruleAndTimeItems } = ruleContent;
const market = {
  ...summary,
  ...ruleAndTimeItems,
  tags: ['코스피', 'S&P500'],
  resolvedAt: null,
  settledAt: null,
  ruleVersion: 1,
  ruleVersions: [versionOne],
};
const event = {
  id: '1',
  type: 'opened',
  actorId: 'admin-1',
  fromStatus: 'draft',
  toStatus: 'open',
  payload: null,
  createdAt: at,
};
const order = {
  id: marketId,
  marketId,
  marketSlug: summary.slug,
  marketTitle: summary.title,
  outcome: 'YES',
  side: 'buy',
  type: 'market',
  qty: 10,
  filledQty: 10,
  status: 'filled',
  amountCoin: '520',
  priceAvgBp: 5200,
  createdAt: at,
};
const fill = {
  id: '7',
  outcome: 'YES',
  side: 'buy',
  qty: 10,
  amountCoin: '520',
  priceAvgBp: 5200,
  createdAt: at,
};
const position = {
  marketId,
  marketSlug: summary.slug,
  marketTitle: summary.title,
  marketStatus: 'open',
  marketLastPrice: 52,
  resolvedResult: null,
  outcome: 'YES',
  qty: 10,
  costBasisCoin: '520',
  realizedPnlCoin: '0',
  settled: false,
  version: 1,
  updatedAt: at,
};

describe('read DTOs', () => {
  it('parse the shapes the API maps rows into', () => {
    expect(
      categorySchema.parse({
        id: 1,
        slug: 'economy',
        nameKo: '경제',
        sortOrder: 10,
        parentId: null,
      }),
    ).toEqual({ id: 1, slug: 'economy', nameKo: '경제', sortOrder: 10, parentId: null });
    // A sub-category names its parent; the field is required, never defaulted, so a row that
    // forgot it fails loudly rather than being filed at the top level.
    expect(
      categorySchema.parse({ id: 2, slug: 'housing', nameKo: '주택', sortOrder: 10, parentId: 1 })
        .parentId,
    ).toBe(1);
    expect(
      categorySchema.safeParse({ id: 2, slug: 'housing', nameKo: '주택', sortOrder: 10 }).success,
    ).toBe(false);
    expect(marketSummarySchema.parse(summary)).toEqual(summary);
    expect(marketSchema.parse(market)).toEqual(market);
    expect(orderSchema.parse(order)).toEqual(order);
    expect(fillSchema.parse(fill)).toEqual(fill);
    expect(positionSchema.parse(position)).toEqual(position);
    expect(priceTickSchema.parse({ ts: at, pYesBp: 5250, trigger: 'trade' })).toEqual({
      ts: at,
      pYesBp: 5250,
      trigger: 'trade',
    });
    expect(marketEventSchema.parse(event)).toEqual(event);
  });

  it('show a market with no fill yet as a null price, never a made-up one (N02 §5)', () => {
    // No AMM state any more (#125): before its first fill a market has no price to show.
    const untraded = {
      ...summary,
      lastPrice: null,
      volumeCoin: '0',
      tradeCount: 0,
      traderCount: 0,
    };
    expect(marketSummarySchema.parse(untraded).lastPrice).toBeNull();
    expect(marketSchema.parse({ ...market, lastPrice: null }).lastPrice).toBeNull();
    expect(positionSchema.parse({ ...position, marketLastPrice: null }).marketLastPrice).toBeNull();
    // The field stays required, so a mapper that forgot it fails instead of reading as untraded.
    const { lastPrice: _price, ...withoutPrice } = summary;
    expect(marketSummarySchema.safeParse(withoutPrice).success).toBe(false);
    // The AMM probability and the slippage guards are gone from the shapes.
    expect(marketSummarySchema.parse({ ...summary, pYesBp: 5250 })).not.toHaveProperty('pYesBp');
    expect(orderSchema.parse({ ...order, maxCostCoin: '600' })).not.toHaveProperty('maxCostCoin');
  });

  it('keep the author and exposure out of the public shape but in the admin one', () => {
    const admin = {
      ...market,
      createdBy: 'admin-1',
      updatedAt: at,
      netCollectedCoin: '520',
      openInterest: { yes: 10, no: 0 },
      settlementSteps: [
        {
          step: 'coin',
          status: 'failed',
          attempts: 2,
          completedAt: null,
          lastError: 'Balance not found for account u-1',
          updatedAt: at,
        },
      ],
      events: [event],
      missingOpenItems: [],
      leadCloseGapMinutes: 60,
      review: {
        pending: null,
        createdBy: { id: 'admin-1', nickname: '운영자1' },
        editors: [],
        sameCondition: [],
        log: [],
      },
      ruleVersions: [
        {
          ...versionOne,
          approvalId: null,
          requestedBy: null,
          createdBy: null,
          settlementImpact: null,
        },
      ],
      supplement: { pending: null, log: [] },
      pause: { history: [], pending: null, log: [] },
      judgementVersion: null,
      disputeDeadline: null,
      judgement: { current: null, pending: null, log: [], disputeWindowUndecided: true },
    };
    expect(adminMarketSchema.parse(admin)).toEqual(admin);
    // So is the judgement (#152): the version, the deadline and the registrations are the admin's,
    // in every status; the public shape keeps the status and the result alone.
    for (const field of ['judgement', 'judgementVersion', 'disputeDeadline'] as const) {
      expect(marketSchema.parse(admin)).not.toHaveProperty(field);
      const { [field]: _gone, ...without } = admin;
      expect(issuePaths(adminMarketSchema.safeParse(without)), field).toEqual([field]);
    }
    const provisional = {
      ...admin,
      status: 'provisional',
      resolvedResult: 'VOID',
      judgementVersion: 1,
      disputeDeadline: '2026-09-06T00:00:00.000Z',
    };
    expect(adminMarketSchema.parse(provisional)).toEqual(provisional);
    expect(marketSchema.parse(provisional).resolvedResult).toBe('VOID');
    for (const judgementVersion of [0, 1.5, '1']) {
      expect(
        issuePaths(adminMarketSchema.safeParse({ ...provisional, judgementVersion })),
        String(judgementVersion),
      ).toEqual(['judgementVersion']);
    }
    // So is the pause (#114): the public shape carries none of it, the admin one always.
    expect(marketSchema.parse(admin)).not.toHaveProperty('pause');
    const { pause: _pause, ...withoutPause } = admin;
    expect(issuePaths(adminMarketSchema.safeParse(withoutPause))).toEqual(['pause']);
    const paused = {
      ...admin,
      status: 'paused',
      pause: {
        history: [
          {
            id: marketId,
            reason: 'early_result',
            note: '발표가 마감 전에 나왔다.',
            resultPublishedAt: at,
            pausedAt: at,
            pausedBy: { id: 'admin-1', nickname: '운영자1' },
            reviewResult: null,
            endKind: null,
            endedAt: null,
            endedBy: null,
          },
        ],
        pending: null,
        log: [],
      },
    };
    expect(adminMarketSchema.parse(paused)).toEqual(paused);
    expect(marketSchema.parse(paused)).not.toHaveProperty('pause');
    // The review (#78) is the admin's, in every status, and never optional.
    expect(marketSchema.parse(admin)).not.toHaveProperty('review');
    const { review: _review, ...withoutReview } = admin;
    expect(adminMarketSchema.safeParse(withoutReview).success).toBe(false);
    // So is the supplement (#80), and its versions name who asked and who made them.
    expect(marketSchema.parse(admin)).not.toHaveProperty('supplement');
    const { supplement: _supplement, ...withoutSupplement } = admin;
    expect(adminMarketSchema.safeParse(withoutSupplement).success).toBe(false);
    expect(
      issuePaths(adminMarketSchema.safeParse({ ...admin, ruleVersions: [versionOne] })),
    ).toEqual([
      'ruleVersions.0.approvalId',
      'ruleVersions.0.requestedBy',
      'ruleVersions.0.createdBy',
      'ruleVersions.0.settlementImpact',
    ]);
    expect(marketSchema.parse(admin).ruleVersions).toEqual([versionOne]);
    expect(
      adminMarketSchema.safeParse({ ...admin, missingOpenItems: ['tags', 'deadline'] }).success,
    ).toBe(false);
    expect(marketSchema.parse(admin)).not.toHaveProperty('netCollectedCoin');
    // The rule items are in the open-items check's list (#23); the old single item is not.
    expect(
      adminMarketSchema.parse({ ...admin, missingOpenItems: ['title', 'eventDeadline', 'tags'] })
        .missingOpenItems,
    ).toEqual(['title', 'eventDeadline', 'tags']);
    expect(adminMarketSchema.safeParse({ ...admin, missingOpenItems: ['rules'] }).success).toBe(
      false,
    );
    // #22's items, the relation items among them; the announcement is no open item.
    expect(
      adminMarketSchema.parse({
        ...admin,
        missingOpenItems: ['scheduledOpenAt', 'judgementTimeZone', 'timeOrder', 'leadClose'],
      }).missingOpenItems,
    ).toEqual(['scheduledOpenAt', 'judgementTimeZone', 'timeOrder', 'leadClose']);
    expect(
      adminMarketSchema.safeParse({ ...admin, missingOpenItems: ['scheduledAnnouncementAt'] })
        .success,
    ).toBe(false);
    // The lead-close gap the check used: whole minutes from 0, or null while undecided (#22).
    for (const leadCloseGapMinutes of [0, 60, null]) {
      expect(adminMarketSchema.parse({ ...admin, leadCloseGapMinutes }).leadCloseGapMinutes).toBe(
        leadCloseGapMinutes,
      );
    }
    for (const leadCloseGapMinutes of [-1, 1.5, '60', undefined]) {
      expect(
        adminMarketSchema.safeParse({ ...admin, leadCloseGapMinutes }).success,
        String(leadCloseGapMinutes),
      ).toBe(false);
    }
    expect(marketSchema.parse(admin)).not.toHaveProperty('leadCloseGapMinutes');
    expect(adminMarketSchema.safeParse(market).success).toBe(false);
    // No LMSR state on the admin shape either (#125).
    expect(
      adminMarketSchema.parse({ ...admin, qYes: '0.0000000000', reserveCoin: '69315' }),
    ).not.toHaveProperty('reserveCoin');
    // The dispute stage is gone (ADR-0046): no deadline on the public shape, no counts on the
    // admin one, and a step must be one of SETTLEMENT_STEPS.
    expect(marketSchema.parse({ ...market, disputeUntil: at })).not.toHaveProperty('disputeUntil');
    expect(adminMarketSchema.parse(admin)).not.toHaveProperty('disputeCounts');
    const [step] = admin.settlementSteps;
    expect(
      adminMarketSchema.safeParse({ ...admin, settlementSteps: [{ ...step, step: 'score' }] })
        .success,
    ).toBe(false);
  });

  it('bound prices and basis points', () => {
    expect(marketSummarySchema.safeParse({ ...summary, lastPrice: 0 }).success).toBe(false);
    expect(marketSummarySchema.safeParse({ ...summary, lastPrice: 100 }).success).toBe(false);
    expect(marketSummarySchema.safeParse({ ...summary, volumeCoin: '1.5' }).success).toBe(false);
    expect(fillSchema.safeParse({ ...fill, userId: 'u' }).success).toBe(true); // stripped
    expect(fillSchema.parse({ ...fill, userId: 'u' })).not.toHaveProperty('userId');
  });

  it('carry no card sparkline on any market shape (ADR-0062)', () => {
    // The card draws no price trend (ADR-0061 decision 1, item 4), so the list row is the
    // summary itself: a stray `sparkline` is stripped like any other unknown key.
    expect(marketSummarySchema.parse({ ...summary, sparkline: [5250] })).toEqual(summary);
    expect(marketSchema.parse({ ...market, sparkline: [5250] })).not.toHaveProperty('sparkline');
  });

  it('carry the rule items on the detail and none of them on a card (#23)', () => {
    // The single rules text and the free-text source are gone, stripped like any unknown key.
    const parsed = marketSchema.parse({ ...market, rules: '종가 기준', resolutionSource: 'KRX' });
    expect(parsed).toEqual(market);
    expect(parsed).not.toHaveProperty('rules');
    expect(parsed).not.toHaveProperty('resolutionSource');
    // A market opened before #23: every item blank.
    const older = {
      ...market,
      description: null,
      yesCondition: '',
      noCondition: '',
      eventDeadline: null,
      primarySource: null,
      fallbackSources: [],
      fallbackCondition: '',
      longDelayDays: null,
      delayHandling: '',
    };
    expect(marketSchema.parse(older)).toEqual(older);
    const { yesCondition: _yes, ...withoutYes } = market;
    expect(marketSchema.safeParse(withoutYes).success).toBe(false);
    const card = marketSummarySchema.parse(market);
    for (const key of ['description', 'yesCondition', 'primarySource', 'fallbackSources']) {
      expect(card).not.toHaveProperty(key);
    }
  });

  it('carry the times and the judgement time zone on the detail and none on a card (#22)', () => {
    // The close is the summary's; the four others are the detail's, each null while not filled in.
    expect(TIME_ITEMS.filter((item) => item in marketSchema.shape)).toEqual([...TIME_ITEMS]);
    const card = marketSummarySchema.parse(market);
    expect(TIME_ITEMS.filter((item) => item in card)).toEqual(['closeAt']);
    // A market opened before #22: every new time null, the zone too.
    const older = {
      ...market,
      scheduledOpenAt: null,
      scheduledAnnouncementAt: null,
      scheduledJudgementAt: null,
      judgementTimeZone: null,
    };
    expect(marketSchema.parse(older)).toEqual(older);
    const { scheduledJudgementAt: _judgement, ...withoutJudgement } = market;
    expect(marketSchema.safeParse(withoutJudgement).success).toBe(false);
    // An instant before the storage bound is no market's (ADR-0097); a read zone is not checked.
    expect(
      marketSchema.safeParse({ ...market, scheduledOpenAt: '0099-12-31T23:59:59.999Z' }).success,
    ).toBe(false);
    expect(marketSchema.parse({ ...market, judgementTimeZone: 'Mars/Olympus' })).toEqual({
      ...market,
      judgementTimeZone: 'Mars/Olympus',
    });
  });

  it('say on the card and the detail whether the judgement is delayed (#22, #173 item 11)', () => {
    // '판정 지연' is a display the server works out at the read, so a card needs no time for it.
    expect(
      marketSummarySchema.parse({ ...summary, status: 'closed', judgementDelayed: true }),
    ).toEqual({ ...summary, status: 'closed', judgementDelayed: true });
    expect(marketSchema.parse({ ...market, judgementDelayed: true }).judgementDelayed).toBe(true);
    const { judgementDelayed: _delayed, ...withoutDelay } = summary;
    expect(marketSummarySchema.safeParse(withoutDelay).success).toBe(false);
    expect(marketSummarySchema.safeParse({ ...summary, judgementDelayed: 'yes' }).success).toBe(
      false,
    );
    expect(findExcludedIdentifier('judgementDelayed', 'api')).toEqual([]);
  });

  it('carry the current rule version and every version on the detail, nobody on them (#80)', () => {
    // Before the open, and on a market opened before #80 (D4): no version, an empty history.
    const unversioned = { ...market, ruleVersion: null, ruleVersions: [] };
    expect(marketSchema.parse(unversioned)).toEqual(unversioned);
    // A supplement made v2: the newest first, with the items it changed and its reason.
    const versionTwo = {
      version: 2,
      createdAt: '2026-10-01T00:00:00.000Z',
      changedItems: ['description', 'closeAt'],
      reason: '배경을 보충한다',
      content: { ...ruleContent, description: '코스피 지수', closeAt: '2026-12-29T06:00:00.000Z' },
    };
    const supplemented = { ...market, ruleVersion: 2, ruleVersions: [versionTwo, versionOne] };
    expect(marketSchema.parse(supplemented)).toEqual(supplemented);
    // Both are required, never defaulted, and a version counts from 1.
    const { ruleVersion: _version, ...withoutVersion } = market;
    expect(marketSchema.safeParse(withoutVersion).success).toBe(false);
    const { ruleVersions: _versions, ...withoutVersions } = market;
    expect(marketSchema.safeParse(withoutVersions).success).toBe(false);
    for (const ruleVersion of [0, 1.5, '1']) {
      expect(marketSchema.safeParse({ ...market, ruleVersion }).success).toBe(false);
    }
    // A changed item is a version item; the category is none.
    expect(
      issuePaths(
        marketSchema.safeParse({
          ...market,
          ruleVersions: [{ ...versionTwo, changedItems: ['category'] }],
        }),
      ),
    ).toEqual(['ruleVersions.0.changedItems.0']);
    // The public reads nobody's name and no 정산 영향 검토 (#172 item 15, #173 item 13).
    const adminVersion = {
      ...versionTwo,
      approvalId: marketId,
      requestedBy: { id: 'admin-1', nickname: '운영자1' },
      createdBy: { id: 'admin-2', nickname: '운영자2' },
      settlementImpact: '체결과 판정에 영향 없음',
    };
    expect(marketSchema.parse({ ...market, ruleVersions: [adminVersion] }).ruleVersions).toEqual([
      versionTwo,
    ]);
    // A card carries neither.
    const card = marketSummarySchema.parse(supplemented);
    expect(card).not.toHaveProperty('ruleVersion');
    expect(card).not.toHaveProperty('ruleVersions');
    for (const name of ['ruleVersion', 'ruleVersions', 'changedItems', 'content']) {
      expect(findExcludedIdentifier(name, 'api')).toEqual([]);
    }
  });

  it('describe a price series by the stride and the window the server served', () => {
    const point = { ts: at, pYesBp: 5250, trigger: 'trade' };
    const series = {
      resolution: '1h',
      bucketSeconds: 3_600,
      from: at,
      to: '2026-09-05T04:00:00.000Z',
      truncated: false,
      tradeCount: 3,
      points: [point],
    };
    expect(priceSeriesSchema.parse(series)).toEqual(series);
    // Required, and the ordering key a client compares an event against — `to` cannot serve as
    // one, because a tick's `ts` is fixed before its row commits.
    expect(priceSeriesSchema.safeParse({ ...series, tradeCount: undefined }).success).toBe(false);
    expect(priceSeriesSchema.safeParse({ ...series, tradeCount: -1 }).success).toBe(false);
    expect(priceSeriesSchema.safeParse({ ...series, tradeCount: 1.5 }).success).toBe(false);
    expect(priceSeriesSchema.parse({ ...series, tradeCount: 0 }).tradeCount).toBe(0);
    expect(priceSeriesSchema.parse({ ...series, resolution: 'raw', bucketSeconds: 0 })).toEqual({
      ...series,
      resolution: 'raw',
      bucketSeconds: 0,
    });
    expect(
      priceSeriesSchema.safeParse({
        ...series,
        points: Array.from({ length: TICKS_MAX_POINTS + 1 }, () => point),
      }).success,
    ).toBe(false);
    expect(priceSeriesSchema.safeParse({ ...series, bucketSeconds: -1 }).success).toBe(false);
    expect(priceSeriesSchema.safeParse({ ...series, bucketSeconds: 1.5 }).success).toBe(false);
    expect(priceSeriesSchema.safeParse({ ...series, from: 'yesterday' }).success).toBe(false);
    expect(priceSeriesSchema.safeParse({ ...series, to: '2026-09-05' }).success).toBe(false);
    expect(priceSeriesSchema.safeParse({ ...series, resolution: '5m' }).success).toBe(false);
  });
});

// ---- list queries --------------------------------------------------------------------
describe('marketListQuerySchema', () => {
  it('defaults to open markets by 추천 and coerces the page size', () => {
    expect(marketListQuerySchema.parse({})).toEqual({
      limit: 20,
      status: 'open',
      sort: 'recommended',
    });
    expect(
      marketListQuerySchema.parse({
        category: 'weather',
        status: 'closed',
        sort: 'closing',
        q: ' 비 ',
        limit: '5',
        cursor: 'abc',
      }),
    ).toEqual({
      category: 'weather',
      status: 'closed',
      sort: 'closing',
      q: '비',
      limit: 5,
      cursor: 'abc',
    });
  });

  it('takes every public status, or all of them at once for the search screen (ADR-0066)', () => {
    // ADR-0061 decision 1, item 13: the search starts on every public status; the home asks for
    // `open`, which stays the default for every caller written before search.
    expect(ALL_MARKET_STATUSES).toBe('all');
    expect(MARKET_LIST_STATUSES).toEqual([...PUBLIC_MARKET_STATUSES, 'all']);
    for (const status of MARKET_LIST_STATUSES) {
      expect(marketListQuerySchema.parse({ status }).status).toBe(status);
    }
    expect(marketListQuerySchema.parse({}).status).toBe('open');
    expect(findExcludedIdentifier(ALL_MARKET_STATUSES, 'api')).toEqual([]);
  });

  it('never lists a DRAFT or REVIEW market and only knows the three sorts', () => {
    // ADR-0093 decision 1 item 12: the two are the admin's alone; every other status is public,
    // a SCHEDULED market's before it opens and a CANCELLED one's included.
    expect(PUBLIC_MARKET_STATUSES).toEqual([
      'scheduled',
      'open',
      'paused',
      'closed',
      'provisional',
      'resolved',
      'settling',
      'settled',
      'cancelled',
    ]);
    for (const hidden of ['draft', 'review'] as const) {
      expect(isPublicMarketStatus(hidden)).toBe(false);
      expect(marketListQuerySchema.safeParse({ status: hidden }).success).toBe(false);
    }
    for (const status of PUBLIC_MARKET_STATUSES) expect(isPublicMarketStatus(status)).toBe(true);
    expect(marketListQuerySchema.safeParse({ status: 'voided' }).success).toBe(false);
    expect(marketListQuerySchema.safeParse({ sort: 'price' }).success).toBe(false);
    // The volume order is gone until #132 brings it back with its exclusions (ADR-0061 decision
    // 1, item 11): no URL can ask for it.
    expect(marketListQuerySchema.safeParse({ sort: 'volume' }).success).toBe(false);
    expect(marketListQuerySchema.safeParse({ q: '' }).success).toBe(false);
    expect(marketListQuerySchema.safeParse({ q: 'x'.repeat(101) }).success).toBe(false);
    for (const sort of MARKET_SORTS) expect(marketListQuerySchema.parse({ sort }).sort).toBe(sort);
  });

  it('lists 추천 · 신규 · 마감 임박 in that order, 추천 first and the default (ADR-0065)', () => {
    expect(MARKET_SORTS).toEqual(['recommended', 'newest', 'closing']);
    expect(DEFAULT_MARKET_SORT).toBe('recommended');
    expect(RECOMMENDED_VOLUME_HOURS).toBe(24);
    // The names are API identifiers: none may name an excluded feature (no rank or score).
    for (const sort of MARKET_SORTS) expect(findExcludedIdentifier(sort, 'api')).toEqual([]);
  });

  it('admin list takes any status, draft included, or none', () => {
    expect(adminMarketListQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(adminMarketListQuerySchema.parse({ status: 'draft' }).status).toBe('draft');
    expect(adminMarketListQuerySchema.safeParse({ status: 'archived' }).success).toBe(false);
  });

  it('positions filter by open/settled or not at all', () => {
    expect(positionsQuerySchema.parse({})).toEqual({});
    expect(positionsQuerySchema.parse({ status: 'settled' })).toEqual({ status: 'settled' });
    expect(positionsQuerySchema.safeParse({ status: 'closed' }).success).toBe(false);
  });

  it('ticks default to raw and refuse an inverted window', () => {
    expect(ticksQuerySchema.parse({})).toEqual({ resolution: 'raw' });
    expect(ticksQuerySchema.parse({ from: at, to: at, resolution: '1h' })).toEqual({
      from: at,
      to: at,
      resolution: '1h',
    });
    const inverted = ticksQuerySchema.safeParse({ from: '2026-09-06T00:00:00Z', to: at });
    expect(inverted.success).toBe(false);
    expect(issuePaths(inverted)).toEqual(['from']);
    // Instants compare, not strings: same moment at different precision, and a later `to`
    // that sorts lexicographically before `from` ('Z' > '.').
    expect(
      ticksQuerySchema.safeParse({ from: '2026-09-05T00:00:00Z', to: '2026-09-05T00:00:00.000Z' })
        .success,
    ).toBe(true);
    expect(
      ticksQuerySchema.safeParse({ from: '2026-09-05T00:00:00Z', to: '2026-09-05T00:00:00.500Z' })
        .success,
    ).toBe(true);
    expect(
      ticksQuerySchema.safeParse({ from: '2026-09-05T00:00:00.500Z', to: '2026-09-05T00:00:00Z' })
        .success,
    ).toBe(false);
    expect(ticksQuerySchema.safeParse({ from: 'yesterday' }).success).toBe(false);
    expect(ticksQuerySchema.safeParse({ resolution: '5m' }).success).toBe(false);
  });
});

// ---- admin bodies --------------------------------------------------------------------
/** The admin on screen, which every admin write names (ADR-0092). */
const account = { expectedAccountId: 'admin-1' } as const;

describe('createMarketBodySchema', () => {
  const body = {
    title: ' 2026년 안에 코스피 3000? ',
    categoryId: 1,
    closeAt: at,
    ...account,
  };

  it('accepts the minimal draft and trims the title', () => {
    // Every rule item is optional (#23): a draft starts from a title, a category and a close time.
    expect(createMarketBodySchema.parse(body)).toEqual({
      ...body,
      title: '2026년 안에 코스피 3000?',
    });
    const full = createMarketBodySchema.parse({
      ...body,
      imageUrl: 'https://cdn.example.com/a.png',
      slug: 'kospi-3000',
    });
    expect(full.slug).toBe('kospi-3000');
    // No initial probability or liquidity any more (#125): a market is created without them.
    expect(
      createMarketBodySchema.parse({ ...body, initialProbBp: 5000, liquidityB: 1000 }),
    ).toEqual({ ...body, title: '2026년 안에 코스피 3000?' });
  });

  it("takes the fields in the form's order, the version items among them (#80)", () => {
    // The title, the rule items and the times come from market-fields.ts, which a supplement's
    // changes share; the order is the form's, the category, tags and image between them.
    const fields = [
      'title',
      'description',
      'yesCondition',
      'noCondition',
      'eventDeadline',
      'primarySource',
      'fallbackSources',
      'fallbackCondition',
      'longDelayDays',
      'delayHandling',
      'categoryId',
      'tags',
      'imageUrl',
      'scheduledOpenAt',
      'closeAt',
      'scheduledAnnouncementAt',
      'scheduledJudgementAt',
      'judgementTimeZone',
      'slug',
    ];
    expect(Object.keys(createMarketBodySchema.shape)).toEqual([...fields, 'expectedAccountId']);
    expect(Object.keys(updateMarketBodySchema.shape)).toEqual([...fields, 'expectedAccountId']);
  });

  it('accepts the largest category id a serial column can hold', () => {
    const parsed = createMarketBodySchema.parse({ ...body, categoryId: INT4_MAX });
    expect(parsed.categoryId).toBe(INT4_MAX);
    expect(updateMarketBodySchema.safeParse({ categoryId: INT4_MAX, ...account }).success).toBe(
      true,
    );
    expect(updateMarketBodySchema.safeParse({ categoryId: INT4_MAX + 1, ...account }).success).toBe(
      false,
    );
  });

  it('refuses bad fields', () => {
    for (const patch of [
      { title: '' },
      { title: 'x'.repeat(121) },
      { categoryId: 0 },
      { categoryId: 1.5 },
      // int4: without the cap this reaches Postgres as an out-of-range parameter (500).
      { categoryId: INT4_MAX + 1 },
      { closeAt: 'tomorrow' },
      { imageUrl: 'javascript:alert(1)' },
      { imageUrl: 'ftp://example.com/a.png' },
      { imageUrl: 'not a url' },
      { imageUrl: `https://example.com/${'a'.repeat(500)}` },
      { slug: 'ab' },
      { slug: 'Has-Upper' },
      { slug: 'with space' },
      { slug: marketId },
    ]) {
      expect(
        createMarketBodySchema.safeParse({ ...body, ...patch }).success,
        JSON.stringify(patch),
      ).toBe(false);
    }
  });

  it('requires the admin on screen (ADR-0092)', () => {
    for (const expectedAccountId of [undefined, '', 'x'.repeat(256), 7]) {
      const parsed = createMarketBodySchema.safeParse({ ...body, expectedAccountId });
      expect(parsed.success, String(expectedAccountId)).toBe(false);
      expect(issuePaths(parsed)).toEqual(['expectedAccountId']);
    }
  });

  it('normalises a decomposed Korean slug to NFC and refuses uuid-shaped slugs', () => {
    const nfd = '코스피-3000'.normalize('NFD');
    expect(nfd).not.toBe('코스피-3000');
    expect(marketSlugSchema.parse(nfd)).toBe('코스피-3000');
    expect(createMarketBodySchema.parse({ ...body, slug: nfd }).slug).toBe('코스피-3000');
    const uuidShaped = createMarketBodySchema.safeParse({ ...body, slug: marketId });
    expect(uuidShaped.success).toBe(false);
    expect(issuePaths(uuidShaped)).toEqual(['slug']);
    expect(uuidShaped.error?.issues[0]?.message).toMatch(/uuid/);
    expect(marketSlugSchema.safeParse(marketId.toUpperCase()).success).toBe(false);
  });
});

describe('updateMarketBodySchema', () => {
  it('accepts any single field but not an empty patch', () => {
    expect(updateMarketBodySchema.parse({ yesCondition: '새 조건', ...account })).toEqual({
      yesCondition: '새 조건',
      ...account,
    });
    // The AMM inputs are stripped, so a patch of only them is an empty patch.
    expect(
      updateMarketBodySchema.safeParse({ liquidityB: 500, initialProbBp: 3000, ...account })
        .success,
    ).toBe(false);
    expect(updateMarketBodySchema.parse({ description: null, imageUrl: null, ...account })).toEqual(
      { description: null, imageUrl: null, ...account },
    );
    // The account is always there, so it is no field: a patch of it alone is empty.
    const empty = updateMarketBodySchema.safeParse({ ...account });
    expect(empty.success).toBe(false);
    expect(empty.error?.issues[0]?.message).toBe('at least one field is required');
    expect(updateMarketBodySchema.safeParse({ title: undefined, ...account }).success).toBe(false);
    expect(updateMarketBodySchema.safeParse({ slug: marketId, ...account }).success).toBe(false);
    expect(updateMarketBodySchema.safeParse({ closeAt: 'soon', ...account }).success).toBe(false);
  });

  it('requires the admin on screen (ADR-0092)', () => {
    const parsed = updateMarketBodySchema.safeParse({ yesCondition: '새 조건' });
    expect(parsed.success).toBe(false);
    expect(issuePaths(parsed)).toEqual(['expectedAccountId']);
  });
});

describe('the rule items of the create and update bodies (#23)', () => {
  const body = { title: '2026년 안에 코스피 3000?', categoryId: 1, closeAt: at, ...account };
  const source = { name: '한국거래소 보도자료', url: 'https://www.krx.co.kr' };
  const items = {
    description: ' 코스피가 연말에 3000을 넘는지 묻는다. ',
    yesCondition: ' 12월 30일 종가가 3000 이상이면 YES. ',
    noCondition: '\n사건 기한까지 3000 이상으로 마감하지 않으면 NO.\n',
    eventDeadline: '2026-12-30T06:30:00.000Z',
    primarySource: { name: ' 한국거래소 ', url: ' https://data.krx.co.kr ' },
    fallbackSources: [source, { name: '연합뉴스', url: '' }],
    fallbackCondition: ' 1차 출처에 종가가 없으면 대체 출처를 본다. ',
    longDelayDays: 14,
    delayHandling: ' 장기 지연 기한까지 종가가 나오지 않으면 무효로 판정한다. ',
  };

  it('takes every item, each text trimmed', () => {
    const trimmed = {
      description: '코스피가 연말에 3000을 넘는지 묻는다.',
      yesCondition: '12월 30일 종가가 3000 이상이면 YES.',
      noCondition: '사건 기한까지 3000 이상으로 마감하지 않으면 NO.',
      eventDeadline: '2026-12-30T06:30:00.000Z',
      primarySource: { name: '한국거래소', url: 'https://data.krx.co.kr' },
      fallbackSources: [source, { name: '연합뉴스', url: '' }],
      fallbackCondition: '1차 출처에 종가가 없으면 대체 출처를 본다.',
      longDelayDays: 14,
      delayHandling: '장기 지연 기한까지 종가가 나오지 않으면 무효로 판정한다.',
    };
    expect(createMarketBodySchema.parse({ ...body, ...items })).toEqual({ ...body, ...trimmed });
    expect(updateMarketBodySchema.parse({ ...items, ...account })).toEqual({
      ...trimmed,
      ...account,
    });
    // The old fields are gone: stripped like any unknown key.
    const old = createMarketBodySchema.parse({
      ...body,
      rules: '종가 기준',
      resolutionSource: 'KRX',
    });
    expect(old).not.toHaveProperty('rules');
    expect(old).not.toHaveProperty('resolutionSource');
  });

  it('clears a nullable item with null and replaces the fallbacks as a whole', () => {
    const cleared = {
      description: null,
      eventDeadline: null,
      primarySource: null,
      longDelayDays: null,
      ...account,
    };
    expect(updateMarketBodySchema.parse(cleared)).toEqual(cleared);
    // What the web sends when the last fallback goes: both together.
    expect(
      updateMarketBodySchema.parse({ fallbackSources: [], fallbackCondition: '', ...account }),
    ).toEqual({ fallbackSources: [], fallbackCondition: '', ...account });
    expect(
      updateMarketBodySchema.parse({ fallbackSources: [source, source, source], ...account })
        .fallbackSources,
    ).toHaveLength(3);
  });

  it('holds every text to 5,000 characters, counted after the trim', () => {
    for (const field of [
      'description',
      'yesCondition',
      'noCondition',
      'fallbackCondition',
      'delayHandling',
    ]) {
      const longest = 'x'.repeat(MARKET_TEXT_MAX);
      expect(createMarketBodySchema.safeParse({ ...body, [field]: longest }).success, field).toBe(
        true,
      );
      expect(
        createMarketBodySchema.safeParse({ ...body, [field]: ` ${longest}\n` }).success,
        field,
      ).toBe(true);
      const over = createMarketBodySchema.safeParse({ ...body, [field]: `${longest}x` });
      expect(issuePaths(over), field).toEqual([field]);
      expect(
        issuePaths(updateMarketBodySchema.safeParse({ [field]: `${longest}x`, ...account })),
      ).toEqual([field]);
    }
  });

  it('refuses a bad item naming its path, inside a source included', () => {
    for (const [patch, path] of [
      [{ primarySource: { name: '한국거래소', url: 'ftp://data.krx.co.kr' } }, 'primarySource.url'],
      [{ primarySource: { name: '한국거래소', url: 'javascript:alert(1)' } }, 'primarySource.url'],
      [{ primarySource: { name: '한국거래소', url: 'data.krx.co.kr' } }, 'primarySource.url'],
      [
        { primarySource: { name: '한국거래소', url: `https://a.kr/${'a'.repeat(488)}` } },
        'primarySource.url',
      ],
      [{ primarySource: { name: 'x'.repeat(501), url: '' } }, 'primarySource.name'],
      [{ primarySource: { name: ' ', url: '' } }, 'primarySource'],
      [
        { fallbackSources: [source, { name: '연합뉴스', url: 'www.yna.co.kr' }] },
        'fallbackSources.1.url',
      ],
      [{ fallbackSources: [source, { name: '', url: '' }] }, 'fallbackSources.1'],
      [{ fallbackSources: [source, source, source, source] }, 'fallbackSources'],
      [{ longDelayDays: 0 }, 'longDelayDays'],
      [{ longDelayDays: 366 }, 'longDelayDays'],
      [{ longDelayDays: 1.5 }, 'longDelayDays'],
      [{ longDelayDays: '14' }, 'longDelayDays'],
      [{ eventDeadline: '2026-12-30' }, 'eventDeadline'],
      [{ eventDeadline: '2026-12-30T15:30:00+09:00' }, 'eventDeadline'],
      [{ eventDeadline: 'tomorrow' }, 'eventDeadline'],
      // Year 0000 (Postgres refuses it) and any year below 100 (read back as another), ADR-0097.
      [{ eventDeadline: '0000-12-31T15:00:00Z' }, 'eventDeadline'],
      [{ eventDeadline: '0099-12-31T23:59:59.999Z' }, 'eventDeadline'],
      [{ yesCondition: null }, 'yesCondition'],
    ] as const) {
      const created = createMarketBodySchema.safeParse({ ...body, ...patch });
      expect(issuePaths(created), JSON.stringify(patch)).toEqual([path]);
      const updated = updateMarketBodySchema.safeParse({ ...patch, ...account });
      expect(issuePaths(updated), JSON.stringify(patch)).toEqual([path]);
    }
    const empty = createMarketBodySchema.safeParse({
      ...body,
      fallbackSources: [{ name: '', url: ' ' }],
    });
    expect(empty.error?.issues[0]?.message).toBe('empty source');
    expect(issuePaths(empty)).toEqual(['fallbackSources.0']);
  });

  it('takes an event deadline from STORABLE_INSTANT_MIN on, with no order against closeAt', () => {
    // Storage's bound only (ADR-0097). It has no order against the close (owner answer 2026-10-31
    // A1); its order against the scheduled judgement is the service's (#22), not the schema's.
    for (const eventDeadline of [STORABLE_INSTANT_MIN, '9999-12-31T23:59:59.999Z']) {
      expect(createMarketBodySchema.parse({ ...body, eventDeadline }).eventDeadline).toBe(
        eventDeadline,
      );
      expect(updateMarketBodySchema.parse({ eventDeadline, ...account }).eventDeadline).toBe(
        eventDeadline,
      );
    }
    const early = updateMarketBodySchema.safeParse({
      eventDeadline: '0000-12-31T15:00:00Z',
      ...account,
    });
    expect(early.error?.issues).toMatchObject([
      { path: ['eventDeadline'], message: STORABLE_INSTANT_TOO_EARLY },
    ]);
  });
});

describe('the time items of the create and update bodies (#22)', () => {
  const body = { title: '2026년 안에 코스피 3000?', categoryId: 1, closeAt: at, ...account };
  const times = {
    scheduledOpenAt: '2026-09-01T00:00:00.000Z',
    scheduledAnnouncementAt: '2026-12-30T06:30:00.000Z',
    scheduledJudgementAt: '2026-12-31T01:00:00.000Z',
    judgementTimeZone: 'Asia/Seoul',
  };

  it('takes each one optionally on a create, the close required, the zone trimmed', () => {
    expect(createMarketBodySchema.parse({ ...body, ...times })).toEqual({ ...body, ...times });
    expect(
      createMarketBodySchema.parse({ ...body, ...times, judgementTimeZone: ' America/New_York ' })
        .judgementTimeZone,
    ).toBe('America/New_York');
    // An alias is an IANA name too, and stored as given (ADR-0063).
    expect(
      createMarketBodySchema.parse({ ...body, judgementTimeZone: 'ROK' }).judgementTimeZone,
    ).toBe('ROK');
    // None sent: the draft starts without them (the minimal draft above).
    const parsed = createMarketBodySchema.parse(body);
    for (const item of TIME_ITEMS.filter((key) => key !== 'closeAt')) {
      expect(parsed, item).not.toHaveProperty(item);
    }
    const { closeAt: _close, ...withoutClose } = body;
    expect(issuePaths(createMarketBodySchema.safeParse(withoutClose))).toEqual(['closeAt']);
    // The order between them is the service's, on the stored values merged with the body.
    expect(
      createMarketBodySchema.safeParse({
        ...body,
        ...times,
        scheduledJudgementAt: STORABLE_INSTANT_MIN,
      }).success,
    ).toBe(true);
  });

  it('clears each one but the close with null; an announcement of null is 없음', () => {
    const cleared = {
      scheduledOpenAt: null,
      scheduledAnnouncementAt: null,
      scheduledJudgementAt: null,
      judgementTimeZone: null,
      ...account,
    };
    expect(updateMarketBodySchema.parse(cleared)).toEqual(cleared);
    expect(createMarketBodySchema.parse({ ...body, scheduledAnnouncementAt: null })).toEqual({
      ...body,
      scheduledAnnouncementAt: null,
    });
    expect(issuePaths(updateMarketBodySchema.safeParse({ closeAt: null, ...account }))).toEqual([
      'closeAt',
    ]);
    expect(updateMarketBodySchema.parse({ scheduledJudgementAt: at, ...account })).toEqual({
      scheduledJudgementAt: at,
      ...account,
    });
  });

  it('refuses a zone that is no IANA name: unknown, an offset, a case-only spelling, too long', () => {
    for (const judgementTimeZone of ['Mars/Olympus', '+09:00', 'asia/seoul', 'ASIA/SEOUL']) {
      for (const parsed of [
        createMarketBodySchema.safeParse({ ...body, judgementTimeZone }),
        updateMarketBodySchema.safeParse({ judgementTimeZone, ...account }),
      ]) {
        expect(parsed.error?.issues, judgementTimeZone).toMatchObject([
          { path: ['judgementTimeZone'], message: 'must be an IANA time zone name' },
        ]);
      }
    }
    for (const judgementTimeZone of ['', '  ', `Asia/${'X'.repeat(60)}`, 9]) {
      const parsed = createMarketBodySchema.safeParse({ ...body, judgementTimeZone });
      expect(parsed.success, String(judgementTimeZone)).toBe(false);
      expect(new Set(issuePaths(parsed))).toEqual(new Set(['judgementTimeZone']));
    }
  });

  it('holds every time, the close included, to an ISO instant from STORABLE_INSTANT_MIN on', () => {
    for (const field of [
      'scheduledOpenAt',
      'closeAt',
      'scheduledAnnouncementAt',
      'scheduledJudgementAt',
    ]) {
      for (const value of [STORABLE_INSTANT_MIN, '9999-12-31T23:59:59.999Z']) {
        expect(createMarketBodySchema.safeParse({ ...body, [field]: value }).success, field).toBe(
          true,
        );
        expect(
          updateMarketBodySchema.safeParse({ [field]: value, ...account }).success,
          field,
        ).toBe(true);
      }
      // Year 0000 (Postgres refuses it) and any year below 100 (read back as another), ADR-0097:
      // a close too, which before #22 only the future check refused.
      for (const value of ['0000-12-31T15:00:00Z', '0099-12-31T23:59:59.999Z']) {
        for (const parsed of [
          createMarketBodySchema.safeParse({ ...body, [field]: value }),
          updateMarketBodySchema.safeParse({ [field]: value, ...account }),
        ]) {
          expect(parsed.error?.issues, `${field} ${value}`).toMatchObject([
            { path: [field], message: STORABLE_INSTANT_TOO_EARLY },
          ]);
        }
      }
      for (const value of [
        '2026-12-30',
        '2026-12-30T15:30:00+09:00',
        'tomorrow',
        1_798_675_200_000,
      ]) {
        const parsed = createMarketBodySchema.safeParse({ ...body, [field]: value });
        expect(issuePaths(parsed), `${field} ${value}`).toEqual([field]);
      }
    }
  });
});

describe('statusEventId', () => {
  it('rides on every market shape and must be a string or null', () => {
    expect(marketSummarySchema.parse(summary).statusEventId).toBe('2');
    expect(marketSchema.parse({ ...market, statusEventId: null }).statusEventId).toBeNull();
    expect(marketSummarySchema.safeParse({ ...summary, statusEventId: 2 }).success).toBe(false);
    const { statusEventId: _key, ...withoutKey } = summary;
    expect(marketSummarySchema.safeParse(withoutKey).success).toBe(false);
  });
});

// ---- slugify -------------------------------------------------------------------------
describe('slugify', () => {
  it('sanitises Korean and ASCII titles into a slug stem', () => {
    expect(slugify('2026년 안에 코스피 3000?')).toBe('2026년-안에-코스피-3000');
    expect(slugify('  Hello,  World! ')).toBe('hello-world');
    expect(slugify('BTC > $100k (2026)')).toBe('btc-100k-2026');
    expect(slugify('한글'.normalize('NFD'))).toBe('한글');
    expect(slugify('🔥🔥🔥')).toBe('');
    expect(slugify('')).toBe('');
    expect(slugify('---a---')).toBe('a');
  });

  it('cuts to the stem length without a trailing dash', () => {
    expect(slugify('a'.repeat(100))).toHaveLength(MARKET_SLUG_STEM_MAX);
    expect(slugify(`${'a'.repeat(59)} bcd`)).toBe('a'.repeat(59));
    expect(slugify(`${'가'.repeat(60)} 나`)).toBe('가'.repeat(60));
  });

  it('always yields either nothing or a valid slug stem', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 200 }), (title) => {
        const stem = slugify(title);
        expect(stem.length).toBeLessThanOrEqual(MARKET_SLUG_STEM_MAX);
        if (stem !== '') {
          expect(stem).toMatch(/^[a-z0-9가-힣]([a-z0-9가-힣-]*[a-z0-9가-힣])?$/);
          expect(stem).not.toMatch(/--/);
          expect(stem.normalize('NFC')).toBe(stem);
          // With a 3+ character stem the server's `<stem>-<tag>` is a valid slug.
          expect(MARKET_SLUG_PATTERN.test(`${stem}-ab12`)).toBe(true);
        }
      }),
      { numRuns: 1000 },
    );
  });
});
