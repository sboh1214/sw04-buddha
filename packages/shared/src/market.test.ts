import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  INT4_MAX,
  LIQUIDITY_B_MAX,
  MARKET_SLUG_PATTERN,
  MARKET_SLUG_STEM_MAX,
  MAX_P_AMOUNT,
  ORDER_QTY_MAX,
  SPARKLINE_MAX_POINTS,
  TICKS_MAX_POINTS,
} from './constants.js';
import {
  MARKET_SORTS,
  PUBLIC_MARKET_STATUSES,
  QUOTE_VALUE_MAX_LENGTH,
  adminMarketListQuerySchema,
  adminMarketSchema,
  categorySchema,
  createMarketBodySchema,
  fillSchema,
  marketEventSchema,
  marketListItemSchema,
  marketListQuerySchema,
  marketSchema,
  marketSlugSchema,
  marketSummarySchema,
  orderSchema,
  positionSchema,
  positionsQuerySchema,
  priceSeriesSchema,
  priceTickSchema,
  quoteBodySchema,
  quoteResultSchema,
  quoteValue,
  sameTradeTerms,
  slugify,
  ticksQuerySchema,
  tradeBodySchema,
  tradeResultSchema,
  tradeTerms,
  tradeTermsSchema,
  updateMarketBodySchema,
  voidMarketBodySchema,
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
  pYesBp: 5250,
  volumeP: '12345',
  tradeCount: 3,
  traderCount: 2,
  closeAt: at,
  openAt: at,
  resolvedResult: null,
  createdAt: at,
};
const market = {
  ...summary,
  description: null,
  rules: '종가 기준',
  resolutionSource: 'KRX',
  resolvedAt: null,
  disputeUntil: null,
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
  amountP: '520',
  priceAvgBp: 5200,
  maxCostP: '600',
  minProceedsP: null,
  createdAt: at,
};
const fill = {
  id: '7',
  outcome: 'YES',
  side: 'buy',
  qty: 10,
  amountP: '520',
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
  costBasisP: '520',
  realizedPnlP: '0',
  settled: false,
  version: 1,
  updatedAt: at,
};

