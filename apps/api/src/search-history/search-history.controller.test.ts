/**
 * 최근 검색 (#15, ADR-0066) against the docker `test` profile: `GET` and `POST
 * /me/search-history`, `POST /me/search-history/:id/delete` and `POST /me/search-history/clear`.
 * What the owner decided (ADR-0061 decision 3, the #15 rows) is what is pinned: a signed-in
 * member's term is kept with the account and the time and nothing else, the list is distinct and
 * the newest 10, one entry or all of them can go, and nobody else's history is reachable. The
 * public search records nothing. Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import { createSearch } from '@buddha/db/test';
import {
  MARKET_SEARCH_TERM_MAX,
  RECENT_SEARCHES_LIMIT,
  errorEnvelopeSchema,
  recentSearchSchema,
  type RecentSearch,
  type ValidationIssue,
} from '@buddha/shared';
import { randomUUID } from 'node:crypto';
import { asc, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { recentSearchesQuery } from './search-history.service.js';

/** setup-env.ts fixes WEB_ORIGIN to this. */
const TRUSTED_ORIGIN = 'http://localhost:3000';

const BASE = '/api/v1/me/search-history';

describe.skipIf(!hasTestInfra)('/api/v1/me/search-history (integration)', () => {
  let t: TestApp;
  let user: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    user = await signUpTestUser(t);
  });

  const post = (
    url: string,
    payload: unknown,
    who: TestUser | null = user,
    headers: Record<string, string> = {},
  ) =>
    t.app.inject({
      method: 'POST',
      url,
      headers: {
        origin: TRUSTED_ORIGIN,
        'content-type': 'application/json',
        ...(who ? { cookie: who.cookie } : {}),
        ...headers,
      },
      payload: JSON.stringify(payload),
    });

  const answer = (res: { statusCode: number; json: <T>() => T }): RecentSearch[] => {
    expect(res.statusCode).toBe(200);
    return recentSearchSchema.array().parse(res.json<{ data: unknown }>().data);
  };
  const record = async (query: string, who: TestUser = user) =>
    answer(await post(BASE, { query, expectedAccountId: who.id }, who));
  const remove = async (id: string, who: TestUser = user) =>
    answer(await post(`${BASE}/${id}/delete`, { expectedAccountId: who.id }, who));
  const clear = async (who: TestUser = user) =>
    answer(await post(`${BASE}/clear`, { expectedAccountId: who.id }, who));
  const list = async (who: TestUser = user) =>
    answer(await t.app.inject({ method: 'GET', url: BASE, headers: { cookie: who.cookie } }));
  const terms = (entries: readonly RecentSearch[]) => entries.map((entry) => entry.query);

  const rows = () =>
    t.db
      .select({ userId: schema.marketSearches.userId, query: schema.marketSearches.query })
      .from(schema.marketSearches)
      .orderBy(asc(schema.marketSearches.searchedAt), asc(schema.marketSearches.id));

  /** One second apart from `base`, so the order does not hang on a shared millisecond. */
  const at = (base: number, seconds: number) => new Date(base + seconds * 1_000);

  // ---- record and list ------------------------------------------------------------------

  it('records a submitted term, trimmed, with the account and the database clock only', async () => {
    expect(await list()).toEqual([]);
    const before = Date.now();
    const entries = await record('  금리 인상  ');
    expect(terms(entries)).toEqual(['금리 인상']);
    const [row] = await t.db.select().from(schema.marketSearches);
    // The term and the time, nothing else (no filter, no result count — ADR-0061 decision 3).
    expect(Object.keys(row!).sort()).toEqual(['id', 'query', 'searchedAt', 'userId']);
    expect(row).toMatchObject({ userId: user.id, query: '금리 인상' });
    expect(row!.searchedAt.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(entries).toEqual([
      { id: row!.id, query: '금리 인상', searchedAt: row!.searchedAt.toISOString() },
    ]);
    expect(await list()).toEqual(entries);
    // The longest term the search takes is a term it records.
    const longest = '가'.repeat(MARKET_SEARCH_TERM_MAX);
    expect(terms(await record(longest))).toEqual([longest, '금리 인상']);
  });

  it('lists each term once, at its newest search, the newest 10 first', async () => {
    const base = Date.now() - 60 * 60 * 1_000;
    // Twelve terms, the first searched again last: it comes back first, once, with its new time
    // and the id of that newest search.
    for (let i = 0; i < 12; i += 1) {
      await createSearch(t.db, {
        userId: user.id,
        query: `검색어 ${String(i)}`,
        searchedAt: at(base, i),
      });
    }
    const again = await createSearch(t.db, {
      userId: user.id,
      query: '검색어 0',
      searchedAt: at(base, 20),
    });
    const entries = await list();
    expect(entries).toHaveLength(RECENT_SEARCHES_LIMIT);
    expect(terms(entries)).toEqual([
      '검색어 0',
      '검색어 11',
      '검색어 10',
      '검색어 9',
      '검색어 8',
      '검색어 7',
      '검색어 6',
      '검색어 5',
      '검색어 4',
      '검색어 3',
    ]);
    expect(entries[0]).toEqual({
      id: again.id,
      query: '검색어 0',
      searchedAt: again.searchedAt.toISOString(),
    });
    // Distinct by the term as typed: another case is another term.
    await createSearch(t.db, { userId: user.id, query: 'RAIN', searchedAt: at(base, 30) });
    await createSearch(t.db, { userId: user.id, query: 'rain', searchedAt: at(base, 31) });
    expect(terms(await list()).slice(0, 3)).toEqual(['rain', 'RAIN', '검색어 0']);
    // The ids of the ties below are given (uuids compare as their lower-case text does): random
    // ones would leave which is written first to chance, and with it whether a wrong tie-break
    // shows.
    const ids = () => [randomUUID(), randomUUID()].sort() as [string, string];
    // One millisecond, two terms: the larger id goes first (the order `id desc` gives), though it
    // was written second.
    const tie = at(base, 40);
    const [firstId, secondId] = ids();
    await createSearch(t.db, { id: firstId, userId: user.id, query: '동시 1', searchedAt: tie });
    await createSearch(t.db, { id: secondId, userId: user.id, query: '동시 2', searchedAt: tie });
    expect(terms(await list()).slice(0, 2)).toEqual(['동시 2', '동시 1']);
    // One millisecond, one term twice: the entry is the search with the larger id, whether it was
    // written first (동시 3) or second (동시 4).
    const twice = at(base, 50);
    const [low3, high3] = ids();
    const [low4, high4] = ids();
    await createSearch(t.db, { id: high3, userId: user.id, query: '동시 3', searchedAt: twice });
    await createSearch(t.db, { id: low3, userId: user.id, query: '동시 3', searchedAt: twice });
    await createSearch(t.db, { id: low4, userId: user.id, query: '동시 4', searchedAt: twice });
    await createSearch(t.db, { id: high4, userId: user.id, query: '동시 4', searchedAt: twice });
    const withTies = await list();
    const entry = (query: string) => withTies.find((item) => item.query === query);
    expect(entry('동시 3')).toEqual({
      id: high3,
      query: '동시 3',
      searchedAt: twice.toISOString(),
    });
    expect(entry('동시 4')).toEqual({
      id: high4,
      query: '동시 4',
      searchedAt: twice.toISOString(),
    });
  });

  it('reads the list off its index, the first entries with no sort, however long the history (migration 0026)', async () => {
    // The list is the newest of each term, which the database keeps in market_search_terms; read
    // as the account's index in order, it costs the same for ten searches or a million (no
    // retention limit). A handful of rows never makes an index the cheapest plan, so sequential
    // and bitmap scans are switched off for this one transaction: what is left is whether the
    // index CAN serve the list as it is.
    for (let i = 0; i < 30; i += 1) {
      await createSearch(t.db, { userId: user.id, query: `검색어 ${String(i % 12)}` });
    }
    const plan = await t.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      await tx.execute(sql`SET LOCAL enable_bitmapscan = off`);
      const { rows: lines } = await tx.execute<{ 'QUERY PLAN': string }>(
        sql`EXPLAIN ${recentSearchesQuery(tx, user.id)}`,
      );
      return lines.map((line) => line['QUERY PLAN']).join('\n');
    });
    expect(plan).toContain('market_search_terms_user_id_searched_at_search_id_idx');
    expect(plan).toContain('Limit');
    expect(plan).not.toContain('Sort');
    expect(plan).not.toContain('Unique');
    expect(terms(await list())).toHaveLength(RECENT_SEARCHES_LIMIT);
  });

  it('keeps every search as its own row: a repeated term is a new row, not an update', async () => {
    await record('금리');
    await record('환율');
    await record('금리');
    expect((await rows()).map((row) => row.query)).toEqual(['금리', '환율', '금리']);
    expect(terms(await list())).toEqual(['금리', '환율']);
  });

  // ---- delete one and delete all --------------------------------------------------------

  it('deletes one entry: every search of its term, so no older one takes its place', async () => {
    const base = Date.now() - 60_000;
    await createSearch(t.db, { userId: user.id, query: '금리', searchedAt: at(base, 0) });
    await createSearch(t.db, { userId: user.id, query: '환율', searchedAt: at(base, 1) });
    await createSearch(t.db, { userId: user.id, query: '금리', searchedAt: at(base, 2) });
    const [newest] = await list();
    expect(newest?.query).toBe('금리');

    const after = await remove(newest!.id);
    expect(terms(after)).toEqual(['환율']);
    expect((await rows()).map((row) => row.query)).toEqual(['환율']);
    expect(await list()).toEqual(after);
    // Again, or with an id nobody has: nothing more goes, and the list still answers.
    expect(terms(await remove(newest!.id))).toEqual(['환율']);
    expect(terms(await remove(randomUUID()))).toEqual(['환율']);
    // An older search's id names the same term.
    await createSearch(t.db, { userId: user.id, query: '금리', searchedAt: at(base, 3) });
    const older = await createSearch(t.db, {
      userId: user.id,
      query: '유가',
      searchedAt: at(base, 4),
    });
    await createSearch(t.db, { userId: user.id, query: '유가', searchedAt: at(base, 5) });
    expect(terms(await remove(older.id))).toEqual(['금리', '환율']);
  });

  it('deletes them all, and the list is empty afterwards', async () => {
    await record('금리');
    await record('환율');
    expect(await clear()).toEqual([]);
    expect(await list()).toEqual([]);
    expect(await rows()).toEqual([]);
    // Nothing to clear is not an error.
    expect(await clear()).toEqual([]);
  });

  it('records nothing for a search of the public list, signed in or not', async () => {
    // The search itself is public and records nothing: the web records a submitted term apart.
    for (const cookie of [undefined, user.cookie]) {
      const res = await t.app.inject({
        method: 'GET',
        url: `/api/v1/markets?status=all&q=${encodeURIComponent('금리')}`,
        headers: cookie ? { cookie } : {},
      });
      expect(res.statusCode).toBe(200);
    }
    expect(await rows()).toEqual([]);
  });

  // ---- who may ------------------------------------------------------------------------

  it('answers 401 without a session and 403 for a foreign Origin, writing nothing', async () => {
    const anonymousRead = await t.app.inject({ method: 'GET', url: BASE });
    expect(anonymousRead.statusCode).toBe(401);
    const writes: [string, unknown][] = [
      [BASE, { query: '금리', expectedAccountId: user.id }],
      [`${BASE}/${randomUUID()}/delete`, { expectedAccountId: user.id }],
      [`${BASE}/clear`, { expectedAccountId: user.id }],
    ];
    for (const [url, payload] of writes) {
      const anonymous = await post(url, payload, null);
      expect({ url, status: anonymous.statusCode }).toEqual({ url, status: 401 });
      expect(errorEnvelopeSchema.parse(anonymous.json()).error.code).toBe('UNAUTHENTICATED');
      for (const origin of ['https://evil.example', 'null']) {
        const res = await post(url, payload, user, { origin });
        expect({ url, origin, status: res.statusCode }).toEqual({ url, origin, status: 403 });
        expect(errorEnvelopeSchema.parse(res.json()).error.code).toBe('FORBIDDEN');
      }
    }
    expect(await rows()).toEqual([]);
  });

  it('refuses a blank, over-long or NUL term and a malformed body or id with 400, writing nothing', async () => {
    const cases: [unknown, string][] = [
      [{ expectedAccountId: user.id }, 'query'],
      [{ query: '', expectedAccountId: user.id }, 'query'],
      [{ query: '   ', expectedAccountId: user.id }, 'query'],
      [{ query: 'x'.repeat(MARKET_SEARCH_TERM_MAX + 1), expectedAccountId: user.id }, 'query'],
      [{ query: 'a\u0000b', expectedAccountId: user.id }, 'query'],
      [{ query: 7, expectedAccountId: user.id }, 'query'],
      [{ query: '금리' }, 'expectedAccountId'],
      [{ query: '금리', expectedAccountId: '' }, 'expectedAccountId'],
    ];
    for (const [payload, field] of cases) {
      const res = await post(BASE, payload);
      expect({ payload, status: res.statusCode }).toEqual({ payload, status: 400 });
      const { error } = errorEnvelopeSchema.parse(res.json());
      expect(error.code).toBe('VALIDATION_ERROR');
      const paths = (error.details as ValidationIssue[]).map((issue) => issue.path);
      expect({ payload, paths: [...new Set(paths.flat())] }).toEqual({ payload, paths: [field] });
    }
    for (const url of [`${BASE}/${randomUUID()}/delete`, `${BASE}/clear`]) {
      const res = await post(url, {});
      expect({ url, status: res.statusCode }).toEqual({ url, status: 400 });
    }
    // Straight through, `id = 'not-a-uuid'` would be a 500.
    const badId = await post(`${BASE}/not-a-uuid/delete`, { expectedAccountId: user.id });
    expect(badId.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(badId.json()).error.code).toBe('VALIDATION_ERROR');
    expect(await rows()).toEqual([]);
  });

  it('refuses a body naming another account than the cookie (403 naming expectedAccountId)', async () => {
    // A window still showing `user` after another one signed in as `other`: the cookie is the
    // other's, the body names the account on screen. Neither account's history may move.
    const other = await signUpTestUser(t);
    await record('남의 검색', other);
    const [entry] = await list(other);
    const refused = [
      await post(BASE, { query: '내 검색', expectedAccountId: user.id }, other),
      await post(`${BASE}/${entry!.id}/delete`, { expectedAccountId: user.id }, other),
      await post(`${BASE}/clear`, { expectedAccountId: user.id }, other),
    ];
    for (const res of refused) {
      expect(res.statusCode).toBe(403);
      const { error } = errorEnvelopeSchema.parse(res.json());
      expect(error.code).toBe('FORBIDDEN');
      expect(error.details).toEqual([
        { path: ['expectedAccountId'], message: 'session belongs to another account' },
      ]);
    }
    expect(await rows()).toEqual([{ userId: other.id, query: '남의 검색' }]);
  });

  it('keeps each account to its own history: lists, deletes and clears never cross', async () => {
    const other = await signUpTestUser(t);
    await record('금리');
    await record('금리', other);
    await record('환율', other);
    const [mine] = await list();
    const theirs = await list(other);

    // Each sees its own terms only, the shared one with its own id.
    expect(terms(await list())).toEqual(['금리']);
    expect(terms(theirs)).toEqual(['환율', '금리']);
    expect(theirs.map((entry) => entry.id)).not.toContain(mine!.id);

    // The other account deleting this account's entry by id reaches nothing — not even its own
    // row of the same term.
    expect(terms(await remove(mine!.id, other))).toEqual(['환율', '금리']);
    expect(terms(await list())).toEqual(['금리']);
    // This account deleting its own entry takes its own searches of the term only: the other
    // account's search of the same term, and its entry, stay.
    expect(await remove(mine!.id)).toEqual([]);
    expect(terms(await list(other))).toEqual(['환율', '금리']);
    expect(await rows()).toEqual([
      { userId: other.id, query: '금리' },
      { userId: other.id, query: '환율' },
    ]);
    // And clearing the other's own leaves this account's.
    await record('유가');
    expect(await clear(other)).toEqual([]);
    expect(await rows()).toEqual([{ userId: user.id, query: '유가' }]);
    expect(terms(await list())).toEqual(['유가']);
  });
});
