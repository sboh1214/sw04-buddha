import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  INT4_MAX,
  MARKET_SLUG_PATTERN,
  MARKET_SLUG_STEM_MAX,
  TICKS_MAX_POINTS,
} from './constants.js';
import {
  MARKET_SORTS,
  PUBLIC_MARKET_STATUSES,
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
  resolveMarketBodySchema,
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
const market = {
  ...summary,
  description: null,
  rules: '종가 기준',
  resolutionSource: 'KRX',
  resolvedAt: null,
  settledAt: null,
  voidedAt: null,
};
const event = { id: '1', type: 'opened', actorId: 'admin-1', payload: null, createdAt: at };
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
    };
    expect(adminMarketSchema.parse(admin)).toEqual(admin);
    expect(marketSchema.parse(admin)).not.toHaveProperty('netCollectedCoin');
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
  it('defaults to open markets by volume and coerces the page size', () => {
    expect(marketListQuerySchema.parse({})).toEqual({ limit: 20, status: 'open', sort: 'volume' });
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

  it('never lists drafts and only knows the three sorts', () => {
    expect(PUBLIC_MARKET_STATUSES).not.toContain('draft');
    expect(marketListQuerySchema.safeParse({ status: 'draft' }).success).toBe(false);
    expect(marketListQuerySchema.safeParse({ sort: 'price' }).success).toBe(false);
    expect(marketListQuerySchema.safeParse({ q: '' }).success).toBe(false);
    expect(marketListQuerySchema.safeParse({ q: 'x'.repeat(101) }).success).toBe(false);
    for (const sort of MARKET_SORTS) expect(marketListQuerySchema.parse({ sort }).sort).toBe(sort);
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
describe('createMarketBodySchema', () => {
  const body = {
    title: ' 2026년 안에 코스피 3000? ',
    rules: '',
    categoryId: 1,
    closeAt: at,
  };

  it('accepts the minimal draft and trims the title', () => {
    expect(createMarketBodySchema.parse(body)).toEqual({
      ...body,
      title: '2026년 안에 코스피 3000?',
    });
    const full = createMarketBodySchema.parse({
      ...body,
      description: 'd',
      resolutionSource: 'KRX ',
      imageUrl: 'https://cdn.example.com/a.png',
      slug: 'kospi-3000',
    });
    expect(full.resolutionSource).toBe('KRX');
    expect(full.slug).toBe('kospi-3000');
    // No initial probability or liquidity any more (#125): a market is created without them.
    expect(
      createMarketBodySchema.parse({ ...body, initialProbBp: 5000, liquidityB: 1000 }),
    ).toEqual({ ...body, title: '2026년 안에 코스피 3000?' });
  });

  it('accepts the largest category id a serial column can hold', () => {
    const parsed = createMarketBodySchema.parse({ ...body, categoryId: INT4_MAX });
    expect(parsed.categoryId).toBe(INT4_MAX);
    expect(updateMarketBodySchema.safeParse({ categoryId: INT4_MAX }).success).toBe(true);
    expect(updateMarketBodySchema.safeParse({ categoryId: INT4_MAX + 1 }).success).toBe(false);
  });

  it('refuses bad fields', () => {
    for (const patch of [
      { title: '' },
      { title: 'x'.repeat(121) },
      { rules: 'x'.repeat(5001) },
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
    expect(createMarketBodySchema.safeParse({ ...body, rules: undefined }).success).toBe(false);
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
    expect(updateMarketBodySchema.parse({ rules: '새 규칙' })).toEqual({ rules: '새 규칙' });
    // The AMM inputs are stripped, so a patch of only them is an empty patch.
    expect(updateMarketBodySchema.safeParse({ liquidityB: 500, initialProbBp: 3000 }).success).toBe(
      false,
    );
    expect(updateMarketBodySchema.parse({ description: null, imageUrl: null })).toEqual({
      description: null,
      imageUrl: null,
    });
    const empty = updateMarketBodySchema.safeParse({});
    expect(empty.success).toBe(false);
    expect(updateMarketBodySchema.safeParse({ title: undefined }).success).toBe(false);
    expect(updateMarketBodySchema.safeParse({ slug: marketId }).success).toBe(false);
    expect(updateMarketBodySchema.safeParse({ closeAt: 'soon' }).success).toBe(false);
  });
});

describe('resolveMarketBodySchema', () => {
  it('requires a result and accepts an optional note and http(s) evidence url', () => {
    expect(resolveMarketBodySchema.parse({ result: 'YES' })).toEqual({ result: 'YES' });
    expect(
      resolveMarketBodySchema.parse({
        result: 'NO',
        note: ' 발표 없음 ',
        evidenceUrl: 'https://www.bok.or.kr/press/1',
      }),
    ).toEqual({ result: 'NO', note: '발표 없음', evidenceUrl: 'https://www.bok.or.kr/press/1' });
    expect(resolveMarketBodySchema.parse({ result: 'YES', note: null, evidenceUrl: null })).toEqual(
      { result: 'YES', note: null, evidenceUrl: null },
    );
    for (const body of [
      {},
      { result: 'MAYBE' },
      { result: 'YES', note: 'x'.repeat(1001) },
      { result: 'YES', evidenceUrl: 'javascript:alert(1)' },
      { result: 'YES', evidenceUrl: `https://a.b/${'c'.repeat(500)}` },
    ]) {
      expect(resolveMarketBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
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
