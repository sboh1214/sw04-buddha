/**
 * Public market reads (PLAN 7.1, M3 design 3.2) against the docker `test` profile: list
 * filters and the three sort-specific keysets, id/slug lookup, fills, ticks, categories, the
 * market times and '판정 지연' (#22), the rule versions (#80), and the statistics the intake writes
 * with its fills (#121: 시장가격 and its time, the price a day ago, volume, participants; the
 * recent fills and the chart read the fills themselves). Skips when TEST_* are unset.
 */
import { clockTimestamp, schema } from '@buddha/db';
import {
  createCategory,
  createFill,
  createFillRecord,
  createFillSeries,
  createMarket,
  createOpenedMarket,
  createSupplementedMarket,
  createUser,
  fundMarketMakerFunds,
  openOrderIntake,
  placeTestOrder,
  type CreateFillRecordInput,
  type PlaceTestOrderInput,
} from '@buddha/db/test';
import {
  CURSOR_NULL,
  FILLS_RECENT_LIMIT,
  MARKET_SLUG_MAX,
  MARKET_SORTS,
  TICKS_MAX_POINTS,
  TICKS_SCAN_MAX,
  type Category,
  type Fill,
  type Market,
  type MarketSummary,
  PUBLIC_MARKET_STATUSES,
  RULE_ITEMS,
  marketSummarySchema,
  type PriceSeries,
} from '@buddha/shared';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_PARAM_LENGTH } from '../infra/http/fastify-options.js';
import { createTestApp, type TestApp } from '../test/app.js';
import { marketOrder } from './market-order.js';
import { hasTestInfra } from '../test/setup-env.js';

