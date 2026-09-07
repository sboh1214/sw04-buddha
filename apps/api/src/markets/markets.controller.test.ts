/**
 * Public market reads (PLAN 7.1, M3 design 3.2) against the docker `test` profile: list
 * filters and the three sort-specific keysets, id/slug lookup, fills, ticks, categories.
 * Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import { createCategory, createMarket, createUser } from '@buddha/db/test';
import {
  FILLS_RECENT_LIMIT,
  MARKET_SLUG_MAX,
  TICKS_MAX_POINTS,
  TICKS_SCAN_MAX,
  type Fill,
  type Market,
  type MarketSummary,
  type Outcome,
  type PriceTick,
} from '@buddha/shared';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_PARAM_LENGTH } from '../infra/http/fastify-options.js';
import { createTestApp, type TestApp } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

type ListPage = { data: MarketSummary[]; meta: { nextCursor: string | null } };

const DAY_MS = 24 * 60 * 60 * 1000;

describe.skipIf(!hasTestInfra)('markets public reads (integration)', () => {
  let t: TestApp;
  /** Creator and category shared by every fixture market (createMarket would mint one each). */
  let creatorId: string;
  let category: { id: number; slug: string; nameKo: string };

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    creatorId = (await createUser(t.db, { role: 'admin' })).user.id;
    category = await createCategory(t.db, { slug: 'economy', nameKo: '경제' });
  });

  const market = (input: Parameters<typeof createMarket>[1] = {}) =>
    createMarket(t.db, { createdBy: creatorId, categoryId: category.id, ...input });

  const get = (url: string) => t.app.inject({ method: 'GET', url });

  /** Follows `meta.nextCursor` to the end and returns every id in page order. */
  async function walk(url: string): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await get(cursor ? `${url}&cursor=${encodeURIComponent(cursor)}` : url);
      expect(res.statusCode).toBe(200);
      const page = res.json<ListPage>();
      ids.push(...page.data.map((row) => row.id));
      cursor = page.meta.nextCursor;
      pages += 1;
      if (pages > 50) throw new Error(`cursor never ended for ${url}`);
    } while (cursor);
    return ids;
  }

  /** A market order plus its AMM fill, written directly (the trade route is the trades suite's). */
  async function insertFill(input: {
    marketId: string;
    userId: string;
    outcome: Outcome;
    side: 'buy' | 'sell';
    qty: number;
    amountP: bigint;
    createdAt: Date;
  }) {
    const [order] = await t.db
      .insert(schema.orders)
      .values({
        userId: input.userId,
        marketId: input.marketId,
        outcome: input.outcome,
        side: input.side,
        type: 'market',
        qty: input.qty,
        filledQty: input.qty,
        status: 'filled',
        idempotencyKey: randomUUID(),
        createdAt: input.createdAt,
      })
      .returning();
    const [fill] = await t.db
      .insert(schema.fills)
      .values({
        marketId: input.marketId,
        orderId: order!.id,
        counterpartyType: 'amm',
        outcome: input.outcome,
        side: input.side,
        qty: input.qty,
        amountP: input.amountP,
        priceAvgBp: Math.round((Number(input.amountP) * 100) / input.qty),
        createdAt: input.createdAt,
      })
      .returning();
    return fill!;
  }

  it('lists open markets by default, never drafts, and filters by status', async () => {
    const open = await market({ title: '열린 시장' });
    const closed = await market({ title: '마감된 시장', status: 'closed' });
    const draft = await market({ title: '초안', status: 'draft' });

    const res = await get('/api/v1/markets');
    expect(res.statusCode).toBe(200);
    const page = res.json<ListPage>();
    expect(page.data.map((row) => row.id)).toEqual([open.id]);
    expect(page.meta.nextCursor).toBeNull();
    expect(page.data[0]).toMatchObject({
      slug: open.slug,
      title: '열린 시장',
      category: { slug: 'economy', nameKo: '경제' },
      status: 'open',
      lastPrice: 50,
      pYesBp: 5000,
      volumeP: '0',
      tradeCount: 0,
      traderCount: 0,
      resolvedResult: null,
    });
    // The card carries nothing the public must not see (PLAN 7.1).
    expect(page.data[0]).not.toHaveProperty('qYes');
    expect(page.data[0]).not.toHaveProperty('liquidityB');
    expect(page.data[0]).not.toHaveProperty('reserveP');

    const closedPage = await get('/api/v1/markets?status=closed');
    expect(closedPage.json<ListPage>().data.map((row) => row.id)).toEqual([closed.id]);

    // `draft` is not a public status at all: refused by the schema, not silently empty.
    const draftPage = await get('/api/v1/markets?status=draft');
    expect(draftPage.statusCode).toBe(400);
    expect(draftPage.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    for (const status of ['open', 'closed', 'voided', 'settled']) {
      const ids = (await get(`/api/v1/markets?status=${status}`)).json<ListPage>().data;
      expect(ids.map((row) => row.id)).not.toContain(draft.id);
    }
  });

  it('lists a market past its close time until someone closes it (A-M3-31)', async () => {
    // The list filters on status alone. M3 has no close job, so a market whose close time has
    // passed keeps its `open` status — the seed writes such markets on purpose — and it stays
    // listed, first under `closing`, while every quote and trade answers MARKET_CLOSED. If a
    // later milestone hides it here, this is the assertion that says so out loud.
    const expired = await market({
      title: '마감 시각이 지난 시장',
      closeAt: new Date(Date.now() - 60_000),
    });
    const later = await market({ title: '아직 열린 시장', closeAt: new Date(Date.now() + DAY_MS) });

    const page = (await get('/api/v1/markets')).json<ListPage>();
    expect(page.data.map((row) => row.id)).toContain(expired.id);
    const closing = (await get('/api/v1/markets?sort=closing')).json<ListPage>();
    expect(closing.data.map((row) => row.id)).toEqual([expired.id, later.id]);

    const quote = await t.app.inject({
      method: 'POST',
      url: '/api/v1/quotes',
      headers: { 'content-type': 'application/json' },
      payload: { marketId: expired.id, outcome: 'YES', side: 'buy', mode: 'shares', value: '10' },
    });
    expect(quote.statusCode).toBe(409);
    expect(quote.json()).toMatchObject({ error: { code: 'MARKET_CLOSED' } });
  });

  it('filters by category slug and searches titles with LIKE wildcards escaped', async () => {
    const weather = await createCategory(t.db, { slug: 'weather', nameKo: '날씨' });
    const rain = await market({ title: '9월 서울 강수량 100mm 초과?', categoryId: weather.id });
    const rate = await market({ title: '기준금리 3% 이하로 인하?' });
    await market({ title: '코스피 3000 돌파?' });

    const byCategory = (await get('/api/v1/markets?category=weather')).json<ListPage>();
    expect(byCategory.data.map((row) => row.id)).toEqual([rain.id]);
    expect((await get('/api/v1/markets?category=nope')).json<ListPage>().data).toHaveLength(0);

    const search = (q: string) =>
      get(`/api/v1/markets?q=${encodeURIComponent(q)}`).then((res) => res.json<ListPage>().data);
    expect((await search('강수량')).map((row) => row.id)).toEqual([rain.id]);
    // Case-insensitive, and a bare wildcard matches only a literal '%' in a title.
    expect((await search('MM')).map((row) => row.id)).toEqual([rain.id]);
    expect((await search('%')).map((row) => row.id)).toEqual([rate.id]);
    expect(await search('_')).toHaveLength(0);
    expect(await search('\\')).toHaveLength(0);

    const tooLong = await get(`/api/v1/markets?q=${'a'.repeat(101)}`);
    expect(tooLong.statusCode).toBe(400);
  });

  it('paginates every sort without gaps or repeats across 26 markets with ties', async () => {
    // Ties on both sort keys (volume and close time) and, likely, on created_at: the id half of
    // the keyset is what keeps a page boundary inside a tie from skipping or repeating a row.
    const base = Date.now() + DAY_MS;
    for (let i = 0; i < 26; i += 1) {
      await market({
        volumeP: BigInt(Math.floor(i / 2) * 1_000),
        closeAt: new Date(base + Math.floor(i / 3) * 60 * 60 * 1000),
      });
    }
    await market({ status: 'draft' }); // never listed, whatever the sort
    const rows = await t.db.select().from(schema.markets);
    const open = rows.filter((row) => row.status === 'open');
    expect(open).toHaveLength(26);

    const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const expected = {
      volume: [...open]
        .sort((a, b) => (a.volumeP === b.volumeP ? byId(b, a) : a.volumeP > b.volumeP ? -1 : 1))
        .map((row) => row.id),
      closing: [...open]
        .sort((a, b) => a.closeAt.getTime() - b.closeAt.getTime() || byId(a, b))
        .map((row) => row.id),
      newest: [...open]
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || byId(b, a))
        .map((row) => row.id),
    };

    for (const sort of ['volume', 'closing', 'newest'] as const) {
      const ids = await walk(`/api/v1/markets?sort=${sort}&limit=7`);
      expect({ sort, count: ids.length }).toEqual({ sort, count: 26 });
      expect({ sort, unique: new Set(ids).size }).toEqual({ sort, unique: 26 });
      expect({ sort, ids }).toEqual({ sort, ids: expected[sort] });
    }
    // Default sort is volume.
    expect((await get('/api/v1/markets?limit=3')).json<ListPage>().data.map((r) => r.id)).toEqual(
      expected.volume.slice(0, 3),
    );
  });

  it('serves the first page for a malformed cursor instead of a 500', async () => {
    await market();
    for (const sort of ['volume', 'closing', 'newest']) {
      for (const cursor of ['0_not-a-uuid', 'x_y', '99999999999999999999_' + randomUUID()]) {
        const res = await get(`/api/v1/markets?sort=${sort}&cursor=${encodeURIComponent(cursor)}`);
        expect({ sort, cursor, status: res.statusCode }).toEqual({ sort, cursor, status: 200 });
        expect(res.json<ListPage>().data).toHaveLength(1);
      }
    }
  });

  it('finds a market by id, by slug and by a decomposed (NFD) slug; hides drafts', async () => {
    const open = await market({ slug: '한글-시장-2026', title: '한글 시장', description: '설명' });
    const draft = await market({ slug: 'draft-market', status: 'draft' });

    const byId = await get(`/api/v1/markets/${open.id}`);
    expect(byId.statusCode).toBe(200);
    const detail = byId.json<{ data: Market }>().data;
    expect(detail).toMatchObject({
      id: open.id,
      slug: '한글-시장-2026',
      title: '한글 시장',
      description: '설명',
      rules: open.rules,
      resolutionSource: open.resolutionSource,
      status: 'open',
      resolvedAt: null,
      voidedAt: null,
    });
    // PLAN 7.1: no LMSR state, liquidity, reserve or author on the public detail.
    for (const secret of ['qYes', 'qNo', 'liquidityB', 'reserveP', 'createdBy']) {
      expect(detail).not.toHaveProperty(secret);
    }

    const bySlug = await get(`/api/v1/markets/${encodeURIComponent('한글-시장-2026')}`);
    expect(bySlug.json<{ data: Market }>().data.id).toBe(open.id);
    const nfd = '한글-시장-2026'.normalize('NFD');
    expect(nfd).not.toBe('한글-시장-2026');
    const byNfd = await get(`/api/v1/markets/${encodeURIComponent(nfd)}`);
    expect(byNfd.statusCode).toBe(200);
    expect(byNfd.json<{ data: Market }>().data.id).toBe(open.id);

    // The longest slug the column takes, spelled decomposed: 힣 is three code units in NFD
    // (ᄒ ᅵ ᇂ), the most a syllable can be, so the parameter is normalised before its length
    // is checked and the router's own bound (MAX_PARAM_LENGTH) is sized for it. Composed, it
    // is at the limit and also found.
    const longSlug = `${'힣'.repeat(MARKET_SLUG_MAX - 5)}-2026`;
    expect(longSlug).toHaveLength(MARKET_SLUG_MAX);
    const long = await market({ slug: longSlug, title: '긴 slug' });
    const longNfd = longSlug.normalize('NFD');
    expect(longNfd).toHaveLength(MARKET_SLUG_MAX * 3 - 10);
    for (const spelling of [longSlug, longNfd]) {
      const res = await get(`/api/v1/markets/${encodeURIComponent(spelling)}`);
      expect({ length: spelling.length, status: res.statusCode }).toEqual({
        length: spelling.length,
        status: 200,
      });
      expect(res.json<{ data: Market }>().data.id).toBe(long.id);
    }
    // The router's bound, pinned: at it the schema answers (400, an over-long NFC slug);
    // past it Fastify itself refuses the parameter before any handler runs.
    expect((await get(`/api/v1/markets/${'a'.repeat(MAX_PARAM_LENGTH)}`)).statusCode).toBe(400);
    expect((await get(`/api/v1/markets/${'a'.repeat(MAX_PARAM_LENGTH + 1)}`)).statusCode).toBe(414);

    for (const url of [
      `/api/v1/markets/${draft.id}`,
      '/api/v1/markets/draft-market',
      `/api/v1/markets/${randomUUID()}`, // uuid-shaped: looked up as an id only
      '/api/v1/markets/no-such-slug',
      `/api/v1/markets/${draft.id}/fills`,
      `/api/v1/markets/${draft.id}/ticks`,
      `/api/v1/markets/${randomUUID()}/fills`,
      `/api/v1/markets/${randomUUID()}/ticks`,
    ]) {
      const res = await get(url);
      expect({ url, status: res.statusCode }).toEqual({ url, status: 404 });
      expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
    // Longer than any slug or uuid: malformed, not merely unknown.
    expect((await get(`/api/v1/markets/${'a'.repeat(81)}`)).statusCode).toBe(400);
    expect((await get('/api/v1/markets/not-a-uuid/fills')).statusCode).toBe(400);
  });

  it('refuses NUL in a path or query parameter as bad input, never as a 500', async () => {
    await market({ title: '정상 시장' });
    // Postgres rejects U+0000 in text (22021); the global pipe must catch it first.
    for (const [url, path] of [
      ['/api/v1/markets/%00', []],
      ['/api/v1/markets/slug%00', []],
      ['/api/v1/markets?q=%00', ['q']],
      [`/api/v1/markets?q=${encodeURIComponent('정상')}%00`, ['q']],
      ['/api/v1/markets?category=%00', ['category']],
    ] as const) {
      const res = await get(url);
      expect({ url, status: res.statusCode }).toEqual({ url, status: 400 });
      expect(res.json()).toMatchObject({
        error: {
          code: 'VALIDATION_ERROR',
          details: [{ path: [...path], message: 'must not contain NUL' }],
        },
      });
    }
  });

  it('lists the newest fills, anonymous and capped at FILLS_RECENT_LIMIT', async () => {
    const open = await market();
    const trader = (await createUser(t.db)).user.id;
    const base = Date.now() - 60 * 60 * 1000;
    const written: { id: number; qty: number }[] = [];
    for (let i = 0; i < FILLS_RECENT_LIMIT + 5; i += 1) {
      const fill = await insertFill({
        marketId: open.id,
        userId: trader,
        outcome: i % 2 === 0 ? 'YES' : 'NO',
        side: i % 3 === 0 ? 'sell' : 'buy',
        qty: i + 1,
        amountP: BigInt((i + 1) * 50),
        createdAt: new Date(base + i * 1_000),
      });
      written.push({ id: fill.id, qty: fill.qty });
    }

    const res = await get(`/api/v1/markets/${open.id}/fills`);
    expect(res.statusCode).toBe(200);
    const fills = res.json<{ data: Fill[] }>().data;
    expect(fills).toHaveLength(FILLS_RECENT_LIMIT);
    // Newest first: the last FILLS_RECENT_LIMIT written, in reverse.
    expect(fills.map((fill) => fill.id)).toEqual(
      written
        .slice(-FILLS_RECENT_LIMIT)
        .reverse()
        .map((fill) => fill.id.toString()),
    );
    expect(fills[0]).toMatchObject({ qty: FILLS_RECENT_LIMIT + 5, priceAvgBp: 5000 });
    expect(fills[0]!.amountP).toBe(String((FILLS_RECENT_LIMIT + 5) * 50));
    for (const fill of fills) {
      expect(Object.keys(fill).sort()).toEqual(
        ['amountP', 'createdAt', 'id', 'outcome', 'priceAvgBp', 'qty', 'side'].sort(),
      );
    }
  });

  it('downsamples ticks in SQL to about TICKS_MAX_POINTS, keeping the first and last', async () => {
    const open = await market();
    const base = new Date('2026-09-01T00:00:00.000Z').getTime();
    const total = 1_200;
    const values = Array.from({ length: total }, (_, i) => ({
      marketId: open.id,
      ts: new Date(base + i * 1_000),
      pYesBp: 4_000 + (i % 100),
      trigger: i === 0 ? ('open' as const) : ('trade' as const),
    }));
    // One statement per chunk: a 1,200-row VALUES list is fine for Postgres.
    for (let i = 0; i < total; i += 400) {
      await t.db.insert(schema.priceTicks).values(values.slice(i, i + 400));
    }

    const res = await get(`/api/v1/markets/${open.id}/ticks`);
    expect(res.statusCode).toBe(200);
    const ticks = res.json<{ data: PriceTick[] }>().data;
    expect(ticks.length).toBeLessThanOrEqual(TICKS_MAX_POINTS);
    expect(ticks.length).toBeGreaterThanOrEqual(TICKS_MAX_POINTS / 2);
    expect(ticks[0]).toEqual({ ts: new Date(base).toISOString(), pYesBp: 4_000, trigger: 'open' });
    expect(ticks.at(-1)).toEqual({
      ts: new Date(base + (total - 1) * 1_000).toISOString(),
      pYesBp: 4_000 + ((total - 1) % 100),
      trigger: 'trade',
    });
    for (let i = 1; i < ticks.length; i += 1) {
      expect(Date.parse(ticks[i]!.ts)).toBeGreaterThan(Date.parse(ticks[i - 1]!.ts));
    }

    // Twice the cap exactly: the stride is 2 and the newest tick is off a grid anchored at
    // the oldest row, which is where the answer used to come back one point over the maximum.
    const dense = await market();
    const denseTotal = TICKS_MAX_POINTS * 2;
    const denseValues = Array.from({ length: denseTotal }, (_, i) => ({
      marketId: dense.id,
      ts: new Date(base + i * 1_000),
      pYesBp: 5_000 + (i % 100),
      trigger: i === 0 ? ('open' as const) : ('trade' as const),
    }));
    for (let i = 0; i < denseTotal; i += 500) {
      await t.db.insert(schema.priceTicks).values(denseValues.slice(i, i + 500));
    }
    const capped = await get(`/api/v1/markets/${dense.id}/ticks`);
    expect(capped.statusCode).toBe(200);
    const cappedTicks = capped.json<{ data: PriceTick[] }>().data;
    expect(cappedTicks).toHaveLength(TICKS_MAX_POINTS);
    expect(cappedTicks[0]!.ts).toBe(new Date(base).toISOString());
    expect(cappedTicks.at(-1)!.ts).toBe(new Date(base + (denseTotal - 1) * 1_000).toISOString());

    // A range under the cap comes back complete, bounded by from/to inclusive.
    const from = new Date(base + 100_000).toISOString();
    const to = new Date(base + 200_000).toISOString();
    const ranged = await get(
      `/api/v1/markets/${open.id}/ticks?from=${from}&to=${to}&resolution=1m`,
    );
    expect(ranged.statusCode).toBe(200);
    const window = ranged.json<{ data: PriceTick[] }>().data;
    expect(window).toHaveLength(101);
    expect(window[0]!.ts).toBe(from);
    expect(window.at(-1)!.ts).toBe(to);
    const inverted = await get(`/api/v1/markets/${open.id}/ticks?from=${to}&to=${from}`);
    expect(inverted.statusCode).toBe(400);
    expect(inverted.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR', details: [{ path: ['from'] }] },
    });
    expect((await get(`/api/v1/markets/${open.id}/ticks?resolution=5m`)).statusCode).toBe(400);

    // A market without ticks (a factory market never wrote its 'open' tick) is an empty series.
    const bare = await market();
    expect(
      (await get(`/api/v1/markets/${bare.id}/ticks`)).json<{ data: PriceTick[] }>().data,
    ).toEqual([]);
  });

  it('ranks only the newest TICKS_SCAN_MAX ticks of the range, so a busy market costs no more', async () => {
    // Anonymous and unauthenticated: the window functions must never run over a market's
    // whole history. Past the bound the oldest ticks of the range are left out; the newest
    // TICKS_SCAN_MAX are sampled to about TICKS_MAX_POINTS as before.
    const open = await market();
    const base = new Date('2026-09-01T00:00:00.000Z').getTime();
    const extra = 50;
    const total = TICKS_SCAN_MAX + extra;
    const values = Array.from({ length: total }, (_, i) => ({
      marketId: open.id,
      ts: new Date(base + i * 1_000),
      pYesBp: 3_000 + (i % 100),
      trigger: 'trade' as const,
    }));
    // The two ticks astride the bound share a millisecond: the (ts, id) DESC order keeps the
    // later id (#extra) and drops #extra - 1.
    values[extra - 1]!.ts = values[extra]!.ts;
    for (let i = 0; i < total; i += 500) {
      await t.db.insert(schema.priceTicks).values(values.slice(i, i + 500));
    }

    const res = await get(`/api/v1/markets/${open.id}/ticks`);
    expect(res.statusCode).toBe(200);
    const ticks = res.json<{ data: PriceTick[] }>().data;
    // cnt = TICKS_SCAN_MAX: stride 20, and the grid is anchored at the newest tick, so the
    // answer is exactly the documented maximum — never one over it (PLAN 7.1).
    expect(ticks).toHaveLength(TICKS_MAX_POINTS);
    // The first served point is the oldest of the newest TICKS_SCAN_MAX, not tick #0.
    expect(ticks[0]).toEqual({
      ts: new Date(base + extra * 1_000).toISOString(),
      pYesBp: 3_000 + (extra % 100),
      trigger: 'trade',
    });
    expect(ticks.at(-1)!.ts).toBe(new Date(base + (total - 1) * 1_000).toISOString());
    // `from` older than the bound is a filter, not a floor: the first point stays the same.
    const fromOld = new Date(base).toISOString();
    const fromRes = await get(`/api/v1/markets/${open.id}/ticks?from=${fromOld}`);
    expect(fromRes.json<{ data: PriceTick[] }>().data[0]!.ts).toBe(ticks[0]!.ts);

    // A `to` inside the history moves the bound with it: the newest TICKS_SCAN_MAX up to `to`.
    const toIndex = total - 10;
    const to = new Date(base + toIndex * 1_000).toISOString();
    const upTo = (await get(`/api/v1/markets/${open.id}/ticks?to=${to}`)).json<{
      data: PriceTick[];
    }>().data;
    expect(upTo.at(-1)!.ts).toBe(to);
    expect(upTo).toHaveLength(TICKS_MAX_POINTS);
    expect(upTo[0]!.ts).toBe(new Date(base + (toIndex - TICKS_SCAN_MAX + 1) * 1_000).toISOString());
  });

  it('lists active categories in display order', async () => {
    await createCategory(t.db, { slug: 'tech', nameKo: '기술', sortOrder: 5 });
    await createCategory(t.db, { slug: 'weather', nameKo: '날씨', sortOrder: 1 });
    await createCategory(t.db, { slug: 'retired', nameKo: '은퇴', sortOrder: 0, isActive: false });

    const res = await get('/api/v1/categories');
    expect(res.statusCode).toBe(200);
    const data = res.json<{ data: { slug: string; nameKo: string; sortOrder: number }[] }>().data;
    expect(data.map((row) => row.slug)).toEqual(['economy', 'weather', 'tech']);
    expect(data[1]).toMatchObject({ nameKo: '날씨', sortOrder: 1 });
  });
});