describe('read DTOs', () => {
  it('parse the shapes the API maps rows into', () => {
    expect(categorySchema.parse({ id: 1, slug: 'economy', nameKo: '경제', sortOrder: 10 })).toEqual(
      {
        id: 1,
        slug: 'economy',
        nameKo: '경제',
        sortOrder: 10,
      },
    );
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
    expect(
      tradeResultSchema.parse({
        order,
        fill,
        balance: { availableP: '9480', lockedP: '0' },
        position,
        market: { id: marketId, lastPrice: 52, pYesBp: 5250, volumeP: '520', tradeCount: 1 },
      }).market.tradeCount,
    ).toBe(1);
    expect(
      quoteResultSchema.parse({
        shares: 0,
        amountP: '0',
        priceAvgBp: 5000,
        priceBeforeBp: 5000,
        priceAfterBp: 5000,
        maxPayoutP: '0',
      }).shares,
    ).toBe(0);
  });

  it('keep the LMSR internals out of the public shape but in the admin one', () => {
    const admin = {
      ...market,
      liquidityB: '1000.000000',
      qYes: '0.0000000000',
      qNo: '0.0000000000',
      initialProbBp: 5000,
      reserveP: '69315',
      createdBy: 'admin-1',
      updatedAt: at,
      netCollectedP: '520',
      openInterest: { yes: 10, no: 0 },
      events: [event],
    };
    expect(adminMarketSchema.parse(admin)).toEqual(admin);
    expect(marketSchema.parse(admin)).not.toHaveProperty('qYes');
    expect(adminMarketSchema.safeParse(market).success).toBe(false);
    expect(adminMarketSchema.safeParse({ ...admin, initialProbBp: 0 }).success).toBe(false);
  });

  it('bound prices and basis points', () => {
    expect(marketSummarySchema.safeParse({ ...summary, lastPrice: 0 }).success).toBe(false);
    expect(marketSummarySchema.safeParse({ ...summary, lastPrice: 100 }).success).toBe(false);
    expect(marketSummarySchema.safeParse({ ...summary, pYesBp: 10_001 }).success).toBe(false);
    expect(marketSummarySchema.safeParse({ ...summary, volumeP: '1.5' }).success).toBe(false);
    expect(fillSchema.safeParse({ ...fill, userId: 'u' }).success).toBe(true); // stripped
    expect(fillSchema.parse({ ...fill, userId: 'u' })).not.toHaveProperty('userId');
  });

  it('carry the card sparkline on the list item only, never on the shared summary', () => {
    const full = Array.from({ length: SPARKLINE_MAX_POINTS }, () => 5250);
    expect(marketListItemSchema.parse({ ...summary, sparkline: [] })).toEqual({
      ...summary,
      sparkline: [],
    });
    expect(marketListItemSchema.parse({ ...summary, sparkline: full }).sparkline).toHaveLength(
      SPARKLINE_MAX_POINTS,
    );
    expect(marketListItemSchema.safeParse({ ...summary, sparkline: [...full, 5250] }).success).toBe(
      false,
    );
    expect(marketListItemSchema.safeParse({ ...summary, sparkline: [10_001] }).success).toBe(false);
    // The shared component was not widened: GET /admin/markets and the embedded summaries ship
    // it too, so a summary without a sparkline still parses and one handed a sparkline strips it.
    expect(marketSummarySchema.safeParse(summary).success).toBe(true);
    expect(marketSummarySchema.parse({ ...summary, sparkline: full })).not.toHaveProperty(
      'sparkline',
    );
    expect(marketListItemSchema.safeParse(summary).success).toBe(false);
  });

  it('describe a price series by the stride and the window the server served', () => {
    const point = { ts: at, pYesBp: 5250, trigger: 'trade' };
    const series = {
      resolution: '1h',
      bucketSeconds: 3_600,
      from: at,
      to: '2026-09-05T04:00:00.000Z',
      truncated: false,
      points: [point],
    };
    expect(priceSeriesSchema.parse(series)).toEqual(series);
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

// ---- quotes --------------------------------------------------------------------------
describe('quoteBodySchema', () => {
  const base = { marketId, outcome: 'YES', side: 'buy' };

  it('accepts shares and spend modes and exposes the numeric value', () => {
    const shares = quoteBodySchema.parse({ ...base, mode: 'shares', value: '10' });
    expect(quoteValue(shares)).toEqual({ shares: 10 });
    const spend = quoteBodySchema.parse({ ...base, mode: 'spend', value: '1000' });
    expect(quoteValue(spend)).toEqual({ spendP: 1000n });
    expect(
      quoteBodySchema.parse({ ...base, mode: 'shares', value: String(ORDER_QTY_MAX) }).value,
    ).toBe(String(ORDER_QTY_MAX));
    expect(
      quoteBodySchema.parse({ ...base, mode: 'spend', value: MAX_P_AMOUNT.toString() }).value,
    ).toBe(MAX_P_AMOUNT.toString());
    expect(quoteBodySchema.parse({ ...base, side: 'sell', mode: 'shares', value: '3' }).side).toBe(
      'sell',
    );
  });

  it('refuses a spend quote on a sell, naming mode', () => {
    const result = quoteBodySchema.safeParse({
      ...base,
      side: 'sell',
      mode: 'spend',
      value: '1000',
    });
    expect(result.success).toBe(false);
    expect(issuePaths(result)).toEqual(['mode']);
  });

  it('bounds value to the digits of MAX_P_AMOUNT before the range refine parses it', () => {
    // The route is public: a body-sized run of digits must be refused for its length, never
    // handed to BigInt(). The longest valid value is MAX_P_AMOUNT itself.
    expect(QUOTE_VALUE_MAX_LENGTH).toBe(MAX_P_AMOUNT.toString().length);
    for (const value of [`1${MAX_P_AMOUNT.toString()}`, '7'.repeat(200_000)]) {
      const result = quoteBodySchema.safeParse({ ...base, mode: 'spend', value });
      expect(result.success).toBe(false);
      expect(issuePaths(result)).toEqual(['value']);
      expect(result.error?.issues[0]?.code).toBe('too_big');
    }
  });

  it('refuses a value outside the mode range, naming value', () => {
    for (const body of [
      { mode: 'shares', value: '0' },
      { mode: 'shares', value: String(ORDER_QTY_MAX + 1) },
      { mode: 'spend', value: '0' },
      { mode: 'spend', value: (MAX_P_AMOUNT + 1n).toString() },
    ]) {
      const result = quoteBodySchema.safeParse({ ...base, ...body });
      expect(result.success, JSON.stringify(body)).toBe(false);
      expect(issuePaths(result)).toEqual(['value']);
    }
    for (const value of ['', '-1', '1.5', '01', '1e3', 10]) {
      expect(
        quoteBodySchema.safeParse({ ...base, mode: 'shares', value }).success,
        String(value),
      ).toBe(false);
    }
    // A malformed string must be a single zod issue on `value` — never a BigInt SyntaxError
    // escaping safeParse (which the API would turn into a 500).
    for (const value of ['', '-1', '1.5', '01', '1e3', 'abc']) {
      const result = quoteBodySchema.safeParse({ ...base, mode: 'spend', value });
      expect(result.success, value).toBe(false);
      expect(issuePaths(result), value).toEqual(['value']);
    }
    expect(quoteBodySchema.safeParse({ ...base, mode: 'amount', value: '1' }).success).toBe(false);
    expect(
      quoteBodySchema.safeParse({ ...base, marketId: 'x', mode: 'shares', value: '1' }).success,
    ).toBe(false);
  });
});

// ---- trades --------------------------------------------------------------------------
describe('tradeBodySchema', () => {
  const buy = {
    marketId,
    outcome: 'YES',
    side: 'buy',
    shares: 10,
    maxCostP: '600',
    expectedAccountId: 'u1',
  };
  const sell = {
    marketId,
    outcome: 'NO',
    side: 'sell',
    shares: 3,
    minProceedsP: '0',
    expectedAccountId: 'u1',
  };

  it('parses a guarded buy and a guarded sell, yielding bigint guards', () => {
    expect(tradeBodySchema.parse(buy)).toEqual({ ...buy, maxCostP: 600n });
    expect(tradeBodySchema.parse(sell)).toEqual({ ...sell, minProceedsP: 0n });
  });

  it('requires the guard that matches the side and forbids the other', () => {
    const noGuard = tradeBodySchema.safeParse({ ...buy, maxCostP: undefined });
    expect(noGuard.success).toBe(false);
    expect(issuePaths(noGuard)).toEqual(['maxCostP']);
    const sellNoGuard = tradeBodySchema.safeParse({ ...sell, minProceedsP: undefined });
    expect(issuePaths(sellNoGuard)).toEqual(['minProceedsP']);
    const buyWithProceeds = tradeBodySchema.safeParse({ ...buy, minProceedsP: '1' });
    expect(issuePaths(buyWithProceeds)).toEqual(['minProceedsP']);
    const sellWithCost = tradeBodySchema.safeParse({ ...sell, maxCostP: '1' });
    expect(issuePaths(sellWithCost)).toEqual(['maxCostP']);
  });

  it('bounds the guards, the shares and the account', () => {
    expect(tradeBodySchema.safeParse({ ...buy, maxCostP: '0' }).success).toBe(false);
    expect(
      tradeBodySchema.safeParse({ ...buy, maxCostP: (MAX_P_AMOUNT + 1n).toString() }).success,
    ).toBe(false);
    expect(tradeBodySchema.safeParse({ ...sell, minProceedsP: '-1' }).success).toBe(false);
    expect(tradeBodySchema.safeParse({ ...buy, shares: 0 }).success).toBe(false);
    expect(tradeBodySchema.safeParse({ ...buy, shares: 1.5 }).success).toBe(false);
    expect(tradeBodySchema.safeParse({ ...buy, shares: ORDER_QTY_MAX + 1 }).success).toBe(false);
    expect(tradeBodySchema.safeParse({ ...buy, shares: '10' }).success).toBe(false);
    expect(tradeBodySchema.safeParse({ ...buy, expectedAccountId: '' }).success).toBe(false);
    expect(tradeBodySchema.safeParse({ ...buy, expectedAccountId: undefined }).success).toBe(false);
  });

  it('turns a parsed body into wire-string terms for the idempotency comparison', () => {
    const terms = tradeTerms(tradeBodySchema.parse(buy));
    expect(terms).toEqual({
      marketId,
      outcome: 'YES',
      side: 'buy',
      shares: 10,
      maxCostP: '600',
      minProceedsP: null,
    });
    expect(tradeTermsSchema.parse(terms)).toEqual(terms);
    const sellTerms = tradeTerms(tradeBodySchema.parse(sell));
    expect(sellTerms).toEqual({
      marketId,
      outcome: 'NO',
      side: 'sell',
      shares: 3,
      maxCostP: null,
      minProceedsP: '0',
    });
    expect(
      sameTradeTerms(terms, tradeTerms(tradeBodySchema.parse({ ...buy, expectedAccountId: 'u2' }))),
    ).toBe(true);
    expect(sameTradeTerms(terms, { ...terms, shares: 11 })).toBe(false);
    expect(sameTradeTerms(terms, { ...terms, maxCostP: '601' })).toBe(false);
    expect(sameTradeTerms(terms, { ...terms, outcome: 'NO' })).toBe(false);
    expect(sameTradeTerms(terms, { ...terms, side: 'sell' })).toBe(false);
    expect(sameTradeTerms(terms, { ...terms, minProceedsP: '0' })).toBe(false);
    expect(
      sameTradeTerms(terms, { ...terms, marketId: '3f2504e0-4f89-41d3-9a0c-0305e82c3302' }),
    ).toBe(false);
  });

  it('lower-cases the market id, so a replay compares like the stored order (api/uuid.ts)', () => {
    // Postgres returns a uuid lower-case; a body kept as sent would name another lock key,
    // another channel and — on the same-key retry — another trade (409).
    const shouted = { ...buy, marketId: marketId.toUpperCase() };
    expect(tradeBodySchema.parse(shouted).marketId).toBe(marketId);
    expect(
      sameTradeTerms(
        tradeTerms(tradeBodySchema.parse(shouted)),
        tradeTerms(tradeBodySchema.parse(buy)),
      ),
    ).toBe(true);
    const terms = tradeTerms(tradeBodySchema.parse(buy));
    expect(tradeTermsSchema.parse({ ...terms, marketId: marketId.toUpperCase() })).toEqual(terms);
  });
});

// ---- admin bodies --------------------------------------------------------------------
describe('createMarketBodySchema', () => {
  const body = {
    title: ' 2026년 안에 코스피 3000? ',
    rules: '',
    categoryId: 1,
    closeAt: at,
    initialProbBp: 5000,
    liquidityB: 1000,
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
      liquidityB: 1234.123456,
      slug: 'kospi-3000',
    });
    expect(full.resolutionSource).toBe('KRX');
    expect(full.slug).toBe('kospi-3000');
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
      { initialProbBp: 0 },
      { initialProbBp: 10_000 },
      { liquidityB: 0.5 },
      { liquidityB: LIQUIDITY_B_MAX + 1 },
      { liquidityB: 1000.1234567 },
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
    expect(updateMarketBodySchema.parse({ liquidityB: 500, initialProbBp: 3000 })).toEqual({
      liquidityB: 500,
      initialProbBp: 3000,
    });
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

describe('voidMarketBodySchema', () => {
  it('requires a reason of 1..500 characters', () => {
    expect(voidMarketBodySchema.parse({ reason: ' 규칙 오류 ' })).toEqual({ reason: '규칙 오류' });
    expect(voidMarketBodySchema.safeParse({ reason: '  ' }).success).toBe(false);
    expect(voidMarketBodySchema.safeParse({ reason: 'x'.repeat(501) }).success).toBe(false);
    expect(voidMarketBodySchema.safeParse({}).success).toBe(false);
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