type ListPage = { data: MarketSummary[]; meta: { nextCursor: string | null } };
type MarketRowLike = { id: string; openAt: Date | null };

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** A YES price 1..99 that moves with `i`, for a long price history. */
const yesOf = (i: number) => 1 + (i % 99);
/** `yesOf(i)` as a point's basis points (`yes_price_coin × 100`, #121). */
const bpOf = (i: number) => yesOf(i) * 100;

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

  /**
   * Follows `meta.nextCursor` to the end: every id in page order, and every cursor it followed
   * (each page's but the last).
   */
  async function walkPages(url: string): Promise<{ ids: string[]; cursors: string[] }> {
    const ids: string[] = [];
    const cursors: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await get(cursor ? `${url}&cursor=${encodeURIComponent(cursor)}` : url);
      expect(res.statusCode).toBe(200);
      const page = res.json<ListPage>();
      ids.push(...page.data.map((row) => row.id));
      cursor = page.meta.nextCursor;
      if (cursor) cursors.push(cursor);
      pages += 1;
      if (pages > 50) throw new Error(`cursor never ended for ${url}`);
    } while (cursor);
    return { ids, cursors };
  }

  /**
   * A price history of one-YES fills at `points` (#121: the history is the fills; a read fixture
   * that moves no statistic), between two fresh people.
   */
  async function writeHistory(marketId: string, points: readonly { at: number; yes: number }[]) {
    const incoming = (await createUser(t.db)).user.id;
    const resting = (await createUser(t.db)).user.id;
    return createFillSeries(t.db, {
      marketId,
      incomingOwnerId: incoming,
      restingOwnerId: resting,
      points: points.map((point) => ({ at: new Date(point.at), yesPriceCoin: point.yes })),
    });
  }

  /** `walkPages`' ids alone. */
  async function walk(url: string): Promise<string[]> {
    return (await walkPages(url)).ids;
  }

  it('lists open markets by default, never a draft or a review, and filters by status', async () => {
    const open = await market({ title: '열린 시장' });
    const closed = await market({ title: '마감된 시장', status: 'closed', lastPrice: 62 });
    const draft = await market({ title: '초안', status: 'draft' });
    const review = await market({ title: '검수 중', status: 'review' });

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
      // Never traded: no price and no time, which a client shows as '체결 없음' (N02 §5).
      lastPrice: null,
      lastFillAt: null,
      volumeCoin: '0',
      tradeCount: 0,
      traderCount: 0,
      resolvedResult: null,
    });
    // Nothing of the direct AMM (#125), and nothing the public must not see (PLAN 7.1).
    for (const field of ['pYesBp', 'qYes', 'liquidityB', 'reserveCoin', 'createdBy']) {
      expect(page.data[0]).not.toHaveProperty(field);
    }

    const closedPage = (await get('/api/v1/markets?status=closed')).json<ListPage>();
    expect(closedPage.data.map((row) => row.id)).toEqual([closed.id]);
    expect(closedPage.data[0]).toMatchObject({ lastPrice: 62 });

    // `draft` and `review` are no public status at all (ADR-0093 decision 1 item 12): refused by
    // the schema, not silently empty.
    for (const hidden of ['draft', 'review']) {
      const hiddenPage = await get(`/api/v1/markets?status=${hidden}`);
      expect({ hidden, status: hiddenPage.statusCode }).toEqual({ hidden, status: 400 });
      expect(hiddenPage.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
    for (const status of [...PUBLIC_MARKET_STATUSES, 'all']) {
      const ids = (await get(`/api/v1/markets?status=${status}`)).json<ListPage>().data;
      expect(ids.map((row) => row.id)).not.toContain(draft.id);
      expect(ids.map((row) => row.id)).not.toContain(review.id);
    }
  });

  it('lists a market past its close time until someone closes it (A-M3-31)', async () => {
    // The list filters on status alone, so a market whose close time has passed keeps its
    // `open` status until the worker's close job (or its per-minute scan) closes it — no admin
    // can since #114 — and it stays listed, first under `closing`. If a later milestone hides it
    // here, this is the assertion that says so out loud.
    const expired = await market({
      title: '마감 시각이 지난 시장',
      closeAt: new Date(Date.now() - 60_000),
    });
    const later = await market({ title: '아직 열린 시장', closeAt: new Date(Date.now() + DAY_MS) });

    const page = (await get('/api/v1/markets')).json<ListPage>();
    expect(page.data.map((row) => row.id)).toContain(expired.id);
    const closing = (await get('/api/v1/markets?sort=closing')).json<ListPage>();
    expect(closing.data.map((row) => row.id)).toEqual([expired.id, later.id]);
  });

  it('filters by category slug and searches titles with LIKE wildcards escaped', async () => {
    const weather = await createCategory(t.db, { slug: 'weather', nameKo: '날씨' });
    const rain = await market({ title: '9월 서울 강수량 100mm 초과?', categoryId: weather.id });
    const rate = await market({ title: '기준금리 3% 이하로 인하?' });
    await market({ title: '코스피 3000 돌파?' });

    const byCategory = (await get('/api/v1/markets?category=weather')).json<ListPage>();
    expect(byCategory.data.map((row) => row.id)).toEqual([rain.id]);
    expect((await get('/api/v1/markets?category=nope')).json<ListPage>().data).toHaveLength(0);

    // Two levels: a top-level slug lists what is filed under its leaves as well as under
    // itself; a leaf slug lists its own only; a sibling leaf sees none of it.
    const temperature = await createCategory(t.db, {
      slug: 'temperature',
      nameKo: '기온',
      parentId: weather.id,
    });
    const typhoons = await createCategory(t.db, {
      slug: 'typhoons',
      nameKo: '태풍',
      parentId: weather.id,
    });
    const cold = await market({ title: '11월 서울 영하 5도?', categoryId: temperature.id });
    const list = (category: string) =>
      get(`/api/v1/markets?category=${category}`).then((res) =>
        res.json<ListPage>().data.map((row) => row.id),
      );
    expect((await list('weather')).sort()).toEqual([rain.id, cold.id].sort());
    expect(await list('temperature')).toEqual([cold.id]);
    expect(await list(typhoons.slug)).toEqual([]);
    // The card names the leaf, which is what its header links back to.
    expect(byCategory.data[0]?.category).toEqual({ slug: 'weather', nameKo: '날씨' });
    expect(
      (await get('/api/v1/markets?category=temperature')).json<ListPage>().data[0]?.category,
    ).toEqual({ slug: 'temperature', nameKo: '기온' });

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

  it('searches a tag by its exact name, case and spaces aside, beside the title partial match (#17)', async () => {
    // ADR-0061 decision 1 item 14 / ADR-0066 result 3 / #17 choice 12: `q` is a title holding the
    // term OR a tag named exactly the term (`tagKey`): the detail's tag links search the name.
    const chip = await market({ title: '삼성전자 10만 원 돌파?', tags: ['AI', '반도체 산업'] });
    const titled = await market({ title: '반도체 수출 증가?', tags: ['수출'] });
    const ai = await market({ title: '코스피 3000 돌파?', tags: ['ai'] });
    // A draft with the tag stays hidden, as with a title match.
    await market({ title: '초안', status: 'draft', tags: ['AI'] });
    const ids = async (q: string) => {
      const res = await get(`/api/v1/markets?q=${encodeURIComponent(q)}`);
      expect(res.statusCode, q).toBe(200);
      return res
        .json<ListPage>()
        .data.map((row) => row.id)
        .sort();
    };
    // 'ai' linked the tag 'AI' made first: both markets carry the one tag.
    expect(await ids('AI')).toEqual([chip.id, ai.id].sort());
    expect(await ids('Ai')).toEqual([chip.id, ai.id].sort());
    // Case and the spaces around and inside the term aside, and NFD spelled.
    expect(await ids('  반도체   산업 ')).toEqual([chip.id]);
    expect(await ids('반도체 산업'.normalize('NFD'))).toEqual([chip.id]);
    // Exact, never partial: '반도체' is no tag here, but it is in a title.
    expect(await ids('반도체')).toEqual([titled.id]);
    expect(await ids('산업')).toEqual([]);
    expect(await ids('A')).toEqual([]);
    // A title partial match still works, and either half finds a market once.
    expect(await ids('돌파')).toEqual([chip.id, ai.id].sort());
    expect(await ids('수출')).toEqual([titled.id]);
    // The status filter narrows the tag match too: open by default, every public status on all.
    const closed = await market({ title: '마감된 시장', status: 'closed', tags: ['AI'] });
    expect(await ids('AI')).not.toContain(closed.id);
    const all = await get(`/api/v1/markets?status=all&q=AI`);
    expect(
      all
        .json<ListPage>()
        .data.map((row) => row.id)
        .sort(),
    ).toEqual([chip.id, ai.id, closed.id].sort());
    // Cards carry no tags (the detail does).
    expect(all.json<ListPage>().data[0]).not.toHaveProperty('tags');
  });

  it('searches every public status with status=all, never a draft or a review, and filters within it (#15)', async () => {
    // The search screen (ADR-0066): it starts on every public status (ADR-0061 decision 1, item
    // 13), and a closed market is found through the status filter (N02 §3); one filter per public
    // status, CANCELLED included (ADR-0093 decision 3). One market per status, each titled with the
    // word searched; a draft and a review with the word, and an open market without it.
    const weather = await createCategory(t.db, { slug: 'weather', nameKo: '날씨' });
    const byStatus = {
      scheduled: await market({ title: '금리 동결? (개장 예정)', status: 'scheduled' }),
      open: await market({ title: '금리 동결? (거래 중)', closeAt: new Date(Date.now() + DAY_MS) }),
      paused: await market({ title: '금리 동결? (일시 중단)', status: 'paused' }),
      closed: await market({
        title: '금리 인하? (마감)',
        status: 'closed',
        categoryId: weather.id,
      }),
      provisional: await market({
        title: '금리 인상? (잠정)',
        status: 'provisional',
        resolvedResult: 'YES',
      }),
      resolved: await market({
        title: '금리 인상? (확정)',
        status: 'resolved',
        resolvedResult: 'NO',
      }),
      settling: await market({
        title: '금리 3%? (지급 중)',
        status: 'settling',
        resolvedResult: 'YES',
      }),
      settled: await market({
        title: '금리 3%? (지급 완료)',
        status: 'settled',
        resolvedResult: 'VOID',
      }),
      cancelled: await market({ title: '금리 2%? (취소)', status: 'cancelled' }),
    } satisfies Record<(typeof PUBLIC_MARKET_STATUSES)[number], unknown>;
    const draft = await market({ title: '금리 초안', status: 'draft' });
    const review = await market({ title: '금리 검수', status: 'review' });
    await market({ title: '코스피 3000 돌파?' });
    const ids = async (query: string) => {
      const res = await get(`/api/v1/markets?${query}`);
      expect(res.statusCode, query).toBe(200);
      return res.json<ListPage>().data.map((row) => row.id);
    };
    const term = encodeURIComponent('금리');

    const all = await ids(`status=all&q=${term}`);
    expect(all.sort()).toEqual(
      Object.values(byStatus)
        .map((row) => row.id)
        .sort(),
    );
    expect(all).not.toContain(draft.id);
    expect(all).not.toContain(review.id);
    // Without a term too: every public market, the unmatched one included, and still no draft.
    const everything = await ids('status=all&limit=100');
    expect(everything).toHaveLength(PUBLIC_MARKET_STATUSES.length + 1);
    expect(everything).not.toContain(draft.id);
    expect(everything).not.toContain(review.id);
    // Each status on its own finds its market — the closed one by 거래 마감 as the screen asks.
    for (const [status, row] of Object.entries(byStatus)) {
      expect(await ids(`status=${status}&q=${term}`), status).toEqual([row.id]);
    }
    // The category narrows the same search, and the orders all take it (paging included).
    expect(await ids(`status=all&q=${term}&category=weather`)).toEqual([byStatus.closed.id]);
    for (const sort of MARKET_SORTS) {
      const paged = await walk(`/api/v1/markets?status=all&q=${term}&sort=${sort}&limit=2`);
      expect(paged.sort(), sort).toEqual(all.sort());
    }
    // The home's request is unchanged: no status is `open`, and a word no title holds is an
    // empty page, not an error.
    expect(await ids(`q=${term}`)).toEqual([byStatus.open.id]);
    expect(await ids(`status=all&q=${encodeURIComponent('없는말zzz')}`)).toEqual([]);
    expect((await get('/api/v1/markets?status=everything')).statusCode).toBe(400);
  });

  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  it('orders 마감 임박 with ended markets listed: not closed yet first, soonest first, then ended, latest close first (ADR-0066)', async () => {
    // Owner decision 2026-10-16 (ADR-0066): "진행 중 먼저, 끝난 것은 최근 순", generalised by #174:
    // on a list that can hold ended markets — 모든 상태, or an ended status — the markets whose
    // STATUS has not closed yet (SCHEDULED, OPEN, PAUSED) come first, by the close time, soonest
    // first; every other public market after them, by the close time, the latest first. Ended is
    // the status, not the clock: a market an admin closed early keeps its future close_at and is
    // with the ended ones (first among them, by that close time), and an open market whose close
    // time has passed is not closed still. One such status alone is the home's order, as it was.
    const now = Date.now();
    const term = encodeURIComponent('환율');
    const rows = {
      openPastClose: await market({
        title: '환율 1420? (마감 시각 지남, 거래 중)',
        closeAt: new Date(now - HOUR_MS),
      }),
      scheduledSoon: await market({
        title: '환율 1440? (개장 예정)',
        status: 'scheduled',
        closeAt: new Date(now + 6 * HOUR_MS),
      }),
      openTomorrow: await market({ title: '환율 1450? (내일)', closeAt: new Date(now + DAY_MS) }),
      openLater: await market({ title: '환율 1500? (모레)', closeAt: new Date(now + 2 * DAY_MS) }),
      pausedLatest: await market({
        title: '환율 1550? (일시 중단)',
        status: 'paused',
        closeAt: new Date(now + 3 * DAY_MS),
      }),
      closedEarly: await market({
        title: '환율 1400? (일찍 마감)',
        status: 'closed',
        closeAt: new Date(now + 12 * HOUR_MS),
      }),
      resolvedLastWeek: await market({
        title: '환율 1380? (판정)',
        status: 'resolved',
        resolvedResult: 'YES',
        closeAt: new Date(now - 7 * DAY_MS),
      }),
      closedLastMonth: await market({
        title: '환율 1350? (마감)',
        status: 'closed',
        closeAt: new Date(now - 30 * DAY_MS),
      }),
      settledLongAgo: await market({
        title: '환율 1300? (정산)',
        status: 'settled',
        closeAt: new Date(now - 60 * DAY_MS),
      }),
    };
    // Two ties, one in each group, broken by the id: the boundary of a page falls inside each.
    const tiedOpen = [
      await market({ title: '환율 1460? (동점 가)', closeAt: new Date(now + DAY_MS + HOUR_MS) }),
      await market({ title: '환율 1460? (동점 나)', closeAt: new Date(now + DAY_MS + HOUR_MS) }),
    ].sort(byId);
    const tiedEnded = [
      await market({
        title: '환율 1360? (동점 취소)',
        status: 'cancelled',
        closeAt: new Date(now - 10 * DAY_MS),
      }),
      await market({
        title: '환율 1360? (동점 마감)',
        status: 'closed',
        closeAt: new Date(now - 10 * DAY_MS),
      }),
    ].sort(byId);
    await market({ title: '환율 초안', status: 'draft', closeAt: new Date(now + HOUR_MS) });
    await market({ title: '환율 검수', status: 'review', closeAt: new Date(now + HOUR_MS) });
    const ids = async (query: string) => {
      const res = await get(`/api/v1/markets?${query}`);
      expect(res.statusCode, query).toBe(200);
      return res.json<ListPage>().data.map((row) => row.id);
    };

    const expected = [
      rows.openPastClose.id,
      rows.scheduledSoon.id,
      rows.openTomorrow.id,
      ...tiedOpen.map((row) => row.id),
      rows.openLater.id,
      rows.pausedLatest.id,
      rows.closedEarly.id,
      rows.resolvedLastWeek.id,
      ...tiedEnded.map((row) => row.id),
      rows.closedLastMonth.id,
      rows.settledLongAgo.id,
    ];
    expect(await ids(`status=all&q=${term}&sort=closing&limit=100`)).toEqual(expected);
    // Paged, the same order with nothing repeated or skipped, whatever the page size: pages of one
    // put a cursor on every row, the last one not closed yet and the first ended one included, and
    // the cursor says which group it is in — SCHEDULED and PAUSED in the first (#174).
    for (const limit of [1, 2, 3, 4, 5]) {
      const { ids: paged, cursors } = await walkPages(
        `/api/v1/markets?status=all&q=${term}&sort=closing&limit=${limit}`,
      );
      expect({ limit, paged }).toEqual({ limit, paged: expected });
      if (limit === 1) {
        expect(cursors.map((cursor) => cursor.split('_')[0])).toEqual([
          ...Array.from({ length: 7 }, () => '0'),
          ...Array.from({ length: 5 }, () => '1'),
        ]);
      }
    }
    // An ended status alone is the ended group: the latest close first.
    expect(await ids(`status=closed&q=${term}&sort=closing`)).toEqual([
      rows.closedEarly.id,
      ...tiedEnded.filter((row) => row.status === 'closed').map((row) => row.id),
      rows.closedLastMonth.id,
    ]);
    expect(await walk(`/api/v1/markets?status=closed&q=${term}&sort=closing&limit=1`)).toEqual(
      await ids(`status=closed&q=${term}&sort=closing`),
    );
    // 거래 중 (`open`) alone is the home's order and the home's cursor, `<millis>_<uuid>`.
    const openOnly = [
      rows.openPastClose.id,
      rows.openTomorrow.id,
      ...tiedOpen.map((row) => row.id),
      rows.openLater.id,
    ];
    expect(await ids(`status=open&q=${term}&sort=closing`)).toEqual(openOnly);
    const home = await walkPages(`/api/v1/markets?q=${term}&sort=closing&limit=2`);
    expect(home.ids).toEqual(openOnly);
    expect(home.cursors[0]).toBe(
      `${String(rows.openTomorrow.closeAt.getTime())}_${rows.openTomorrow.id}`,
    );
    // So is any other one status not closed yet (#174): the search's 개장 예정 and 거래 일시
    // 중단 page on the same `<millis>_<uuid>` keyset as the home.
    for (const [status, row] of [
      ['scheduled', rows.scheduledSoon],
      ['paused', rows.pausedLatest],
    ] as const) {
      const later = await market({
        title: `환율 1600? (${status} 나중)`,
        status,
        closeAt: new Date(now + 5 * DAY_MS),
      });
      const single = await walkPages(
        `/api/v1/markets?status=${status}&q=${term}&sort=closing&limit=1`,
      );
      expect({ status, ids: single.ids }).toEqual({ status, ids: [row.id, later.id] });
      expect({ status, cursors: single.cursors }).toEqual({
        status,
        cursors: [`${String(row.closeAt.getTime())}_${row.id}`],
      });
    }
  });

  /** 신규 in JS, for the expectations (ADR-0065): latest opening first, none last, then the id. */
  const latestOpening = (a: MarketRowLike, b: MarketRowLike) => {
    const opened = (row: MarketRowLike) => row.openAt?.getTime() ?? -Infinity;
    return opened(a) === opened(b) ? byId(b, a) : opened(b) > opened(a) ? 1 : -1;
  };

  it('paginates every sort without gaps or repeats across 27 markets with ties', async () => {
    // Ties on every key — the 24-hour volume, the open time and the close time — so a page
    // boundary falls inside a tie for each order: the id half of the keyset is what keeps it
    // from skipping or repeating a row. One public market has no open time and no fill: 신규 puts
    // it last, and so does 추천 here only because it is untraded — the open time is 추천's
    // tie-break, so it is last among the markets of its own 24-hour volume (the next test has a
    // traded one ahead of untraded ones). Pages of 7 over 27 rows end inside a tie on each key.
    const now = await clockTimestamp(t.db);
    const base = now.getTime();
    const taker = (await createUser(t.db)).user.id;
    const maker = (await createUser(t.db)).user.id;
    const volume = new Map<string, bigint>();
    for (let i = 0; i < 26; i += 1) {
      const m = await market({
        openAt: new Date(base - 10 * DAY_MS + Math.floor(i / 4) * HOUR_MS),
        closeAt: new Date(base + DAY_MS + Math.floor(i / 3) * HOUR_MS),
        // The lifetime volume the card carried, ordered the other way round: 추천 must not
        // read it (ADR-0061 decision 1, item 9 — the last 24 hours).
        volumeCoin: BigInt(i * 7_000),
      });
      const amount = BigInt(Math.floor((25 - i) / 2) * 1_000);
      volume.set(m.id, amount);
      if (amount === 0n) continue;
      // Two fills for some, so the volume is a SUM and not the last fill's amount.
      const parts = i % 5 === 0 ? [amount / 2n, amount - amount / 2n] : [amount];
      for (const amountCoin of parts) {
        await createFill(t.db, {
          marketId: m.id,
          amountCoin,
          createdAt: new Date(base - HOUR_MS),
          userId: taker,
          makerId: maker,
        });
      }
    }
    const unopened = await market({ openAt: null, closeAt: new Date(base + 2 * DAY_MS) });
    volume.set(unopened.id, 0n);
    await market({ status: 'draft' }); // never listed, whatever the sort
    const open = (await t.db.select().from(schema.markets)).filter((row) => row.status === 'open');
    expect(open).toHaveLength(27);

    const expected = {
      recommended: [...open]
        .sort((a, b) => {
          const va = volume.get(a.id)!;
          const vb = volume.get(b.id)!;
          return va === vb ? latestOpening(a, b) : va > vb ? -1 : 1;
        })
        .map((row) => row.id),
      newest: [...open].sort(latestOpening).map((row) => row.id),
      closing: [...open]
        .sort((a, b) => a.closeAt.getTime() - b.closeAt.getTime() || byId(a, b))
        .map((row) => row.id),
    };
    expect(expected.recommended.at(-1)).toBe(unopened.id);
    expect(expected.newest.at(-1)).toBe(unopened.id);

    for (const sort of MARKET_SORTS) {
      const ids = await walk(`/api/v1/markets?sort=${sort}&limit=7`);
      expect({ sort, count: ids.length }).toEqual({ sort, count: 27 });
      expect({ sort, unique: new Set(ids).size }).toEqual({ sort, unique: 27 });
      expect({ sort, ids }).toEqual({ sort, ids: expected[sort] });
      // Every public status, where 마감 임박 pages on its group and the signed close time
      // (ADR-0066): with nothing ended, the same order through the same ties.
      const everyStatus = await walk(`/api/v1/markets?status=all&sort=${sort}&limit=7`);
      expect({ sort, everyStatus }).toEqual({ sort, everyStatus: expected[sort] });
    }
    // The default sort is 추천 (ADR-0061 decision 1, item 10).
    expect((await get('/api/v1/markets?limit=3')).json<ListPage>().data.map((r) => r.id)).toEqual(
      expected.recommended.slice(0, 3),
    );
  });

  it('counts 추천 over the last 24 hours of fills only, ties by the latest opening', async () => {
    const now = (await clockTimestamp(t.db)).getTime();
    const fill = (marketId: string, amountCoin: bigint, ageMs: number) =>
      createFill(t.db, { marketId, amountCoin, createdAt: new Date(now - ageMs) });
    // In the window by a minute, and out of it by a minute: the old fill is the larger one.
    const recent = await market({ openAt: new Date(now - 3 * DAY_MS) });
    await fill(recent.id, 500n, DAY_MS - 60_000);
    await fill(recent.id, 10_000n, DAY_MS + 60_000);
    // A lifetime volume far above everything else, all of it older than a day.
    const old = await market({ openAt: new Date(now - 3 * DAY_MS), volumeCoin: 1_000_000n });
    await fill(old.id, 1_000_000n, 2 * DAY_MS);
    const fresh = await market({ openAt: new Date(now - 3 * DAY_MS) });
    await fill(fresh.id, 300n, 60_000);
    // No fill at all: 0, ordered among themselves by the actual open time, latest first, and the
    // one with none last.
    const openedLater = await market({ openAt: new Date(now - HOUR_MS) });
    const openedEarlier = await market({ openAt: new Date(now - 2 * HOUR_MS) });
    // No open time: after every market of its volume that has one, then by the id. Three of them,
    // so a page of one ends on an unopened market with another still to come and its cursor says
    // `null` for the open time (`CURSOR_NULL`); one of them traded, so such a cursor also falls
    // between two volumes. No public market lacks an open time on today's paths (market-order.ts),
    // so this is the one place the NULL cursor reaches the database.
    const unopenedTraded = await market({ openAt: null });
    await fill(unopenedTraded.id, 300n, 60_000);
    const unopened = [await market({ openAt: null }), await market({ openAt: null })]
      .map((row) => row.id)
      .sort()
      .reverse();
    // A fill of another status's market changes nothing here.
    const closed = await market({ status: 'closed' });
    await fill(closed.id, 9_000n, 60_000);

    const expected = [
      recent.id,
      fresh.id,
      unopenedTraded.id,
      openedLater.id,
      openedEarlier.id,
      old.id,
      ...unopened,
    ];
    const page = (await get('/api/v1/markets?sort=recommended')).json<ListPage>();
    expect(page.data.map((row) => row.id)).toEqual(expected);
    // Page by page, the same order: each unopened market exactly once, the walk carrying on past
    // every one of them — a NULL cursor read as any time at all would repeat or loop.
    const paged = await walkPages('/api/v1/markets?sort=recommended&limit=1');
    expect(paged.ids).toEqual(expected);
    const unopenedCursors = paged.cursors
      .map((cursor) => cursor.split('_'))
      .filter((parts) => parts[2] === CURSOR_NULL)
      .map((parts) => ({ volume: parts[1], id: parts[3] }));
    expect(unopenedCursors).toEqual([
      { volume: '300', id: unopenedTraded.id },
      { volume: '0', id: unopened[0] },
    ]);
    // The card still carries the lifetime volume the detail shows; 추천 only orders by the day's.
    expect(page.data.find((row) => row.id === old.id)?.volumeCoin).toBe('1000000');
    // The status filter applies as before.
    expect(
      (await get('/api/v1/markets?sort=recommended&status=closed')).json<ListPage>().data,
    ).toEqual([expect.objectContaining({ id: closed.id })]);
  });

  it('counts 추천 over (asOf − 24h, asOf]: a fill exactly a day before the window end is out, one at it is in', async () => {
    // A hand-made cursor names the window end (ADR-0065: any cursor that decodes is legal), so
    // fills can sit on its two edges to the millisecond. The rest of it sorts after every market
    // — the largest int8 volume, the last open time a cursor may name, the largest uuid — so its
    // page is the whole list counted at `windowEnd`.
    const now = (await clockTimestamp(t.db)).getTime();
    const windowEnd = now - 2 * HOUR_MS;
    const openAt = new Date(now - 3 * DAY_MS);
    const atStart = await market({ openAt });
    await createFill(t.db, {
      marketId: atStart.id,
      amountCoin: 1_000n,
      createdAt: new Date(windowEnd - DAY_MS),
    });
    const justInside = await market({ openAt });
    await createFill(t.db, {
      marketId: justInside.id,
      amountCoin: 10n,
      createdAt: new Date(windowEnd - DAY_MS + 1),
    });
    const atEnd = await market({ openAt });
    await createFill(t.db, {
      marketId: atEnd.id,
      amountCoin: 100n,
      createdAt: new Date(windowEnd),
    });
    const justAfter = await market({ openAt });
    await createFill(t.db, {
      marketId: justAfter.id,
      amountCoin: 10_000n,
      createdAt: new Date(windowEnd + 1),
    });

    const cursor = [
      String(windowEnd),
      '9223372036854775807',
      '253402300799999',
      'ffffffff-ffff-4fff-bfff-ffffffffffff',
    ].join('_');
    const res = await get(`/api/v1/markets?sort=recommended&cursor=${encodeURIComponent(cursor)}`);
    expect(res.statusCode).toBe(200);
    // The fill at the window end counts and the one a millisecond inside the start does; the
    // one exactly a day before the end and the one after it do not, so those two markets have
    // 0 and tie, the same open time, by the id.
    expect(res.json<ListPage>().data.map((row) => row.id)).toEqual([
      atEnd.id,
      justInside.id,
      ...[atStart.id, justAfter.id].sort().reverse(),
    ]);
  });

  it('pages 추천 over the window of its first page, so a moving clock or a new fill cannot repeat or skip a market', async () => {
    const now = (await clockTimestamp(t.db)).getTime();
    // A fill that leaves the 24-hour window about a second from now: in it when the first page
    // is read, out of it by the time the second is.
    const leaving = await market({ openAt: new Date(now - 3 * HOUR_MS) });
    await createFill(t.db, {
      marketId: leaving.id,
      amountCoin: 700n,
      createdAt: new Date(now - DAY_MS + 1_000),
    });
    const steady = await market({ openAt: new Date(now - 2 * HOUR_MS) });
    await createFill(t.db, { marketId: steady.id, amountCoin: 500n, createdAt: new Date(now) });
    const idle = await market({ openAt: new Date(now - HOUR_MS) });

    const first = (await get('/api/v1/markets?sort=recommended&limit=1')).json<ListPage>();
    expect(first.data.map((row) => row.id)).toEqual([leaving.id]);
    const cursor = first.meta.nextCursor!;
    // The cursor carries the window end the first page was counted at (ADR-0065).
    const asOf = Number(cursor.split('_')[0]);
    expect(asOf).toBeGreaterThan(now - 1_000);

    // The first fill ages out, and a new one lands on the idle market after the first page.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    await createFill(t.db, {
      marketId: idle.id,
      amountCoin: 2_000n,
      createdAt: new Date(asOf + 1_000),
    });
    expect((await clockTimestamp(t.db)).getTime()).toBeGreaterThan(now + 1_000);

    // Counted live, the second page would hold `leaving` again (now 0, after the cursor's 700)
    // and lose `idle` (now 2,000, before it). Over the first page's window it is the rest of
    // that page's order.
    const rest: string[] = [];
    let next: string | null = cursor;
    while (next !== null) {
      const page: ListPage = (
        await get(`/api/v1/markets?sort=recommended&limit=1&cursor=${encodeURIComponent(next)}`)
      ).json<ListPage>();
      rest.push(...page.data.map((row) => row.id));
      next = page.meta.nextCursor;
    }
    expect(rest).toEqual([steady.id, idle.id]);

    // A first page read now counts the window of now.
    const fresh = (await get('/api/v1/markets?sort=recommended')).json<ListPage>();
    expect(fresh.data.map((row) => row.id)).toEqual([idle.id, steady.id, leaving.id]);
  });

  it('orders 신규 by the actual open time, not by when the market was made', async () => {
    const now = (await clockTimestamp(t.db)).getTime();
    // Made first, opened last: an admin who opens a draft a week after writing it.
    const madeFirst = await market({ openAt: new Date(now - HOUR_MS) });
    const madeSecond = await market({ openAt: new Date(now - 2 * HOUR_MS) });
    const unopened = [await market({ openAt: null })];
    const madeLast = await market({ openAt: new Date(now - 3 * HOUR_MS) });
    expect(madeLast.createdAt.getTime()).toBeGreaterThanOrEqual(madeFirst.createdAt.getTime());
    // No open time: after every market that has one, by the id. Three, so pages of one end on an
    // unopened market with more to come, and the cursor says `null` for its open time
    // (`CURSOR_NULL`, '-infinity' in the predicate): the walk must carry on past each one, once.
    unopened.push(await market({ openAt: null }), await market({ openAt: null }));
    const unopenedIds = unopened
      .map((row) => row.id)
      .sort()
      .reverse();

    const { ids, cursors } = await walkPages('/api/v1/markets?sort=newest&limit=1');
    expect(ids).toEqual([madeFirst.id, madeSecond.id, madeLast.id, ...unopenedIds]);
    expect(cursors.filter((cursor) => cursor.startsWith(`${CURSOR_NULL}_`))).toEqual(
      unopenedIds.slice(0, 2).map((id) => `${CURSOR_NULL}_${id}`),
    );
  });

  it('reads 신규 off markets_status_open_at_id_idx, its cursor an Index Cond (migration 0024)', async () => {
    // The index holds `coalesce(open_at, '-infinity')` and market-order.ts spells the same
    // expression in another package; if the two drifted apart the planner could no longer use
    // the index, and a deep page would scan every open market before it. A handful of rows
    // never makes an index the cheapest plan, so sequential and bitmap scans are switched off
    // for this one transaction: what is left is whether the index CAN serve the page.
    const now = (await clockTimestamp(t.db)).getTime();
    for (let i = 0; i < 3; i += 1) await market({ openAt: new Date(now - i * HOUR_MS) });
    const plan = await t.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      await tx.execute(sql`SET LOCAL enable_bitmapscan = off`);
      const order = marketOrder(tx, 'newest', `${String(now)}_${randomUUID()}`, 'open');
      const query = tx
        .select({ id: schema.markets.id })
        .from(schema.markets)
        .where(and(eq(schema.markets.status, 'open'), order.after))
        .orderBy(...order.orderBy)
        .limit(21);
      const { rows } = await tx.execute<{ 'QUERY PLAN': string }>(
        sql`EXPLAIN SELECT * FROM (${query}) AS page`,
      );
      return rows.map((row) => row['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain('markets_status_open_at_id_idx');
    expect(plan).toMatch(/Index Cond: .*ROW\(COALESCE\(open_at/);
    expect(plan).not.toContain('Sort');
  });

  it('refuses the volume order: it is gone until #132 (ADR-0061 decision 1, item 11)', async () => {
    const res = await get('/api/v1/markets?sort=volume');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('serves the first page for a malformed or foreign cursor instead of a 500', async () => {
    await market();
    const uuid = randomUUID();
    const malformed = [
      '0_not-a-uuid',
      'x_y',
      `99999999999999999999_${uuid}`,
      // A time in year 10000: a Date, but its ISO form ('+010000-01-01T…') is one Postgres
      // refuses as a timestamptz (22009), so it must not get past the decoder — for 마감 임박's
      // close time and 신규's open time.
      `253402300800000_${uuid}`,
      // 추천's shape with one part wrong each: a volume past int8, a window end past the last
      // Date and in year 10000, an open time in year 10000, a NULL where no NULL may be, a part
      // missing.
      `1788408306789_9223372036854775808_null_${uuid}`,
      `8640000000000001_0_null_${uuid}`,
      `253402300800000_0_null_${uuid}`,
      `1788408306789_0_253402300800000_${uuid}`,
      `null_0_null_${uuid}`,
      `1788408306789_0_${uuid}`,
    ];
    for (const sort of MARKET_SORTS) {
      for (const cursor of malformed) {
        const res = await get(`/api/v1/markets?sort=${sort}&cursor=${encodeURIComponent(cursor)}`);
        expect({ sort, cursor, status: res.statusCode }).toEqual({ sort, cursor, status: 200 });
        expect({ sort, cursor, rows: res.json<ListPage>().data.length }).toEqual({
          sort,
          cursor,
          rows: 1,
        });
      }
    }
    // Another order's cursor of another shape is malformed for this one: 신규's for 추천, 추천's
    // for 신규 and 마감 임박.
    const foreign = [
      { sort: 'recommended', cursor: `1788408306789_${uuid}` },
      { sort: 'newest', cursor: `1788408306789_0_null_${uuid}` },
      { sort: 'closing', cursor: `1788408306789_0_null_${uuid}` },
    ];
    for (const { sort, cursor } of foreign) {
      const res = await get(`/api/v1/markets?sort=${sort}&cursor=${encodeURIComponent(cursor)}`);
      expect({ sort, rows: res.json<ListPage>().data.length }).toEqual({ sort, rows: 1 });
    }
    // On a list that can hold ended markets (`status=all`, ADR-0066) the malformed cursors above
    // serve every order's first page too, and 마감 임박 pages on `<group>_<closeAt>_<uuid>`: a
    // group other than 0 or 1, a close time past year 9999 or below zero, an id that is no uuid,
    // and the home's `<millis>_<uuid>` (a part short) and 추천's cursor (no group first) serve its
    // first page; so does the grouped cursor on the home (a part too many), below.
    const grouped = [
      `2_1788408306789_${uuid}`,
      `null_1788408306789_${uuid}`,
      `0_253402300800000_${uuid}`,
      `1_-1_${uuid}`,
      `0_1788408306789_not-a-uuid`,
      `1788408306789_${uuid}`,
      `1788408306789_0_null_${uuid}`,
    ];
    const cases = [
      ...MARKET_SORTS.flatMap((sort) => malformed.map((cursor) => ({ sort, cursor }))),
      ...grouped.map((cursor) => ({ sort: 'closing', cursor })),
    ];
    for (const { sort, cursor } of cases) {
      const res = await get(
        `/api/v1/markets?status=all&sort=${sort}&cursor=${encodeURIComponent(cursor)}`,
      );
      expect({ sort, cursor, status: res.statusCode }).toEqual({ sort, cursor, status: 200 });
      expect({ sort, cursor, rows: res.json<ListPage>().data.length }).toEqual({
        sort,
        cursor,
        rows: 1,
      });
    }
    for (const cursor of [`0_1788408306789_${uuid}`, `1_1788408306789_${uuid}`]) {
      const res = await get(`/api/v1/markets?sort=closing&cursor=${encodeURIComponent(cursor)}`);
      expect({ cursor, rows: res.json<ListPage>().data.length }).toEqual({ cursor, rows: 1 });
    }
  });

  it('finds a market by id, by slug and by a decomposed (NFD) slug; hides drafts and reviews', async () => {
    const eventDeadline = new Date('2026-12-31T14:59:00.000Z');
    const open = await market({
      slug: '한글-시장-2026',
      title: '한글 시장',
      description: '배경',
      yesCondition: 'YES 조건',
      noCondition: 'NO 조건',
      eventDeadline,
      primarySource: { name: '1차 출처', url: 'https://example.com/primary' },
      fallbackSources: [
        { name: '대체 출처 하나', url: 'https://example.com/one' },
        { name: '대체 출처 둘', url: 'https://example.com/two' },
      ],
      fallbackCondition: '전환 조건',
      longDelayDays: 30,
      delayHandling: '지연·취소·무효 처리',
      tags: ['한국', 'K-팝'],
    });
    const draft = await market({ slug: 'draft-market', status: 'draft' });
    const review = await market({ slug: 'review-market', status: 'review' });

    const byId = await get(`/api/v1/markets/${open.id}`);
    expect(byId.statusCode).toBe(200);
    const detail = byId.json<{ data: Market }>().data;
    expect(detail).toMatchObject({
      id: open.id,
      slug: '한글-시장-2026',
      title: '한글 시장',
      status: 'open',
      resolvedAt: null,
      // In position order, the stored spelling (#17).
      tags: ['한국', 'K-팝'],
    });
    // The rule items, signed out (#23, N02 §2): the sources in priority order, the event deadline
    // an ISO instant. The single rules text and resolution source they replaced are gone.
    const items = Object.fromEntries(RULE_ITEMS.map((item) => [item, detail[item]]));
    expect(items).toEqual({
      description: '배경',
      yesCondition: 'YES 조건',
      noCondition: 'NO 조건',
      eventDeadline: eventDeadline.toISOString(),
      primarySource: { name: '1차 출처', url: 'https://example.com/primary' },
      fallbackSources: [
        { name: '대체 출처 하나', url: 'https://example.com/one' },
        { name: '대체 출처 둘', url: 'https://example.com/two' },
      ],
      fallbackCondition: '전환 조건',
      longDelayDays: 30,
      delayHandling: '지연·취소·무효 처리',
    });
    expect(detail).not.toHaveProperty('rules');
    expect(detail).not.toHaveProperty('resolutionSource');
    // A card carries none of them (the detail does).
    const [card] = (await get(`/api/v1/markets?q=${encodeURIComponent('한글 시장')}`)).json<{
      data: MarketSummary[];
    }>().data;
    expect(card!.id).toBe(open.id);
    for (const item of RULE_ITEMS) expect(card).not.toHaveProperty(item);
    // A market with no source row and no fallback reads null and '없음' (an empty list).
    const bare = await market({ primarySource: null, longDelayDays: null, eventDeadline: null });
    expect((await get(`/api/v1/markets/${bare.id}`)).json<{ data: Market }>().data).toMatchObject({
      primarySource: null,
      fallbackSources: [],
      fallbackCondition: '',
      longDelayDays: null,
      eventDeadline: null,
    });
    expect(detail).not.toHaveProperty('voidedAt');
    // Nothing of the admin detail's open-items check.
    expect(detail).not.toHaveProperty('missingOpenItems');
    // PLAN 7.1: no author on the public detail; and nothing of the direct AMM (#125).
    for (const field of ['createdBy', 'pYesBp', 'qYes', 'qNo', 'liquidityB', 'reserveCoin']) {
      expect(detail).not.toHaveProperty(field);
    }
    expect(detail).toMatchObject({ lastPrice: null, lastFillAt: null, lastPrice24hAgo: null });

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

    // Every other status is public: a SCHEDULED market's detail before it opens (with no open
    // time), and a PAUSED or CANCELLED one's (ADR-0093 decision 1 item 12).
    for (const status of ['scheduled', 'paused', 'cancelled'] as const) {
      const row = await market({ status });
      for (const url of [
        `/api/v1/markets/${row.id}`,
        `/api/v1/markets/${row.id}/fills`,
        `/api/v1/markets/${row.id}/ticks`,
      ]) {
        expect({ url, status: (await get(url)).statusCode }).toEqual({ url, status: 200 });
      }
      expect((await get(`/api/v1/markets/${row.id}`)).json<{ data: Market }>().data).toMatchObject({
        status,
        openAt: status === 'scheduled' ? null : row.openAt!.toISOString(),
      });
    }

    // DRAFT and REVIEW are the admin's alone (ADR-0093 decision 1 item 12): NOT_FOUND, as for an
    // id that does not exist, on the detail and every sub-resource.
    for (const url of [
      `/api/v1/markets/${draft.id}`,
      '/api/v1/markets/draft-market',
      `/api/v1/markets/${review.id}`,
      '/api/v1/markets/review-market',
      `/api/v1/markets/${review.id}/fills`,
      `/api/v1/markets/${review.id}/ticks`,
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

  it('shows the times and the judgement time zone signed out, and 판정 지연 on a closed market past its scheduled judgement (#22)', async () => {
    const at = (days: number) => new Date(Date.now() + days * DAY_MS);
    // Whole minutes, as the admin form writes them; the zone stored as the admin picked it.
    const minute = (date: Date) => new Date(Math.floor(date.getTime() / 60_000) * 60_000);
    const times = {
      scheduledOpenAt: minute(at(-1)),
      closeAt: minute(at(7)),
      scheduledAnnouncementAt: minute(at(8)),
      scheduledJudgementAt: minute(at(9)),
      judgementTimeZone: 'America/New_York',
    };
    const live = await market({ ...times, eventDeadline: minute(at(8)) });
    const detail = (await get(`/api/v1/markets/${live.id}`)).json<{ data: Market }>().data;
    // Public in every public status, signed out (N03 §4: the user sees the judgement time zone).
    expect(detail).toMatchObject({
      scheduledOpenAt: times.scheduledOpenAt.toISOString(),
      closeAt: times.closeAt.toISOString(),
      scheduledAnnouncementAt: times.scheduledAnnouncementAt.toISOString(),
      scheduledJudgementAt: times.scheduledJudgementAt.toISOString(),
      judgementTimeZone: 'America/New_York',
      judgementDelayed: false,
    });
    // Nothing of the admin's: the gap its lead close was checked against is AdminMarket's.
    expect(detail).not.toHaveProperty('leadCloseGapMinutes');
    // '없음' and a market from before #22 read null; nothing is converted (D4).
    const none = await market({ scheduledAnnouncementAt: null });
    const legacy = await market({ blankTimes: true });
    expect((await get(`/api/v1/markets/${none.id}`)).json<{ data: Market }>().data).toMatchObject({
      scheduledAnnouncementAt: null,
      judgementTimeZone: 'Asia/Seoul',
    });
    expect((await get(`/api/v1/markets/${legacy.id}`)).json<{ data: Market }>().data).toMatchObject(
      {
        scheduledOpenAt: null,
        scheduledAnnouncementAt: null,
        scheduledJudgementAt: null,
        judgementTimeZone: null,
        judgementDelayed: false,
      },
    );

    // '판정 지연' (#173 item 11, ADR-0098): CLOSED with the scheduled judgement passed, on the
    // server's clock at the read — no operator record needed. A display, not a status: the card
    // carries it so it needs no time of its own; an open market past its close (A-M3-31), a
    // closed one before its judgement, a judged one and one with no judgement never read it.
    const late = await market({ status: 'closed', closeAt: at(-3), scheduledJudgementAt: at(-1) });
    const due = await market({ status: 'closed', closeAt: at(-1), scheduledJudgementAt: at(1) });
    const lingering = await market({
      status: 'open',
      closeAt: at(-3),
      scheduledJudgementAt: at(-1),
    });
    const judged = await market({
      status: 'resolved',
      resolvedResult: 'YES',
      resolvedAt: at(-1),
      closeAt: at(-3),
      scheduledJudgementAt: at(-2),
    });
    const undated = await market({ status: 'closed', closeAt: at(-3), blankTimes: true });
    const expected = new Map([
      [late.id, true],
      [due.id, false],
      [lingering.id, false],
      [judged.id, false],
      [undated.id, false],
    ]);
    const cards = (await get('/api/v1/markets?status=all&limit=100')).json<ListPage>().data;
    for (const [id, delayed] of expected) {
      const card = cards.find((row) => row.id === id);
      expect({ id, delayed: card?.judgementDelayed }).toEqual({ id, delayed });
      expect(card).not.toHaveProperty('scheduledJudgementAt');
      const shown = (await get(`/api/v1/markets/${id}`)).json<{ data: Market }>().data;
      expect({ id, delayed: shown.judgementDelayed }).toEqual({ id, delayed });
    }
    // No list filters by it (ADR-0095 8-6): the closed list holds a delayed market and one that
    // is not, under the one status.
    const closed = (await get('/api/v1/markets?status=closed')).json<ListPage>().data;
    expect(closed.map((row) => row.id).sort()).toEqual([late.id, due.id, undated.id].sort());
    expect(closed.every((row) => row.status === 'closed')).toBe(true);
  });

  it('shows the current rule version and every version, the newest first, naming nobody; none before the open or for a market opened before #80', async () => {
    // #80, ADR-0101 (ADR-0093 decision 3 '#80 보충의 형태'): v1 from the open, one more per
    // approved supplement; each with its full text, the items it changed, the reason and the time.
    const detailOf = async (idOrSlug: string) => {
      const res = await get(`/api/v1/markets/${idOrSlug}`);
      expect(res.statusCode).toBe(200);
      return { body: res.body, market: res.json<{ data: Market }>().data };
    };
    // Never opened, or opened before #80 (D4): no version, an empty history.
    const scheduled = await market({ status: 'scheduled' });
    const legacy = await market({ status: 'open' });
    for (const id of [scheduled.id, legacy.id]) {
      expect((await detailOf(id)).market).toMatchObject({ ruleVersion: null, ruleVersions: [] });
    }
    // v1 at the open: the text the review locked, no reason, nothing changed.
    const { market: opened } = await createOpenedMarket(t.db, {
      createdBy: creatorId,
      categoryId: category.id,
    });
    const [v1] = await t.db
      .select()
      .from(schema.marketRuleVersions)
      .where(eq(schema.marketRuleVersions.marketId, opened.id));
    expect((await detailOf(opened.slug)).market).toMatchObject({
      ruleVersion: 1,
      ruleVersions: [
        {
          version: 1,
          createdAt: opened.openAt!.toISOString(),
          changedItems: [],
          reason: null,
          content: v1!.content,
        },
      ],
    });
    // v2 and v3 by supplements: the current one first, each the full text then.
    const { market: supplemented, versions } = await createSupplementedMarket(t.db, {
      createdBy: creatorId,
      categoryId: category.id,
      supplements: [
        { changes: { description: '보충한 배경' }, reason: '오탈자 수정' },
        {
          changes: { title: '보충한 제목', yesCondition: '보충한 YES 조건' },
          reason: '뜻을 바꾸지 않고 문장을 다듬는다',
          settlementImpact: '정산 영향 검토는 운영자만 본다',
        },
      ],
    });
    const { body, market: shown } = await detailOf(supplemented.id);
    expect(shown).toMatchObject({
      title: '보충한 제목',
      description: '보충한 배경',
      yesCondition: '보충한 YES 조건',
      ruleVersion: 3,
    });
    expect(shown.ruleVersions.map((version) => [version.version, version.changedItems])).toEqual([
      [3, ['title', 'yesCondition']],
      [2, ['description']],
      [1, []],
    ]);
    expect(shown.ruleVersions[0]).toEqual({
      version: 3,
      createdAt: versions[2]!.createdAt.toISOString(),
      changedItems: ['title', 'yesCondition'],
      reason: '뜻을 바꾸지 않고 문장을 다듬는다',
      content: versions[2]!.content,
    });
    expect(shown.ruleVersions[2]!.content).toEqual(versions[0]!.content);
    // Nobody's name and no settlement impact review: neither key nor value.
    for (const version of shown.ruleVersions) {
      expect(Object.keys(version).sort()).toEqual([
        'changedItems',
        'content',
        'createdAt',
        'reason',
        'version',
      ]);
    }
    for (const version of versions.slice(1)) {
      expect(body).not.toContain(version.requestedBy!);
      expect(body).not.toContain(version.createdBy!);
    }
    expect(body).not.toContain('정산 영향 검토는 운영자만 본다');
    // After the close the history stays public.
    await t.db
      .update(schema.markets)
      .set({ status: 'closed' })
      .where(eq(schema.markets.id, supplemented.id));
    expect((await detailOf(supplemented.id)).market.ruleVersions).toEqual(shown.ruleVersions);
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
    const maker = (await createUser(t.db)).user.id;
    const base = Date.now() - 60 * 60 * 1000;
    // Each a match as the intake records it (#119): the trader's order against the maker's
    // resting one, at 30, 40, 50 or 60 Coin a contract — a NO fill off 50 has a YES price
    // (100 − its price) that differs from its own.
    const written: { id: number; qty: number; outcome: string; priceCoin: number }[] = [];
    for (let i = 0; i < FILLS_RECENT_LIMIT + 5; i += 1) {
      const { fill } = await createFillRecord(t.db, {
        marketId: open.id,
        incomingOwnerId: trader,
        restingOwnerId: maker,
        outcome: i % 2 === 0 ? 'YES' : 'NO',
        side: i % 3 === 0 ? 'sell' : 'buy',
        priceCoin: 30 + (i % 4) * 10,
        qty: i + 1,
        createdAt: new Date(base + i * 1_000),
      });
      written.push({
        id: fill.id,
        qty: fill.qty,
        outcome: fill.outcome,
        priceCoin: fill.priceCoin,
      });
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
    // The contract, its price and its YES value (#121, ADR-0107 결정 6 '남은 것'의 #60
    // 3·6·17·20항): a NO fill at 30 reads 70 on the YES scale; the amount is the contract's price ×
    // qty (#177 12항).
    const shown = written.slice(-FILLS_RECENT_LIMIT).reverse();
    expect(
      fills.map(({ outcome, priceCoin, yesPriceCoin, qty, amountCoin }) => [
        outcome,
        priceCoin,
        yesPriceCoin,
        qty,
        amountCoin,
      ]),
    ).toEqual(
      shown.map((row) => [
        row.outcome,
        row.priceCoin,
        row.outcome === 'NO' ? 100 - row.priceCoin : row.priceCoin,
        row.qty,
        String(row.qty * row.priceCoin),
      ]),
    );
    expect(shown.some((row) => row.outcome === 'NO' && row.priceCoin !== 50)).toBe(true);
    // Anonymous: no order, owner, taker direction or account type of either side.
    for (const fill of fills) {
      expect(Object.keys(fill).sort()).toEqual(
        ['amountCoin', 'createdAt', 'id', 'outcome', 'priceCoin', 'qty', 'yesPriceCoin'].sort(),
      );
    }
  });

  it('carries the 시장가격, its fill time and the statistics the intake wrote, and 체결 없음 before (#121)', async () => {
    await openOrderIntake(t.db, { adminId: creatorId });
    const m = await market({ title: '체결되는 시장' });
    const quiet = await market({ title: '조용한 시장' });
    const member = async () => (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
    const order = async (input: PlaceTestOrderInput) => {
      const result = await placeTestOrder(t.db, input);
      if (result.kind !== 'placed') throw new Error(`expected a placed order, got ${result.kind}`);
      return result;
    };
    const card = async () => {
      const page = (await get('/api/v1/markets?sort=recommended')).json<ListPage>();
      return page.data.find((row) => row.id === m.id)!;
    };
    const detail = async () => (await get(`/api/v1/markets/${m.id}`)).json<{ data: Market }>().data;

    // Before any fill: no price, no time, no baseline, nothing counted, no row, no point.
    const none = {
      lastPrice: null,
      lastFillAt: null,
      volumeCoin: '0',
      tradeCount: 0,
      traderCount: 0,
    };
    expect(await card()).toMatchObject(none);
    expect(await detail()).toMatchObject({ ...none, lastPrice24hAgo: null });
    expect((await get(`/api/v1/markets/${m.id}/fills`)).json<{ data: Fill[] }>().data).toEqual([]);
    expect((await series(`/api/v1/markets/${m.id}/ticks`)).points).toEqual([]);

    // The 운영 마켓메이커 rests a NO bid at 40; a member's IOC YES buy meets it — a pair mint, one
    // fill at its YES value 60 (#177 11·12항). It counts in price and volume, never as a person.
    const mm = await fundMarketMakerFunds(t.db, m.id, 1_000n);
    await order({ ownerId: mm, marketId: m.id, outcome: 'NO', limitPriceCoin: 40, qty: 2 });
    const a = await member();
    const first = await order({
      ownerId: a,
      marketId: m.id,
      timeInForce: 'ioc',
      limitPriceCoin: 65,
    });
    const firstAt = first.fills[0]!.createdAt.toISOString();
    expect(await card()).toMatchObject({
      lastPrice: 60,
      lastFillAt: firstAt,
      volumeCoin: '60',
      tradeCount: 1,
      traderCount: 1,
    });
    // 추천 counts the bot↔member fill: the market with it is ahead of the quiet one.
    const ranked = (await get('/api/v1/markets?sort=recommended')).json<ListPage>().data;
    expect(ranked.map((row) => row.id)).toEqual([m.id, quiet.id]);

    // A member's YES bid at 55 met by another's IOC NO buy: the incoming contract is NO at 45,
    // whose YES value is 55 — one row, the volume +45 (not +100).
    await order({ ownerId: a, marketId: m.id, limitPriceCoin: 55 });
    const b = await member();
    const second = await order({
      ownerId: b,
      marketId: m.id,
      outcome: 'NO',
      timeInForce: 'ioc',
      limitPriceCoin: 99,
    });
    const secondAt = second.fills[0]!.createdAt.toISOString();
    const shown = await detail();
    expect(shown).toMatchObject({
      lastPrice: 55,
      lastFillAt: secondAt,
      volumeCoin: '105',
      tradeCount: 2,
      traderCount: 2,
      // Both fills are minutes old: no 시장가격 a day ago, so no change badge (N02 §5).
      lastPrice24hAgo: null,
    });
    const rows = (await get(`/api/v1/markets/${m.id}/fills`)).json<{ data: Fill[] }>().data;
    expect(
      rows.map(({ outcome, priceCoin, yesPriceCoin, qty, amountCoin }) => ({
        outcome,
        priceCoin,
        yesPriceCoin,
        qty,
        amountCoin,
      })),
    ).toEqual([
      { outcome: 'NO', priceCoin: 45, yesPriceCoin: 55, qty: 1, amountCoin: '45' },
      { outcome: 'YES', priceCoin: 60, yesPriceCoin: 60, qty: 1, amountCoin: '60' },
    ]);
    expect(rows.map((row) => row.createdAt)).toEqual([secondAt, firstAt]);
    // The volume is the sum of the public rows' amounts (#177 12항).
    expect(String(rows.reduce((sum, row) => sum + BigInt(row.amountCoin), 0n))).toBe(
      shown.volumeCoin,
    );
    // No person's or the bot's id anywhere in the public answers.
    const wire = JSON.stringify([rows, shown, await card()]);
    for (const id of [a, b, mm]) expect(wire).not.toContain(id);
    // The chart is the fills: each one's YES value at its time, a trade point, nothing for the
    // open.
    expect((await series(`/api/v1/markets/${m.id}/ticks?resolution=raw`)).points).toEqual([
      { ts: firstAt, pYesBp: 6_000, trigger: 'trade' },
      { ts: secondAt, pYesBp: 5_500, trigger: 'trade' },
    ]);
    expect((await series(`/api/v1/markets/${m.id}/ticks`)).tradeCount).toBe(2);
  });

  it('charts each fill at its YES value on the 1m and 1h grid too: NO fills, a NO pair mint, one intake (#121)', async () => {
    // The product chart reads only the grid (1D → 1m, 1W and all → 1h, apps/web lib/ticks.ts),
    // and its SQL spells the YES value on its own, apart from the raw path's. Every other grid
    // case is YES fills, where the contract price and the YES value are the same number.
    const history = await market();
    const incoming = (await createUser(t.db)).user.id;
    const resting = (await createUser(t.db)).user.id;
    const t0 = new Date('2026-09-01T00:00:00.000Z').getTime();
    const record = (at: number, fill: Partial<CreateFillRecordInput>) =>
      createFillRecord(t.db, {
        marketId: history.id,
        incomingOwnerId: incoming,
        restingOwnerId: resting,
        createdAt: new Date(at),
        ...fill,
      });
    // A NO buy at 45 against a resting NO sell (YES 55), an incoming NO pair mint at 30 against a
    // YES bid at 70 (YES 70), a NO sell at 20 into a NO bid (YES 80).
    await record(t0, { outcome: 'NO', side: 'buy', kind: 'trade', priceCoin: 45 });
    await record(t0 + MINUTE_MS, { outcome: 'NO', side: 'buy', kind: 'pair_mint', priceCoin: 30 });
    await record(t0 + 2 * MINUTE_MS, { outcome: 'NO', side: 'sell', priceCoin: 20 });
    const byMinute = await series(
      `/api/v1/markets/${history.id}/ticks?from=${iso(t0)}&to=${iso(t0 + 3 * MINUTE_MS)}&resolution=1m`,
    );
    expect(byMinute.points).toEqual([
      { ts: iso(t0), pYesBp: 5_500, trigger: 'trade' },
      { ts: iso(t0 + MINUTE_MS), pYesBp: 7_000, trigger: 'trade' },
      { ts: iso(t0 + 2 * MINUTE_MS), pYesBp: 8_000, trigger: 'trade' },
      { ts: iso(t0 + 3 * MINUTE_MS), pYesBp: 8_000, trigger: 'trade' },
    ]);
    const byHour = await series(
      `/api/v1/markets/${history.id}/ticks?from=${iso(t0)}&to=${iso(t0 + HOUR_MS)}&resolution=1h`,
    );
    expect(byHour.points).toEqual([
      { ts: iso(t0), pYesBp: 5_500, trigger: 'trade' },
      { ts: iso(t0 + HOUR_MS), pYesBp: 8_000, trigger: 'trade' },
    ]);

    // One real intake whose fills share its instant: a member's IOC NO buy for 2 meets two YES
    // bids, the 55 first (NO 45) and then the 52 (NO 48) — two pair mints. The grid picks the
    // later fill (the larger id) at that instant, the 시장가격 the statistics writer stored: 52.
    await openOrderIntake(t.db, { adminId: creatorId });
    const live = await market();
    const bidder = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
    const taker = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
    for (const limitPriceCoin of [55, 52]) {
      const rested = await placeTestOrder(t.db, {
        ownerId: bidder,
        marketId: live.id,
        limitPriceCoin,
      });
      expect(rested.kind).toBe('placed');
    }
    const walked = await placeTestOrder(t.db, {
      ownerId: taker,
      marketId: live.id,
      outcome: 'NO',
      timeInForce: 'ioc',
      limitPriceCoin: 99,
      qty: 2,
    });
    if (walked.kind !== 'placed') throw new Error(`expected a placed order, got ${walked.kind}`);
    expect(walked.fills.map((fill) => [fill.priceCoin, fill.yesPriceCoin])).toEqual([
      [45, 55],
      [48, 52],
    ]);
    expect(new Set(walked.fills.map((fill) => fill.createdAt.getTime())).size).toBe(1);
    const { lastPrice } = (await get(`/api/v1/markets/${live.id}`)).json<{ data: Market }>().data;
    expect(lastPrice).toBe(52);
    for (const resolution of ['1m', '1h'] as const) {
      const { points } = await series(`/api/v1/markets/${live.id}/ticks?resolution=${resolution}`);
      expect(points.length, resolution).toBeGreaterThan(0);
      expect(new Set(points.map((point) => point.pYesBp)), resolution).toEqual(new Set([5_200]));
    }
  });

  it('carries the 시장가격 as of 24 hours ago on the detail: the last fill by then, else null (#121)', async () => {
    const now = Date.now();
    const m = await market({ lastPrice: 70 });
    await writeHistory(m.id, [
      { at: now - 26 * HOUR_MS, yes: 35 },
      { at: now - 25 * HOUR_MS, yes: 40 },
      { at: now - 23 * HOUR_MS, yes: 70 },
    ]);
    const detailOf = async (id: string) =>
      (await get(`/api/v1/markets/${id}`)).json<{ data: Market }>().data;
    expect((await detailOf(m.id)).lastPrice24hAgo).toBe(40);
    // A card carries none: the change badge is the detail's (ADR-0107 결정 4 '변화량').
    const [card] = (await get('/api/v1/markets')).json<ListPage>().data;
    expect(card).not.toHaveProperty('lastPrice24hAgo');
    // Only fills within the day: no baseline — the open's 50% never is one.
    const young = await market({ lastPrice: 70 });
    await writeHistory(young.id, [{ at: now - 23 * HOUR_MS, yes: 70 }]);
    expect((await detailOf(young.id)).lastPrice24hAgo).toBeNull();
    // Carried whatever the status: the screen decides where the badge shows.
    const closed = await market({ status: 'closed', lastPrice: 61 });
    await writeHistory(closed.id, [{ at: now - 30 * HOUR_MS, yes: 61 }]);
    expect((await detailOf(closed.id)).lastPrice24hAgo).toBe(61);
    // The open writes no fill, so a market just opened has no point and no baseline.
    const { market: opened } = await createOpenedMarket(t.db, {
      createdBy: creatorId,
      categoryId: category.id,
    });
    expect(await detailOf(opened.id)).toMatchObject({
      lastPrice: null,
      lastFillAt: null,
      lastPrice24hAgo: null,
    });
    expect((await series(`/api/v1/markets/${opened.id}/ticks`)).points).toEqual([]);
  });

  it('downsamples ticks in SQL to about TICKS_MAX_POINTS, keeping the first and last', async () => {
    const open = await market();
    const base = new Date('2026-09-01T00:00:00.000Z').getTime();
    const total = 1_200;
    await writeHistory(
      open.id,
      Array.from({ length: total }, (_, i) => ({ at: base + i * 1_000, yes: yesOf(i) })),
    );

    const raw = await series(`/api/v1/markets/${open.id}/ticks`);
    // `raw` serves the fills, so it reports no stride at all; nothing was left out either.
    expect(raw).toMatchObject({ resolution: 'raw', bucketSeconds: 0, truncated: false });
    const ticks = raw.points;
    expect(ticks.length).toBeLessThanOrEqual(TICKS_MAX_POINTS);
    expect(ticks.length).toBeGreaterThanOrEqual(TICKS_MAX_POINTS / 2);
    expect(ticks[0]).toEqual({
      ts: new Date(base).toISOString(),
      pYesBp: bpOf(0),
      trigger: 'trade',
    });
    expect(ticks.at(-1)).toEqual({
      ts: new Date(base + (total - 1) * 1_000).toISOString(),
      pYesBp: bpOf(total - 1),
      trigger: 'trade',
    });
    for (let i = 1; i < ticks.length; i += 1) {
      expect(Date.parse(ticks[i]!.ts)).toBeGreaterThan(Date.parse(ticks[i - 1]!.ts));
    }

    // Twice the cap exactly: the stride is 2 and the newest tick is off a grid anchored at
    // the oldest row, which is where the answer used to come back one point over the maximum.
    const dense = await market();
    const denseTotal = TICKS_MAX_POINTS * 2;
    await writeHistory(
      dense.id,
      Array.from({ length: denseTotal }, (_, i) => ({ at: base + i * 1_000, yes: yesOf(i + 7) })),
    );
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
    // the fill in force there (one fill per second, so the boundary fill itself).
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
      { ts: from, pYesBp: bpOf(100), trigger: 'trade' },
      { ts: new Date(base + 120_000).toISOString(), pYesBp: bpOf(120), trigger: 'trade' },
      { ts: new Date(base + 180_000).toISOString(), pYesBp: bpOf(180), trigger: 'trade' },
      { ts: to, pYesBp: bpOf(200), trigger: 'trade' },
    ]);

    const inverted = await get(`/api/v1/markets/${open.id}/ticks?from=${to}&to=${from}`);
    expect(inverted.statusCode).toBe(400);
    expect(inverted.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR', details: [{ path: ['from'] }] },
    });
    expect((await get(`/api/v1/markets/${open.id}/ticks?resolution=5m`)).statusCode).toBe(400);

    // A market without fills (opening writes none) is an empty series — at every
    // resolution: the boundaries have nothing to carry forward and vanish.
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
    const points = Array.from({ length: total }, (_, i) => ({
      at: base + i * 1_000,
      yes: yesOf(i),
    }));
    // The two fills astride the bound share a millisecond (as an intake's fills do): the
    // (created_at, id) DESC order keeps the later id (#extra) and drops #extra - 1.
    points[extra - 1]!.at = points[extra]!.at;
    await writeHistory(open.id, points);

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
      pYesBp: bpOf(extra),
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
    await writeHistory(open.id, [
      { at: t0, yes: 40 },
      { at: t0 + 3 * HOUR_MS, yes: 65 },
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
      { ts: iso(t0), pYesBp: 4_000, trigger: 'trade' },
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
    // 20,000 fills across one day: a bucketed read costs one index descent per OUTPUT point,
    // so the TICKS_SCAN_MAX row cap does not apply and density cannot push the answer over
    // TICKS_MAX_POINTS or set `truncated`.
    const open = await market();
    const base = new Date('2026-09-01T00:00:00.000Z').getTime();
    const total = 20_000;
    await writeHistory(
      open.id,
      Array.from({ length: total }, (_, i) => ({
        at: base + Math.floor((i * DAY_MS) / total),
        yes: yesOf(i),
      })),
    );

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
    await writeHistory(open.id, [{ at: twoHoursAgo, yes: 40 }]);

    const windowed = await series(
      `/api/v1/markets/${open.id}/ticks?windowSeconds=3600&resolution=1m`,
    );
    // The window is exactly an hour wide and both ends are the service's own reading.
    const span = Date.parse(windowed.to) - Date.parse(windowed.from);
    expect(span).toBe(HOUR_MS);
    // And it is anchored to NOW, not to anything the caller said: the older fill is outside it.
    expect(Date.parse(windowed.from)).toBeGreaterThan(twoHoursAgo);
  });

  it('bounds a RAW answer by the relative window too, not just the bucketed one', async () => {
    // THE HAZARD: `listTicks` computed the window for both resolutions, but the raw statement
    // re-derived its floor from `query.from` — which a relative window never sets. So
    // `?windowSeconds=3600` echoed a one-hour `from` and served the newest TICKS_SCAN_MAX ticks
    // of the market's ENTIRE history: points hours older than the `from` printed beside them,
    // and `truncated` judged against a different range than the one described. Reachable on the
    // DEFAULT resolution — `resolution` defaults to `raw`, the one value that takes this path.
    const open = await market();
    const openedAt = open.openAt!.getTime();
    const outside = openedAt - 2 * HOUR_MS;
    const inside = openedAt - 5 * 60 * 1_000;
    await writeHistory(open.id, [
      { at: outside, yes: 40 },
      { at: inside, yes: 55 },
    ]);

    // No `resolution` at all: this is the default the schema fills in, and it is the raw path.
    const windowed = await series(`/api/v1/markets/${open.id}/ticks?windowSeconds=3600`);
    expect(windowed.bucketSeconds).toBe(0);
    // The invariant the bug broke: nothing older than the window the answer names is in it.
    const floor = Date.parse(windowed.from);
    expect(windowed.points.every((point) => Date.parse(point.ts) >= floor)).toBe(true);
    expect(windowed.points.map((point) => point.ts)).not.toContain(new Date(outside).toISOString());
    expect(windowed.points.map((point) => point.ts)).toContain(new Date(inside).toISOString());

    // And the stronger statement: a RELATIVE window answers exactly what the ABSOLUTE window it
    // denotes answers. One request names its start by duration and the other by instant; they
    // describe the same window, so they must describe the same points.
    const absolute = await series(
      `/api/v1/markets/${open.id}/ticks?from=${windowed.from}&to=${windowed.to}`,
    );
    expect(absolute.points).toEqual(windowed.points);
    expect(absolute.truncated).toBe(windowed.truncated);
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
    await writeHistory(open.id, [{ at: tickAt, yes: 40 }]);

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
    expect(skewed.points).toEqual([{ ts: skewed.to, pYesBp: 4_000, trigger: 'trade' }]);

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
    expect(wide.points).toEqual([{ ts: iso(tickAt), pYesBp: 4_000, trigger: 'trade' }]);
  });

  it('lists each market as its summary alone: no sparkline, the participant count as stored', async () => {
    // ADR-0062: the card draws no price trend (ADR-0061 decision 1, item 4), so the list row is
    // `MarketSummary` field for field, even for a market with a price history.
    const traded = await market({ title: '틱 있는 시장', lastPrice: 61, traderCount: 3 });
    await writeHistory(traded.id, [{ at: Date.now() - 30 * 60 * 1_000, yes: 61 }]);
    const quiet = await market({ title: '체결 없는 시장' });

    const page = (await get('/api/v1/markets')).json<ListPage>();
    const byId = new Map(page.data.map((row): [string, MarketSummary] => [row.id, row]));
    expect(byId.size).toBe(2);
    for (const row of page.data) {
      expect(Object.keys(row).sort()).toEqual(Object.keys(marketSummarySchema.shape).sort());
    }
    // The 참여자 the card shows: the stored count, and 0 written as 0 (ADR-0061 decision 1, item 4).
    expect(byId.get(traded.id)?.traderCount).toBe(3);
    expect(byId.get(quiet.id)?.traderCount).toBe(0);

    const detail = (await get(`/api/v1/markets/${traded.id}`)).json<{ data: Market }>().data;
    expect(detail).not.toHaveProperty('sparkline');
    expect(detail.traderCount).toBe(3);
  });

  it('lists active categories in display order, parents before leaves', async () => {
    const tech = await createCategory(t.db, { slug: 'tech', nameKo: '기술', sortOrder: 5 });
    const weather = await createCategory(t.db, { slug: 'weather', nameKo: '날씨', sortOrder: 1 });
    const retired = await createCategory(t.db, {
      slug: 'retired',
      nameKo: '은퇴',
      sortOrder: 0,
      isActive: false,
    });
    // Leaves: sorted within their parent by sort_order, whatever the parents' order; one
    // retired leaf and one leaf under a retired parent both stay out of the answer.
    await createCategory(t.db, { slug: 'ai', nameKo: 'AI', sortOrder: 20, parentId: tech.id });
    await createCategory(t.db, { slug: 'space', nameKo: '우주', sortOrder: 10, parentId: tech.id });
    await createCategory(t.db, {
      slug: 'rain',
      nameKo: '강수',
      sortOrder: 10,
      parentId: weather.id,
    });
    await createCategory(t.db, {
      slug: 'fog',
      nameKo: '안개',
      sortOrder: 5,
      parentId: weather.id,
      isActive: false,
    });
    await createCategory(t.db, {
      slug: 'orphan',
      nameKo: '고아',
      sortOrder: 0,
      parentId: retired.id,
    });

    const res = await get('/api/v1/categories');
    expect(res.statusCode).toBe(200);
    const data = res.json<{ data: Category[] }>().data;
    expect(data.map((row) => row.slug)).toEqual([
      'economy',
      'weather',
      'tech',
      'space',
      'ai',
      'rain',
    ]);
    expect(data[1]).toMatchObject({ nameKo: '날씨', sortOrder: 1, parentId: null });
    expect(data.find((row) => row.slug === 'rain')).toMatchObject({ parentId: weather.id });
    expect(data.find((row) => row.slug === 'space')).toMatchObject({ parentId: tech.id });
  });
});
