/**
 * 관심 시장 (#89, ADR-0064) against the docker `test` profile: `GET /me/watchlist`, `GET` and
 * `PUT /me/watchlist/:marketId`. What the owner decided (ADR-0061 decision 3) is what is pinned:
 * every public status may be watched and stays listed until unwatched, newest watch first, no
 * cap, the session only (no onboarding check), each change kept as an event and a no-op kept as
 * none, and nobody else's watchlist reachable. Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import { createCategory, createMarket, createUser, createWatch } from '@buddha/db/test';
import {
  PUBLIC_MARKET_STATUSES,
  errorEnvelopeSchema,
  marketSummarySchema,
  watchStateSchema,
  type MarketSummary,
  type MarketStatus,
  type ValidationIssue,
} from '@buddha/shared';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

/** setup-env.ts fixes WEB_ORIGIN to this. */
const TRUSTED_ORIGIN = 'http://localhost:3000';

type ListPage = { data: MarketSummary[]; meta: { nextCursor: string | null } };

describe.skipIf(!hasTestInfra)('/api/v1/me/watchlist (integration)', () => {
  let t: TestApp;
  let user: TestUser;
  let creatorId: string;
  let category: { id: number; slug: string };

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    user = await signUpTestUser(t);
    creatorId = (await createUser(t.db, { role: 'admin' })).user.id;
    category = await createCategory(t.db, { slug: 'economy', nameKo: '경제' });
  });

  const market = (input: Parameters<typeof createMarket>[1] = {}) =>
    createMarket(t.db, { createdBy: creatorId, categoryId: category.id, ...input });

  const put = (
    marketId: string,
    payload: unknown,
    who: TestUser | null = user,
    headers: Record<string, string> = {},
  ) =>
    t.app.inject({
      method: 'PUT',
      url: `/api/v1/me/watchlist/${marketId}`,
      headers: {
        origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
        ...(who ? { cookie: who.cookie } : {}),
        ...headers,
      },
      payload: JSON.stringify(payload),
    });
  const watch = (marketId: string, who: TestUser = user) =>
    put(marketId, { watched: true, expectedAccountId: who.id }, who);
  const unwatch = (marketId: string, who: TestUser = user) =>
    put(marketId, { watched: false, expectedAccountId: who.id }, who);

  const stateOf = async (marketId: string, who: TestUser = user) => {
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/v1/me/watchlist/${marketId}`,
      headers: { cookie: who.cookie },
    });
    expect(res.statusCode).toBe(200);
    return watchStateSchema.parse(res.json<{ data: unknown }>().data).watched;
  };

  const list = async (query = '', who: TestUser = user): Promise<ListPage> => {
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/v1/me/watchlist${query === '' ? '' : `?${query}`}`,
      headers: { cookie: who.cookie },
    });
    expect(res.statusCode).toBe(200);
    return res.json<ListPage>();
  };
  const listedIds = async (query = '', who: TestUser = user) =>
    (await list(query, who)).data.map((row) => row.id);

  const watchRows = () =>
    t.db
      .select()
      .from(schema.marketWatches)
      .orderBy(asc(schema.marketWatches.userId), asc(schema.marketWatches.marketId));
  const events = () =>
    t.db
      .select({
        userId: schema.marketWatchEvents.userId,
        marketId: schema.marketWatchEvents.marketId,
        action: schema.marketWatchEvents.action,
      })
      .from(schema.marketWatchEvents)
      .orderBy(asc(schema.marketWatchEvents.id));

  // ---- watch and unwatch --------------------------------------------------------------

  it('watches: the row, one watch event at the same instant, the state and the list', async () => {
    const m = await market();
    expect(await stateOf(m.id)).toBe(false);

    const res = await watch(m.id);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: unknown }>().data).toEqual({ watched: true });

    const [row] = await watchRows();
    expect(row).toMatchObject({ userId: user.id, marketId: m.id });
    expect(await events()).toEqual([{ userId: user.id, marketId: m.id, action: 'watch' }]);
    const [event] = await t.db.select().from(schema.marketWatchEvents);
    expect(event!.createdAt.getTime()).toBe(row!.watchedAt.getTime());
    expect(await stateOf(m.id)).toBe(true);

    const page = await list();
    expect(page.data.map((item) => item.id)).toEqual([m.id]);
    // The very row `GET /markets` answers, so the same card draws it.
    expect(Object.keys(page.data[0]!).sort()).toEqual(
      Object.keys(marketSummarySchema.shape).sort(),
    );
    expect(marketSummarySchema.parse(page.data[0])).toEqual(page.data[0]);
    expect(page.meta).toEqual({ nextCursor: null });
  });

  it('a repeated watch changes nothing and records nothing', async () => {
    const m = await market();
    await watch(m.id);
    const [before] = await watchRows();

    const again = await watch(m.id);
    expect(again.statusCode).toBe(200);
    expect(again.json<{ data: unknown }>().data).toEqual({ watched: true });
    expect(await watchRows()).toEqual([before]);
    expect(await events()).toEqual([{ userId: user.id, marketId: m.id, action: 'watch' }]);
  });

  it('unwatches: the row goes, one unwatch event, and a repeated unwatch records nothing (#95)', async () => {
    const m = await market();
    await watch(m.id);

    const res = await unwatch(m.id);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: unknown }>().data).toEqual({ watched: false });
    expect(await watchRows()).toEqual([]);
    expect(await stateOf(m.id)).toBe(false);
    expect(await listedIds()).toEqual([]);

    const again = await unwatch(m.id);
    expect(again.statusCode).toBe(200);
    expect(again.json<{ data: unknown }>().data).toEqual({ watched: false });
    // An unwatch of a market never watched records nothing either.
    const other = await market();
    expect((await unwatch(other.id)).statusCode).toBe(200);
    expect(await events()).toEqual([
      { userId: user.id, marketId: m.id, action: 'watch' },
      { userId: user.id, marketId: m.id, action: 'unwatch' },
    ]);
  });

  it('a watch begun again is a new watch: a later instant, first in the list, its own event', async () => {
    const first = await market();
    const second = await market();
    await createWatch(t.db, {
      userId: user.id,
      marketId: first.id,
      watchedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    await createWatch(t.db, {
      userId: user.id,
      marketId: second.id,
      watchedAt: new Date('2026-02-01T00:00:00.000Z'),
    });
    expect(await listedIds()).toEqual([second.id, first.id]);

    await unwatch(first.id);
    await watch(first.id);
    expect(await listedIds()).toEqual([first.id, second.id]);
    const [again] = (await watchRows()).filter((row) => row.marketId === first.id);
    expect(again!.watchedAt.getTime()).toBeGreaterThan(Date.parse('2026-02-01T00:00:00.000Z'));
    expect((await events()).filter((event) => event.marketId === first.id)).toEqual([
      { userId: user.id, marketId: first.id, action: 'watch' },
      { userId: user.id, marketId: first.id, action: 'unwatch' },
      { userId: user.id, marketId: first.id, action: 'watch' },
    ]);
  });

  it('two watches at once leave one row and one event', async () => {
    const m = await market();
    const answers = await Promise.all([watch(m.id), watch(m.id), watch(m.id)]);
    expect(answers.map((res) => res.statusCode)).toEqual([200, 200, 200]);
    expect(await watchRows()).toHaveLength(1);
    expect(await events()).toEqual([{ userId: user.id, marketId: m.id, action: 'watch' }]);
  });

  it('two unwatches at once leave no row and one unwatch event', async () => {
    // The second DELETE waits on the first's row lock and then finds nothing to delete, so it
    // records nothing: #151 counts one unwatch for one change, however many presses raced.
    const m = await market();
    await watch(m.id);
    const answers = await Promise.all([unwatch(m.id), unwatch(m.id), unwatch(m.id)]);
    expect(answers.map((res) => res.statusCode)).toEqual([200, 200, 200]);
    expect(await watchRows()).toEqual([]);
    expect(await events()).toEqual([
      { userId: user.id, marketId: m.id, action: 'watch' },
      { userId: user.id, marketId: m.id, action: 'unwatch' },
    ]);
  });

  it('watches every public status (ADR-0061 decision 3) and touches nothing but the watchlist', async () => {
    const before = {
      balances: await t.db.select().from(schema.balances),
      ledger: await t.db.select().from(schema.ledgerEntries),
    };
    for (const status of PUBLIC_MARKET_STATUSES) {
      const m = await market({
        status,
        ...(status === 'settled' ? { resolvedResult: 'YES' } : {}),
      });
      const res = await watch(m.id);
      expect({ status, code: res.statusCode }).toEqual({ status, code: 200 });
      const [row] = await t.db.select().from(schema.markets).where(eq(schema.markets.id, m.id));
      // No statistic of the market moves: watching is not trading (#89 AC).
      expect(row).toEqual(m);
    }
    expect(await watchRows()).toHaveLength(PUBLIC_MARKET_STATUSES.length);
    expect(await t.db.select().from(schema.orders)).toEqual([]);
    expect(await t.db.select().from(schema.positions)).toEqual([]);
    expect(await t.db.select().from(schema.balances)).toEqual(before.balances);
    expect(await t.db.select().from(schema.ledgerEntries)).toEqual(before.ledger);
  });

  it('needs the session only: an account with no real name or phone may watch (#57)', async () => {
    const rows = await t.db
      .select()
      .from(schema.userContacts)
      .where(eq(schema.userContacts.userId, user.id));
    expect(rows).toEqual([]);
    const m = await market();
    expect((await watch(m.id)).statusCode).toBe(200);
  });

  it('answers NOT_FOUND for a draft and an unknown market on the state read, the watch and the unwatch, writing nothing', async () => {
    const draft = await market({ status: 'draft' });
    for (const id of [draft.id, randomUUID()]) {
      const read = await t.app.inject({
        method: 'GET',
        url: `/api/v1/me/watchlist/${id}`,
        headers: { cookie: user.cookie },
      });
      expect(read.statusCode).toBe(404);
      expect(errorEnvelopeSchema.parse(read.json()).error.code).toBe('NOT_FOUND');
      for (const res of [await watch(id), await unwatch(id)]) {
        expect(res.statusCode).toBe(404);
        expect(errorEnvelopeSchema.parse(res.json()).error.code).toBe('NOT_FOUND');
      }
    }
    expect(await watchRows()).toEqual([]);
    expect(await events()).toEqual([]);
  });

  // ---- the list -----------------------------------------------------------------------

  it('lists newest watch first across pages, ended markets kept with their status', async () => {
    const statuses: MarketStatus[] = ['open', 'closed', 'resolved', 'settled', 'voided'];
    const ids: string[] = [];
    for (const [index, status] of statuses.entries()) {
      const m = await market({ status });
      ids.push(m.id);
      await createWatch(t.db, {
        userId: user.id,
        marketId: m.id,
        watchedAt: new Date(Date.UTC(2026, 0, 1 + index)),
      });
    }
    // Two watches in one millisecond: the market id breaks the tie, as the cursor does.
    const tiedAt = new Date(Date.UTC(2026, 0, 10));
    const tied = [await market(), await market()];
    for (const m of tied) {
      await createWatch(t.db, { userId: user.id, marketId: m.id, watchedAt: tiedAt });
    }
    const expected = [
      ...tied
        .map((m) => m.id)
        .sort()
        .reverse(),
      ...[...ids].reverse(),
    ];

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: ListPage = await list(`limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...page.data.map((row) => row.id));
      cursor = page.meta.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(seen).toEqual(expected);
    expect(pages).toBe(3);

    const all = (await list('limit=100')).data;
    expect(all.map((row) => row.status)).toEqual(['open', 'open', ...[...statuses].reverse()]);
    // A cursor that does not decode serves the first page, like every list — including one
    // whose id half is not a uuid (it must not reach `market_id` on a uuid column as a 22P02,
    // which the exception filter would answer with a 500) and one whose time half is past the
    // last valid Date.
    for (const malformed of ['not-a-cursor', '0_not-a-uuid', '8640000000000001_x']) {
      expect({
        malformed,
        ids: (await list(`cursor=${malformed}&limit=100`)).data.map((row) => row.id),
      }).toEqual({ malformed, ids: expected });
    }
  });

  it('has no cap (ADR-0061 decision 3): every watch is kept and listed', async () => {
    const markets = [];
    for (let index = 0; index < 105; index += 1) markets.push(await market());
    for (const m of markets) expect((await watch(m.id)).statusCode).toBe(200);
    const first = await list('limit=100');
    const second = await list(`limit=100&cursor=${first.meta.nextCursor!}`);
    expect(first.data.length + second.data.length).toBe(105);
    expect(second.meta.nextCursor).toBeNull();
  });

  it('filters by a public status and by a category, a top-level one taking its sub-categories', async () => {
    const weather = await createCategory(t.db, { slug: 'weather', nameKo: '날씨' });
    const rain = await createCategory(t.db, { slug: 'rain', nameKo: '비', parentId: weather.id });
    const inRain = await market({ categoryId: rain.id });
    const inWeather = await market({ categoryId: weather.id, status: 'closed' });
    const elsewhere = await market({ status: 'closed' });
    for (const m of [inRain, inWeather, elsewhere]) await watch(m.id);

    expect((await listedIds('category=weather')).sort()).toEqual([inRain.id, inWeather.id].sort());
    expect(await listedIds('category=rain')).toEqual([inRain.id]);
    expect(await listedIds('category=unknown')).toEqual([]);
    expect((await listedIds('status=closed')).sort()).toEqual([inWeather.id, elsewhere.id].sort());
    expect(await listedIds('status=closed&category=weather')).toEqual([inWeather.id]);
    expect(await listedIds('status=settled')).toEqual([]);

    for (const query of ['status=draft', 'category=', 'limit=0', 'limit=101']) {
      const res = await t.app.inject({
        method: 'GET',
        url: `/api/v1/me/watchlist?${query}`,
        headers: { cookie: user.cookie },
      });
      expect({ query, status: res.statusCode }).toEqual({ query, status: 400 });
    }
  });

  // ---- who may ------------------------------------------------------------------------

  it('answers 401 without a session and 403 for a foreign Origin, writing nothing', async () => {
    const m = await market();
    for (const url of ['/api/v1/me/watchlist', `/api/v1/me/watchlist/${m.id}`]) {
      const res = await t.app.inject({ method: 'GET', url });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 401 });
    }
    const anonymous = await put(m.id, { watched: true, expectedAccountId: user.id }, null);
    expect(anonymous.statusCode).toBe(401);
    expect(errorEnvelopeSchema.parse(anonymous.json()).error.code).toBe('UNAUTHENTICATED');

    for (const origin of ['https://evil.example', 'null']) {
      const res = await put(m.id, { watched: true, expectedAccountId: user.id }, user, { origin });
      expect({ origin, status: res.statusCode }).toEqual({ origin, status: 403 });
      expect(errorEnvelopeSchema.parse(res.json()).error.code).toBe('FORBIDDEN');
    }
    expect(await watchRows()).toEqual([]);
    expect(await events()).toEqual([]);
  });

  it('refuses a malformed body or market id with 400 naming the field, writing nothing', async () => {
    const m = await market();
    const cases: [unknown, string][] = [
      [{ expectedAccountId: user.id }, 'watched'],
      [{ watched: 'true', expectedAccountId: user.id }, 'watched'],
      [{ watched: null, expectedAccountId: user.id }, 'watched'],
      [{ watched: true }, 'expectedAccountId'],
      [{ watched: true, expectedAccountId: '' }, 'expectedAccountId'],
    ];
    for (const [payload, field] of cases) {
      const res = await put(m.id, payload);
      expect({ payload, status: res.statusCode }).toEqual({ payload, status: 400 });
      const { error } = errorEnvelopeSchema.parse(res.json());
      expect(error.code).toBe('VALIDATION_ERROR');
      const paths = (error.details as ValidationIssue[]).map((issue) => issue.path);
      expect({ payload, paths: [...new Set(paths.flat())] }).toEqual({ payload, paths: [field] });
    }
    const badId = await put('not-a-uuid', { watched: true, expectedAccountId: user.id });
    expect(badId.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(badId.json()).error.code).toBe('VALIDATION_ERROR');
    // The state read too: straight through, `markets.id = 'not-a-uuid'` would be a 500.
    const badRead = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me/watchlist/not-a-uuid',
      headers: { cookie: user.cookie },
    });
    expect(badRead.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(badRead.json()).error.code).toBe('VALIDATION_ERROR');
    expect(await watchRows()).toEqual([]);
  });

  it('refuses a body naming another account than the cookie (403 naming expectedAccountId)', async () => {
    // A window still showing `user` after another one signed in as `other`: the cookie is the
    // other's, the body names the account on screen. Neither account's watchlist may move.
    const other = await signUpTestUser(t);
    const m = await market();
    await watch(m.id, other);

    for (const watched of [true, false]) {
      const res = await put(m.id, { watched, expectedAccountId: user.id }, other);
      expect(res.statusCode).toBe(403);
      const { error } = errorEnvelopeSchema.parse(res.json());
      expect(error.code).toBe('FORBIDDEN');
      expect(error.details).toEqual([
        { path: ['expectedAccountId'], message: 'session belongs to another account' },
      ]);
    }
    expect((await watchRows()).map((row) => row.userId)).toEqual([other.id]);
    expect(await events()).toEqual([{ userId: other.id, marketId: m.id, action: 'watch' }]);
  });

  it('keeps each account to its own watchlist: lists, states and writes never cross (#37)', async () => {
    const other = await signUpTestUser(t);
    const mine = await market();
    const shared = await market();
    await watch(mine.id);
    await watch(shared.id);

    // The other account sees none of this account's watches, by list or by market.
    expect(await listedIds('', other)).toEqual([]);
    expect(await stateOf(mine.id, other)).toBe(false);
    expect(await stateOf(shared.id, other)).toBe(false);

    // Its own watch and unwatch of the same market touch its own row and history only.
    await watch(shared.id, other);
    expect(await listedIds('', other)).toEqual([shared.id]);
    await unwatch(shared.id, other);
    await unwatch(mine.id, other);
    expect(await listedIds('', other)).toEqual([]);
    // Sorted: two watches a request apart may share a millisecond, and the order is not the point.
    expect((await listedIds()).sort()).toEqual([shared.id, mine.id].sort());
    expect(await stateOf(shared.id)).toBe(true);
    expect(await stateOf(mine.id)).toBe(true);
    expect((await watchRows()).map((row) => `${row.userId} ${row.marketId}`).sort()).toEqual(
      [`${user.id} ${mine.id}`, `${user.id} ${shared.id}`].sort(),
    );
    expect((await events()).filter((event) => event.userId === other.id)).toEqual([
      { userId: other.id, marketId: shared.id, action: 'watch' },
      { userId: other.id, marketId: shared.id, action: 'unwatch' },
    ]);
    expect((await events()).filter((event) => event.userId === user.id)).toHaveLength(2);
  });
});
