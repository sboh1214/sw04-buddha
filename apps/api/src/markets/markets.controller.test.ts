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
  SPARKLINE_MAX_POINTS,
  TICKS_MAX_POINTS,
  TICKS_SCAN_MAX,
  type Fill,
  type Market,
  type MarketListItem,
  type Outcome,
  type PriceSeries,
} from '@buddha/shared';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { MAX_PARAM_LENGTH } from '../infra/http/fastify-options.js';
import { createTestApp, signUpTestUser, type TestApp } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

type ListPage = { data: MarketListItem[]; meta: { nextCursor: string | null } };

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

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

  /**
   * `GET …/ticks` answers a self-describing `PriceSeries` object, never a bare array: the
   * window, the stride served and `truncated` travel with the points (Q-M3-8 (1)).
   */
  const series = async (url: string): Promise<PriceSeries> => {
    const res = await get(url);
    expect(res.statusCode).toBe(200);
    return res.json<{ data: PriceSeries }>().data;
  };

  const iso = (ms: number) => new Date(ms).toISOString();

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
      // The key is always present; a factory market never wrote the `open` tick the admin
      // transition (and the seed) writes, so this is the one shape with no samples at all.
      sparkline: [],
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

    const raw = await series(`/api/v1/markets/${open.id}/ticks`);
    // `raw` serves stored ticks, so it reports no stride at all; nothing was left out either.
    expect(raw).toMatchObject({ resolution: 'raw', bucketSeconds: 0, truncated: false });
    const ticks = raw.points;
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
    const capped = await series(`/api/v1/markets/${dense.id}/ticks`);
    const cappedTicks = capped.points;
    expect(capped.truncated).toBe(false);
    expect(cappedTicks).toHaveLength(TICKS_MAX_POINTS);
    expect(cappedTicks[0]!.ts).toBe(new Date(base).toISOString());
    expect(cappedTicks.at(-1)!.ts).toBe(new Date(base + (denseTotal - 1) * 1_000).toISOString());

    // A raw range under the cap comes back complete, bounded by from/to inclusive.
    const from = new Date(base + 100_000).toISOString();
    const to = new Date(base + 200_000).toISOString();
    const window = await series(`/api/v1/markets/${open.id}/ticks?from=${from}&to=${to}`);
    expect(window.points).toHaveLength(101);
    expect(window.points[0]!.ts).toBe(from);
    expect(window.points.at(-1)!.ts).toBe(to);

    // The SAME window at `1m` is no longer served raw: it is a 60-second grid binned from the
    // epoch, with both ends of the window pinned as boundaries. 00:01:40 and 00:03:20 are the
    // requested edges; 00:02:00 and 00:03:00 are the only interior grid points, each carrying
    // the tick in force there (one tick per second, so the boundary tick itself).
    const minute = await series(
      `/api/v1/markets/${open.id}/ticks?from=${from}&to=${to}&resolution=1m`,
    );
    expect(minute).toMatchObject({
      resolution: '1m',
      bucketSeconds: 60,
      truncated: false,
      from,
      to,
    });
    expect(minute.points).toEqual([
      { ts: from, pYesBp: 4_000, trigger: 'trade' },
      { ts: new Date(base + 120_000).toISOString(), pYesBp: 4_020, trigger: 'trade' },
      { ts: new Date(base + 180_000).toISOString(), pYesBp: 4_080, trigger: 'trade' },
      { ts: to, pYesBp: 4_000, trigger: 'trade' },
    ]);

    const inverted = await get(`/api/v1/markets/${open.id}/ticks?from=${to}&to=${from}`);
    expect(inverted.statusCode).toBe(400);
    expect(inverted.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR', details: [{ path: ['from'] }] },
    });
    expect((await get(`/api/v1/markets/${open.id}/ticks?resolution=5m`)).statusCode).toBe(400);

    // A market without ticks (a factory market never wrote its 'open' tick) is an empty series
    // — at every resolution: the boundaries have nothing to carry forward and vanish.
    const bare = await market();
    for (const resolution of ['raw', '1m', '1h']) {
      const empty = await series(`/api/v1/markets/${bare.id}/ticks?resolution=${resolution}`);
      expect({ resolution, points: empty.points, truncated: empty.truncated }).toEqual({
        resolution,
        points: [],
        truncated: false,
      });
    }
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

    const res = await series(`/api/v1/markets/${open.id}/ticks`);
    const ticks = res.points;
    // The 50 oldest ticks of the range were left out, and the answer says so. The cheap
    // `cnt >= TICKS_SCAN_MAX` flag alone cannot know that; the confirmation probe can.
    expect(res.truncated).toBe(true);
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
    const fromRes = await series(`/api/v1/markets/${open.id}/ticks?from=${fromOld}`);
    expect(fromRes.points[0]!.ts).toBe(ticks[0]!.ts);

    // A `to` inside the history moves the bound with it: the newest TICKS_SCAN_MAX up to `to`.
    const toIndex = total - 10;
    const to = new Date(base + toIndex * 1_000).toISOString();
    const upTo = await series(`/api/v1/markets/${open.id}/ticks?to=${to}`);
    expect(upTo.points.at(-1)!.ts).toBe(to);
    expect(upTo.points).toHaveLength(TICKS_MAX_POINTS);
    expect(upTo.points[0]!.ts).toBe(
      new Date(base + (toIndex - TICKS_SCAN_MAX + 1) * 1_000).toISOString(),
    );

    // Exactly TICKS_SCAN_MAX ticks in range and nothing older inside it: the cheap flag fires
    // (cnt is at the cap) and the probe answers false. This is the off-by-one the flag alone
    // gets wrong, and the reason `truncated` costs a second statement at the bound.
    const exact = await series(
      `/api/v1/markets/${open.id}/ticks?to=${new Date(base + (TICKS_SCAN_MAX - 1) * 1_000).toISOString()}`,
    );
    expect(exact.truncated).toBe(false);
    expect(exact.points).toHaveLength(TICKS_MAX_POINTS);
    expect(exact.points[0]!.ts).toBe(new Date(base).toISOString());
  });

  it('samples a bucketed resolution on the absolute grid, carrying the value in force', async () => {
    // t0 is hour-aligned only to make the boundaries easy to name: the grid is binned from the
    // 1970 epoch with a +00 origin, never from `from` and never from the session time zone.
    const open = await market();
    const t0 = new Date('2026-09-01T00:00:00.000Z').getTime();
    await t.db.insert(schema.priceTicks).values([
      { marketId: open.id, ts: new Date(t0), pYesBp: 4_000, trigger: 'open' as const },
      {
        marketId: open.id,
        ts: new Date(t0 + 3 * HOUR_MS),
        pYesBp: 6_500,
        trigger: 'trade' as const,
      },
    ]);

    const window = await series(
      `/api/v1/markets/${open.id}/ticks?from=${iso(t0)}&to=${iso(t0 + 4 * HOUR_MS)}&resolution=1h`,
    );
    expect(window).toMatchObject({
      resolution: '1h',
      bucketSeconds: 3_600,
      truncated: false,
      from: iso(t0),
      to: iso(t0 + 4 * HOUR_MS),
    });
    // An hour with no trade repeats the value in force and the repeat is dropped in SQL, so
    // nothing is emitted at +1h or +2h; the closing boundary is kept even though it repeats.
    // Gap-fill rows would cost 1,440 points for three trades and say nothing more.
    expect(window.points).toEqual([
      { ts: iso(t0), pYesBp: 4_000, trigger: 'open' },
      { ts: iso(t0 + 3 * HOUR_MS), pYesBp: 6_500, trigger: 'trade' },
      { ts: iso(t0 + 4 * HOUR_MS), pYesBp: 6_500, trigger: 'trade' },
    ]);

    // The left edge looks back PAST `from` by construction, so a window that opens ten hours
    // after the last trade still starts at a value instead of at nothing. This is the pin for
    // the empty-left-edge regression an `ts >= from` filter would bring back.
    const edge = await series(
      `/api/v1/markets/${open.id}/ticks?from=${iso(t0 + 10 * HOUR_MS)}&to=${iso(t0 + 12 * HOUR_MS)}&resolution=1h`,
    );
    expect(edge.points).toHaveLength(2);
    expect(edge.points[0]).toEqual({ ts: edge.from, pYesBp: 6_500, trigger: 'trade' });
    expect(edge.points.at(-1)).toEqual({ ts: edge.to, pYesBp: 6_500, trigger: 'trade' });
  });

  it('coarsens the stride until the window fits and stays bounded by the answer', async () => {
    // 20,000 ticks across one day: a bucketed read costs one index descent per OUTPUT point,
    // so the TICKS_SCAN_MAX row cap does not apply and density cannot push the answer over
    // TICKS_MAX_POINTS or set `truncated`.
    const open = await market();
    const base = new Date('2026-09-01T00:00:00.000Z').getTime();
    const total = 20_000;
    const values = Array.from({ length: total }, (_, i) => ({
      marketId: open.id,
      ts: new Date(base + Math.floor((i * DAY_MS) / total)),
      pYesBp: 1_000 + (i % 9_000),
      trigger: i === 0 ? ('open' as const) : ('trade' as const),
    }));
    for (let i = 0; i < total; i += 1_000) {
      await t.db.insert(schema.priceTicks).values(values.slice(i, i + 1_000));
    }

    const day = await series(
      `/api/v1/markets/${open.id}/ticks?from=${iso(base)}&to=${iso(base + DAY_MS)}&resolution=1m`,
    );
    // A 1-minute grid over a day would be 1,440 points, so the stride is coarsened to five
    // minutes rather than striped — points stay evenly spaced — and the request's own
    // `resolution` is echoed back beside the stride actually served.
    expect(day).toMatchObject({ resolution: '1m', bucketSeconds: 300, truncated: false });
    expect(day.points.length).toBeLessThanOrEqual(TICKS_MAX_POINTS);
    for (let i = 1; i < day.points.length; i += 1) {
      expect(Date.parse(day.points[i]!.ts)).toBeGreaterThan(Date.parse(day.points[i - 1]!.ts));
    }
    // Every interior point sits on the absolute grid. Swapping `date_bin` for `date_trunc`,
    // dropping the `+00` from the origin or using a calendar interval drifts off it.
    for (const point of day.points.slice(1, -1)) {
      expect(Date.parse(point.ts) % (day.bucketSeconds * 1_000)).toBe(0);
    }
    // Consecutive duplicates are dropped; only the closing boundary may repeat its neighbour.
    for (let i = 1; i < day.points.length - 1; i += 1) {
      expect(day.points[i]!.pYesBp).not.toBe(day.points[i - 1]!.pYesBp);
    }

    // Escalation is driven by the window, not by the data: the same `1m` request over a week
    // is served hourly. `to` is omitted, so the server closes the window on its own clock.
    const now = Date.now();
    const oneDay = await series(
      `/api/v1/markets/${open.id}/ticks?from=${iso(now - DAY_MS)}&resolution=1m`,
    );
    expect(oneDay.bucketSeconds).toBe(300);
    const oneWeek = await series(
      `/api/v1/markets/${open.id}/ticks?from=${iso(now - 7 * DAY_MS)}&resolution=1m`,
    );
    expect(oneWeek).toMatchObject({ resolution: '1m', bucketSeconds: 3_600 });
    expect(oneWeek.points.length).toBeLessThanOrEqual(TICKS_MAX_POINTS);
  });

  it('opens a `windowSeconds` range from its OWN clock, so a skewed caller still gets the span', async () => {
    // THE HAZARD it closes (A-M4-35): a client deriving `from` from `Date.now()` names an INSTANT
    // for a window whose other end this service closes on the database clock, so the served span
    // came out wrong by the visitor's skew — and past a full day fast the request inverted, the
    // clamp below collapsed it to one instant, and the chart's accessible summary then asserted
    // 시작/최고/최저 all equal on a day that had moved. A DURATION is the one thing a wrong clock
    // still measures correctly, so that is what the client sends now.
    const open = await market();
    const twoHoursAgo = open.openAt!.getTime() - 2 * HOUR_MS;
    await t.db.insert(schema.priceTicks).values({
      marketId: open.id,
      ts: new Date(twoHoursAgo),
      pYesBp: 4_000,
      trigger: 'open' as const,
    });

    const windowed = await series(
      `/api/v1/markets/${open.id}/ticks?windowSeconds=3600&resolution=1m`,
    );
    // The window is exactly an hour wide and both ends are the service's own reading.
    const span = Date.parse(windowed.to) - Date.parse(windowed.from);
    expect(span).toBe(HOUR_MS);
    // And it is anchored to NOW, not to anything the caller said: the older tick is outside it.
    expect(Date.parse(windowed.from)).toBeGreaterThan(twoHoursAgo);
  });

  it('refuses a request that names its window twice', async () => {
    // `from` and `windowSeconds` are mutually exclusive at the schema: one request, one window.
    const open = await market();
    const response = await t.app.inject({
      method: 'GET',
      url: `/api/v1/markets/${open.id}/ticks?from=${iso(Date.now() - HOUR_MS)}&windowSeconds=3600`,
    });
    expect(response.statusCode).toBe(400);
  });

  it('clamps a one-sided window down to `to`, and never calls a bucketed answer truncated', async () => {
    // `ticksQuerySchema` orders the bounds only when BOTH are given, so with one bound the
    // service is what has to keep the window ordered — and it must do it by moving the
    // DEFAULTED end, never the caller's.
    const open = await market();
    const tickAt = open.openAt!.getTime() - HOUR_MS;
    await t.db.insert(schema.priceTicks).values({
      marketId: open.id,
      ts: new Date(tickAt),
      pYesBp: 4_000,
      trigger: 'open' as const,
    });

    // A client paging backwards asks for history older than the market itself. Both
    // resolutions must answer the window that was asked for, and answer it empty: `to` used
    // to be pulled UP to the defaulted `from`, so the grid pinned a boundary at the market's
    // opening and served a point NEWER than the requested `to` while `raw` — which filters on
    // the untouched `query.to` — served nothing for the very same request.
    const before = iso(open.openAt!.getTime() - DAY_MS);
    for (const resolution of ['1h', 'raw'] as const) {
      const older = await series(
        `/api/v1/markets/${open.id}/ticks?to=${before}&resolution=${resolution}`,
      );
      expect({ resolution, from: older.from, to: older.to, points: older.points }).toEqual({
        resolution,
        from: before,
        to: before,
        points: [],
      });
    }

    // The mirror case: a clock running days fast sends a `from` past the server's own `now`
    // with no `to`. The window collapses onto the DB clock, not onto the future instant, so
    // the series is the probability in force now rather than a point stamped in the future.
    const ahead = Date.now() + 2 * DAY_MS;
    const skewed = await series(
      `/api/v1/markets/${open.id}/ticks?from=${iso(ahead)}&resolution=1h`,
    );
    expect(Date.parse(skewed.to)).toBeLessThan(ahead);
    expect(skewed.from).toBe(skewed.to);
    expect(skewed.points).toEqual([{ ts: skewed.to, pYesBp: 4_000, trigger: 'open' }]);

    // A window no ladder entry can cover (about ten years) is trimmed at the old end, and the
    // narrowed `from` is the entire report of it. `truncated` stays false: it is the raw
    // path's probed claim that points older than the served ones were left out INSIDE the
    // window, and a grid cannot hit it — its first point is the trimmed edge itself, carrying
    // the value in force there. Asserting it from the trim alone claimed dropped history for
    // a market whose whole life is inside the served window.
    const wide = await series(
      `/api/v1/markets/${open.id}/ticks?from=${iso(0)}&to=${iso(tickAt)}&resolution=1h`,
    );
    expect(wide).toMatchObject({ bucketSeconds: 604_800, truncated: false, to: iso(tickAt) });
    expect(Date.parse(wide.to) - Date.parse(wide.from)).toBe(
      604_800 * 1_000 * (TICKS_MAX_POINTS - 2),
    );
    expect(wide.points).toEqual([{ ts: iso(tickAt), pYesBp: 4_000, trigger: 'open' }]);
  });

  it('samples the card sparkline on a fixed hourly grid, carrying values forward', async () => {
    // Ticks sit MID-bucket (…30m) so a slow test or a little clock skew cannot straddle a grid
    // edge and move a sample into the neighbouring bucket.
    const tick = (marketId: string, msAgo: number, pYesBp: number) => ({
      marketId,
      ts: new Date(Date.now() - msAgo),
      pYesBp,
      trigger: 'trade' as const,
    });

    const quiet = await market({ title: '조용한 시장' });
    await t.db
      .insert(schema.priceTicks)
      .values([
        tick(quiet.id, 30 * HOUR_MS - HOUR_MS / 2, 3_000),
        tick(quiet.id, 10 * HOUR_MS - HOUR_MS / 2, 5_000),
        tick(quiet.id, 10 * 60 * 1_000, 7_000),
      ]);
    const young = await market({ title: '어린 시장' });
    await t.db.insert(schema.priceTicks).values([tick(young.id, 3 * HOUR_MS + HOUR_MS / 2, 9_100)]);
    const bare = await market({ title: '틱 없는 시장' });
    const rising = await market({ title: '오르는 시장' });
    await t.db
      .insert(schema.priceTicks)
      .values(
        Array.from({ length: 6 }, (_, i) =>
          tick(rising.id, (26 - i * 5) * HOUR_MS - HOUR_MS / 2, 2_000 + i * 500),
        ),
      );

    const page = (await get('/api/v1/markets?limit=10')).json<ListPage>();
    const byId = new Map(page.data.map((row): [string, number[]] => [row.id, row.sparkline]));
    expect(byId.size).toBe(4);
    // The line ends where the badge says it does: the newest sample is the CARD's own
    // probability, not the newest tick's. The two agree in production — one trade writes both —
    // but the rows and the samples are read in separate statements, so a trade committing
    // between them used to leave the card carrying the old price beside a line already drawn to
    // the new one. These fixtures insert ticks without moving the row, which is exactly that
    // disagreement, frozen.
    for (const row of page.data) {
      if (row.sparkline.length > 0) expect(row.sparkline.at(-1)).toBe(row.pYesBp);
    }
    const cardBp = new Map(page.data.map((row): [string, number] => [row.id, row.pYesBp]));

    const quietSpark = byId.get(quiet.id)!;
    expect(quietSpark).toHaveLength(SPARKLINE_MAX_POINTS);
    // An as-of read, not a `ts >= now() - 24h` window: the 29½-hour-old tick is the value in
    // force for every bucket up to now-10h, so a market that has not traded in a day draws a
    // true flat line instead of coming back empty.
    expect(quietSpark.slice(0, 15)).toEqual(Array.from({ length: 15 }, () => 3_000));
    expect(quietSpark.slice(15, -1)).toEqual(Array.from({ length: 9 }, () => 5_000));
    expect(quietSpark.at(-1)).toBe(cardBp.get(quiet.id));

    // Leading unknowns are TRIMMED, never zero-filled (0 bp is a real probability), so the
    // array's length is what says where the series starts: 25 - 4 = bucket 21.
    expect(byId.get(young.id)).toEqual([9_100, 9_100, 9_100, cardBp.get(young.id)]);
    // A factory market bypasses the `open` transition that writes the first tick, so it is the
    // only shape that answers with no samples at all — with the key present.
    expect(byId.get(bare.id)).toEqual([]);

    const risingSpark = byId.get(rising.id)!;
    expect(risingSpark).toHaveLength(SPARKLINE_MAX_POINTS);
    for (let i = 1; i < risingSpark.length; i += 1) {
      expect(risingSpark[i]!).toBeGreaterThanOrEqual(risingSpark[i - 1]!);
    }
    expect(risingSpark.at(-1)).toBe(cardBp.get(rising.id));
    // Three cards, three different series: the correlated seek is bound to each row's own id,
    // not to the first market of the page. Fingerprinted on the OLDEST sample, because the
    // newest is now every card's own probability and these three fixtures share one.
    expect(new Set([quietSpark[0], byId.get(young.id)![0], risingSpark[0]]).size).toBe(3);
  });

  it('keeps the sparkline bounded by the grid, not by the market tick volume', async () => {
    const busy = await market();
    const now = Date.now();
    // One tick older than the window so every bucket has a value in force, then a burst of
    // TICKS_SCAN_MAX + 1 ticks inside the last half hour. The answer is still 25 samples read
    // by 25 index seeks: the card never scans the history the chart route has to cap.
    const values = [
      {
        marketId: busy.id,
        ts: new Date(now - 30 * HOUR_MS),
        pYesBp: 2_000,
        trigger: 'open' as const,
      },
      ...Array.from({ length: TICKS_SCAN_MAX + 1 }, (_, i) => ({
        marketId: busy.id,
        ts: new Date(now - HOUR_MS / 2 + i),
        pYesBp: 4_000 + (i % 3_000),
        trigger: 'trade' as const,
      })),
    ];
    for (let i = 0; i < values.length; i += 1_000) {
      await t.db.insert(schema.priceTicks).values(values.slice(i, i + 1_000));
    }

    const item = (await get('/api/v1/markets')).json<ListPage>().data[0]!;
    expect(item.sparkline).toHaveLength(SPARKLINE_MAX_POINTS);
    // Every bucket but the last predates the burst and carries the anchor; the last one is the
    // newest tick, so the sample is the probability in force at the response instant.
    expect(item.sparkline.slice(0, -1)).toEqual(
      Array.from({ length: SPARKLINE_MAX_POINTS - 1 }, () => 2_000),
    );
    expect(item.sparkline.at(-1)).toBe(4_000 + (TICKS_SCAN_MAX % 3_000));
  });

  it('carries the sparkline on the list card only, never on the detail or the admin list', async () => {
    const open = await market();
    await t.db.insert(schema.priceTicks).values({
      marketId: open.id,
      ts: new Date(Date.now() - 30 * 60 * 1_000),
      pYesBp: 6_100,
      trigger: 'open' as const,
    });

    const item = (await get('/api/v1/markets')).json<ListPage>().data[0]!;
    expect(Object.keys(item)).toContain('sparkline');
    // One bucket, and its sample is the card's own probability — see the grid case above.
    expect(item.sparkline).toEqual([item.pYesBp]);

    // `toMarketSummary`/`toMarket` were left alone, so the shared `MarketSummary` component is
    // not widened: neither the public detail nor the admin list ships a chart it never draws.
    const detail = (await get(`/api/v1/markets/${open.id}`)).json<{ data: Market }>().data;
    expect(detail).not.toHaveProperty('sparkline');

    const admin = await signUpTestUser(t);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, admin.id));
    // The guard caches roles for 60 s (PLAN 10.5); the promotion above happened behind it.
    await t.app.get(AdminGuard).invalidate(admin.id);
    const adminList = await t.app.inject({
      method: 'GET',
      url: '/api/v1/admin/markets',
      headers: { cookie: admin.cookie },
    });
    expect(adminList.statusCode).toBe(200);
    const adminItems = adminList.json<{ data: Record<string, unknown>[] }>().data;
    expect(adminItems.length).toBeGreaterThan(0);
    for (const row of adminItems) expect(row).not.toHaveProperty('sparkline');
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
