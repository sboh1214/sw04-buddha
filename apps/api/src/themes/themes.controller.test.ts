/**
 * 테마 (#81) in public against the docker `test` profile: the list (`GET /themes`), a theme's page
 * and its markets and results (`GET /themes/:id`, `/markets`, `/results`), and the themes on a
 * market's detail (`GET /markets/:id/themes`). Owner decisions under test (ADR-0069 decision 4,
 * the #81 rows): only published themes, signed out too; 예정·진행 중·종료 by the period; every
 * public market status but a draft; the results list is 판정 완료·정산 완료·무효 with the result and
 * nothing about anyone's trades; the theme's own notices. And of 2026-10-19 (ADR-0088): the period
 * in Korean dates, both days in it; the list 진행 중 → 예정 → 종료; the page at its slug; voided
 * markets among the cards. Skips when TEST_* are unset.
 */
import { clockTimestamp, schema } from '@buddha/db';
import {
  createCategory,
  createMarket,
  createTheme,
  createThemeMarket,
  createThemeNotice,
} from '@buddha/db/test';
import {
  THEME_STATUSES,
  encodeTupleCursor,
  koreanDateAt,
  themeStatusAt,
  type MarketSummary,
  type Theme,
  type ThemeResult,
  type ThemeSummary,
} from '@buddha/shared';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Clock from '../infra/db/clock.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { dateOfEpochDay, epochDayOf, themeListOrder, themeStatusWhere } from './theme-rows.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * The database clock as the services read it (`clockTimestamp`), moved by `clock.shiftMs` — 0
 * but in the test that pins a Korean early morning, when the Korean date and the UTC date differ
 * (as approval.service.test.ts moves it). The tests' own `clockTimestamp` (@buddha/db) is the
 * real one.
 */
const clock = vi.hoisted(() => ({ shiftMs: 0 }));
vi.mock('../infra/db/clock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Clock>();
  return {
    ...actual,
    clockTimestamp: async (tx: Clock.StatementExecutor) =>
      new Date((await actual.clockTimestamp(tx)).getTime() + clock.shiftMs),
  };
});

type Page<T> = { data: T[]; meta: { nextCursor: string | null } };

describe.skipIf(!hasTestInfra)('themes in public (integration)', () => {
  let t: TestApp;
  let admin: string;
  let member: TestUser;
  let category: { id: number };

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  afterEach(() => {
    clock.shiftMs = 0;
  });
  beforeEach(async () => {
    await t.reset();
    const signedUp = await signUpTestUser(t);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, signedUp.id));
    admin = signedUp.id;
    member = await signUpTestUser(t);
    category = await createCategory(t.db, { slug: 'economy', nameKo: '경제' });
  });

  const market = (input: Parameters<typeof createMarket>[1] = {}) =>
    createMarket(t.db, { createdBy: admin, categoryId: category.id, ...input });
  /** The Korean date `days` from `date`. */
  const shift = (date: string, days: number) => dateOfEpochDay(epochDayOf(date) + days);
  /** The Korean date of the database clock, the day the API reads a period at. */
  const kstToday = async () => koreanDateAt(await clockTimestamp(t.db));
  /** A published theme by default, 진행 중 from yesterday for a week. */
  const theme = (input: Parameters<typeof createTheme>[1] = {}) =>
    createTheme(t.db, { createdBy: admin, publishedAt: new Date(), ...input });
  const put = (themeId: string, marketId: string, createdAt?: Date) =>
    createThemeMarket(t.db, {
      themeId,
      marketId,
      createdBy: admin,
      ...(createdAt ? { createdAt } : {}),
    });

  const get = (url: string, cookie?: string) =>
    t.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: cookie ? { cookie } : {} });
  async function page<T>(url: string): Promise<Page<T>> {
    const res = await get(url);
    expect(res.statusCode).toBe(200);
    return res.json<Page<T>>();
  }
  /** Follows `meta.nextCursor` to the end, collecting `field` of every row in page order. */
  async function walk(url: string, field = 'id'): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const separator = url.includes('?') ? '&' : '?';
      const current: Page<Record<string, string>> = await page(
        cursor ? `${url}${separator}cursor=${encodeURIComponent(cursor)}` : url,
      );
      seen.push(...current.data.map((row) => row[field]!));
      cursor = current.meta.nextCursor;
      pages += 1;
      if (pages > 50) throw new Error(`cursor never ended for ${url}`);
    } while (cursor);
    return seen;
  }

  it('lists published themes only, 진행 중 → 예정 → 종료, to visitors and members alike', async () => {
    const today = await kstToday();
    // 진행 중 by the soonest end, 예정 by the soonest start, 종료 by the latest end (owner
    // decision 2026-10-19).
    const endsLater = await theme({ startDate: shift(today, -5), endDate: shift(today, 9) });
    const endsSooner = await theme({ startDate: shift(today, -1), endDate: shift(today, 2) });
    const startsLater = await theme({ startDate: shift(today, 6), endDate: shift(today, 7) });
    const startsSooner = await theme({ startDate: shift(today, 3), endDate: shift(today, 30) });
    const endedLong = await theme({ startDate: shift(today, -40), endDate: shift(today, -20) });
    const endedJust = await theme({ startDate: shift(today, -10), endDate: shift(today, -1) });
    const draft = await theme({ publishedAt: null });
    const listed = await page<ThemeSummary>('/themes');
    expect(listed.data.map((row) => row.id)).toEqual([
      endsSooner.id,
      endsLater.id,
      startsSooner.id,
      startsLater.id,
      endedJust.id,
      endedLong.id,
    ]);
    expect(listed.data.map((row) => row.id)).not.toContain(draft.id);
    // The public row: the address, name, period and status, nothing about who made or published it.
    expect(Object.keys(listed.data[0]!).sort()).toEqual([
      'endDate',
      'id',
      'name',
      'slug',
      'startDate',
      'status',
    ]);
    expect(listed.data[0]).toEqual({
      id: endsSooner.id,
      slug: endsSooner.slug,
      name: endsSooner.name,
      startDate: shift(today, -1),
      endDate: shift(today, 2),
      status: 'ongoing',
    });
    const asMember = (await get('/themes', member.cookie)).json<Page<ThemeSummary>>();
    expect(asMember.data).toEqual(listed.data);
  });

  it('sorts themes as 예정·진행 중·종료 on the Korean date of the database clock, both days in', async () => {
    const today = await kstToday();
    const upcoming = await theme({ startDate: shift(today, 1), endDate: shift(today, 2) });
    // The boundaries: a period starting today is 진행 중 — its first day is in — and so is one
    // ending today; one that ended yesterday is 종료.
    const startsToday = await theme({ startDate: today, endDate: shift(today, 1) });
    const endsToday = await theme({ startDate: shift(today, -3), endDate: today });
    const ended = await theme({ startDate: shift(today, -3), endDate: shift(today, -1) });
    const statuses = Object.fromEntries(
      (await page<ThemeSummary>('/themes')).data.map((row) => [row.id, row.status]),
    );
    expect(statuses).toEqual({
      [upcoming.id]: 'upcoming',
      [startsToday.id]: 'ongoing',
      [endsToday.id]: 'ongoing',
      [ended.id]: 'ended',
    });
    // The filter and the label are the one rule.
    for (const [status, expected] of [
      ['upcoming', [upcoming.id]],
      ['ongoing', [endsToday.id, startsToday.id]],
      ['ended', [ended.id]],
    ] as const) {
      const rows = (await page<ThemeSummary>(`/themes?status=${status}`)).data;
      expect(rows.map((row) => row.id)).toEqual(expected);
      expect(rows.every((row) => row.status === status)).toBe(true);
    }
    expect((await get('/themes?status=open')).statusCode).toBe(400);
  });

  it('agrees in SQL with themeStatusAt at the Korean day boundaries (filters and order)', async () => {
    // A fixed Korean date, read through the SQL the routes use, against the shared rule read at
    // an instant of that date — the first and the last millisecond of the Korean day included.
    const day = '2026-10-20';
    const periods = [
      { startDate: '2026-10-21', endDate: '2026-10-22' },
      { startDate: '2026-10-20', endDate: '2026-10-20' },
      { startDate: '2026-10-18', endDate: '2026-10-20' },
      { startDate: '2026-10-19', endDate: '2026-10-19' },
    ];
    const rows = [];
    for (const period of periods) rows.push(await theme(period));
    const ids = rows.map((row) => row.id);
    for (const instant of ['2026-10-20T00:00:00.000+09:00', '2026-10-20T23:59:59.999+09:00']) {
      expect(koreanDateAt(Date.parse(instant))).toBe(day);
      for (const status of THEME_STATUSES) {
        const matched = await t.db
          .select({ id: schema.themes.id })
          .from(schema.themes)
          .where(and(inArray(schema.themes.id, ids), themeStatusWhere(status, day)))
          .orderBy(asc(schema.themes.id));
        const expected = rows
          .filter((row) => themeStatusAt(row, Date.parse(instant)) === status)
          .map((row) => row.id)
          .sort();
        expect({ status, ids: matched.map((row) => row.id) }).toEqual({ status, ids: expected });
      }
    }
    const order = themeListOrder(day);
    const ranked = await t.db
      .select({ id: schema.themes.id, ...order.fields })
      .from(schema.themes)
      .where(inArray(schema.themes.id, ids))
      .orderBy(...order.orderBy);
    // 진행 중 by the soonest end (the one-day theme and the one ending today tie on the end: the
    // id decides), then 예정, then 종료.
    const [later, oneDay, endsToday, endedYesterday] = rows;
    const tied = [oneDay!.id, endsToday!.id].sort();
    expect(ranked.map((row) => row.id)).toEqual([...tied, later!.id, endedYesterday!.id]);
    expect(ranked.map((row) => row.rank)).toEqual([0, 0, 1, 2]);
  });

  it('reads the Korean date, not the UTC one, in a Korean early morning (filters, order, links)', async () => {
    // 00:30 KST on 2026-10-20 is 15:30 UTC on 2026-10-19: the two dates differ until 09:00 KST,
    // so a route that took the UTC date would sort these themes a day late. The services read
    // the database clock moved to that instant.
    const at = Date.parse('2026-10-20T00:30:00.000+09:00');
    clock.shiftMs = at - (await clockTimestamp(t.db)).getTime();
    const startsToday = await theme({ startDate: '2026-10-20', endDate: '2026-10-21' });
    const endedYesterday = await theme({ startDate: '2026-10-17', endDate: '2026-10-19' });
    const upcoming = await theme({ startDate: '2026-10-21', endDate: '2026-10-23' });
    for (const [status, expected] of [
      ['ongoing', [startsToday.id]],
      ['upcoming', [upcoming.id]],
      ['ended', [endedYesterday.id]],
    ] as const) {
      const rows = (await page<ThemeSummary>(`/themes?status=${status}`)).data;
      expect({ status, ids: rows.map((row) => row.id) }).toEqual({ status, ids: expected });
      expect(rows.every((row) => row.status === status)).toBe(true);
    }
    expect((await page<ThemeSummary>('/themes')).data.map((row) => row.id)).toEqual([
      startsToday.id,
      upcoming.id,
      endedYesterday.id,
    ]);
    // A market detail's links are ordered on the same date: on the UTC date the theme ending
    // yesterday would be 진행 중 and come first, and the one starting today 예정.
    const linked = await market();
    for (const holder of [endedYesterday, startsToday]) await put(holder.id, linked.id);
    const links = (await get(`/markets/${linked.id}/themes`)).json<{ data: ThemeSummary[] }>();
    expect(links.data.map((row) => [row.id, row.status])).toEqual([
      [startsToday.id, 'ongoing'],
      [endedYesterday.id, 'ended'],
    ]);
  });

  it('pages past themes dated as late as 9999-12-31 and as early as 0001-01-01', async () => {
    // A period may use any date Postgres stores (`THEME_DATE_MIN`·`THEME_DATE_MAX`): an
    // operator's 'no end' of 9999-12-31 puts a seven-digit key in the cursor, which the next page
    // must read rather than serve the first page again.
    const today = await kstToday();
    const soon = await theme({ startDate: shift(today, -1), endDate: shift(today, 3) });
    const lateEnd = await theme({ startDate: shift(today, -1), endDate: '9999-12-30' });
    const lastEnd = await theme({ startDate: shift(today, -2), endDate: '9999-12-31' });
    const upcoming = await theme({ startDate: shift(today, 1), endDate: shift(today, 2) });
    const farStart = await theme({ startDate: '9999-01-01', endDate: '9999-12-31' });
    const ended = await theme({ startDate: shift(today, -5), endDate: shift(today, -2) });
    const oldest = await theme({ startDate: '0001-01-01', endDate: '0001-01-01' });
    const all = [soon, lateEnd, lastEnd, upcoming, farStart, ended, oldest].map((row) => row.id);
    expect(await walk('/themes?limit=1')).toEqual(all);
    expect(await walk('/themes?limit=2')).toEqual(all);
    expect(await walk('/themes?status=ongoing&limit=1')).toEqual(all.slice(0, 3));
    expect(await walk('/themes?status=upcoming&limit=1')).toEqual(all.slice(3, 5));
    expect(await walk('/themes?status=ended&limit=1')).toEqual(all.slice(5));
  });

  it('pages the list on the status, the date and the id, on the first page’s Korean date', async () => {
    const today = await kstToday();
    const ids: string[] = [];
    // Two 진행 중 themes ending on the same day (the id breaks the tie), one more, two 예정, one 종료.
    for (const period of [
      { startDate: shift(today, -1), endDate: shift(today, 3) },
      { startDate: shift(today, -2), endDate: shift(today, 3) },
      { startDate: shift(today, -2), endDate: shift(today, 4) },
      { startDate: shift(today, 1), endDate: shift(today, 4) },
      { startDate: shift(today, 2), endDate: shift(today, 2) },
      { startDate: shift(today, -9), endDate: shift(today, -2) },
    ]) {
      ids.push((await theme(period)).id);
    }
    const expected = [...ids.slice(0, 2).sort(), ...ids.slice(2)];
    expect(await walk('/themes?limit=2')).toEqual(expected);
    // A cursor of another shape serves the first page, not a 500.
    expect((await page<ThemeSummary>('/themes?cursor=nope')).data.map((row) => row.id)).toEqual(
      expected,
    );
    // The later pages sort on the day the cursor carries, not on today: two days on, the two 예정
    // themes are on as well — the one-day one ends first, the other ends with the third (the id
    // decides) — and the 종료 one is still last.
    const inTwoDays = shift(today, 2);
    const before = encodeTupleCursor(
      [String(epochDayOf(inTwoDays)), '0', '-999999'],
      '00000000-0000-4000-8000-000000000000',
    );
    const pinned = await page<ThemeSummary>(`/themes?cursor=${before}`);
    expect(pinned.data.map((row) => row.id)).toEqual([
      ids[4],
      ...ids.slice(0, 2).sort(),
      ...[ids[2], ids[3]].sort(),
      ids[5],
    ]);
    // The labels say where each theme is now.
    expect(pinned.data.find((row) => row.id === ids[4])?.status).toBe('upcoming');
  });

  it('shows a published theme’s page with its shown notices, newest first, and no author', async () => {
    const shown = await theme({ intro: '첫 줄\n둘째 줄' });
    const now = (await clockTimestamp(t.db)).getTime();
    const old = await createThemeNotice(t.db, {
      themeId: shown.id,
      createdBy: admin,
      title: '먼저 쓴 공지',
      createdAt: new Date(now - HOUR_MS),
      editedAt: new Date(now - 1000),
    });
    const fresh = await createThemeNotice(t.db, {
      themeId: shown.id,
      createdBy: admin,
      title: '나중 공지',
      createdAt: new Date(now),
    });
    await createThemeNotice(t.db, { themeId: shown.id, createdBy: admin, hiddenAt: new Date() });
    const res = await get(`/themes/${shown.id}`);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ data: Theme }>().data;
    expect(body).toMatchObject({
      id: shown.id,
      name: shown.name,
      intro: '첫 줄\n둘째 줄',
      status: 'ongoing',
    });
    expect(body.notices.map((row) => row.id)).toEqual([fresh.id, old.id]);
    expect(body.notices[1]).toEqual({
      id: old.id,
      title: '먼저 쓴 공지',
      body: old.body,
      createdAt: old.createdAt.toISOString(),
      editedAt: old.editedAt!.toISOString(),
    });
    expect(res.body).not.toContain(admin);
  });

  it('shows the page at its slug and its id alike (owner decision 2026-10-19)', async () => {
    const shown = await theme({ slug: '2026-노벨상' });
    const bySlug = await get(`/themes/${encodeURIComponent('2026-노벨상')}`);
    expect(bySlug.statusCode).toBe(200);
    expect(bySlug.json<{ data: Theme }>().data).toMatchObject({
      id: shown.id,
      slug: '2026-노벨상',
    });
    // A decomposed (NFD) spelling of the same slug is the same address.
    const nfd = await get(`/themes/${encodeURIComponent('2026-노벨상'.normalize('NFD'))}`);
    expect(nfd.json<{ data: Theme }>().data.id).toBe(shown.id);
    const byId = await get(`/themes/${shown.id.toUpperCase()}`);
    expect(byId.json<{ data: Theme }>().data.slug).toBe('2026-노벨상');
  });

  it('answers NOT_FOUND for an unpublished or unknown theme on every route, 400 for a malformed id', async () => {
    const hidden = await theme({ publishedAt: null });
    const open = await market();
    await put(hidden.id, open.id);
    for (const id of [hidden.id, randomUUID()]) {
      for (const suffix of ['', '/markets', '/results']) {
        const res = await get(`/themes/${id}${suffix}`);
        expect({ suffix, status: res.statusCode }).toEqual({ suffix, status: 404 });
      }
    }
    // The page by an unpublished theme's slug or an unknown one is the same 404; a slug longer
    // than any is malformed. The sub-lists take the id alone.
    expect((await get(`/themes/${hidden.slug}`)).statusCode).toBe(404);
    expect((await get('/themes/no-such-theme')).statusCode).toBe(404);
    expect((await get(`/themes/${'a'.repeat(81)}`)).statusCode).toBe(400);
    expect((await get(`/themes/${hidden.slug}/markets`)).statusCode).toBe(400);
    // Nor is it on the detail of a market it holds.
    const links = await get(`/markets/${open.id}/themes`);
    expect(links.json<{ data: ThemeSummary[] }>().data).toEqual([]);
  });

  it('lists the theme’s markets in every public status but a draft, voided too: open ones first, then the ended', async () => {
    const hub = await theme();
    const now = (await clockTimestamp(t.db)).getTime();
    const soon = await market({ closeAt: new Date(now + DAY_MS) });
    const later = await market({ closeAt: new Date(now + 3 * DAY_MS) });
    const closed = await market({ status: 'closed', closeAt: new Date(now - HOUR_MS) });
    const settled = await market({
      status: 'settled',
      resolvedResult: 'NO',
      resolvedAt: new Date(now - DAY_MS),
      settledAt: new Date(now - DAY_MS),
      closeAt: new Date(now - 2 * DAY_MS),
    });
    const voided = await market({ status: 'voided', closeAt: new Date(now - 3 * DAY_MS) });
    const draft = await market({ status: 'draft' });
    for (const linked of [settled, draft, later, voided, closed, soon]) {
      await put(hub.id, linked.id);
    }
    // Another published theme's market, closing soonest of all, and one in no theme: neither is
    // this theme's.
    const other = await theme();
    const othersOwn = await market({ closeAt: new Date(now + HOUR_MS) });
    await put(other.id, othersOwn.id);
    await market({ closeAt: new Date(now + 2 * HOUR_MS) });
    const expected = [soon.id, later.id, closed.id, settled.id, voided.id];
    const first = await page<MarketSummary>(`/themes/${hub.id}/markets`);
    expect(first.data.map((row) => row.id)).toEqual(expected);
    expect(await walk(`/themes/${hub.id}/markets?limit=2`)).toEqual(expected);
    expect(await walk(`/themes/${other.id}/markets`)).toEqual([othersOwn.id]);
    // The card is the list row, nothing about who put it in.
    const listRow = (await page<MarketSummary>('/markets')).data.find((row) => row.id === soon.id);
    expect(first.data[0]).toEqual(listRow);
  });

  it('lists the results of the judged and voided markets only, the latest decided first', async () => {
    const hub = await theme();
    const now = (await clockTimestamp(t.db)).getTime();
    const yes = await market({
      status: 'resolved',
      resolvedResult: 'YES',
      resolvedAt: new Date(now - HOUR_MS),
    });
    const no = await market({
      status: 'settled',
      resolvedResult: 'NO',
      resolvedAt: new Date(now - 2 * HOUR_MS),
      settledAt: new Date(now - HOUR_MS),
    });
    const voided = await market({ status: 'voided', voidedAt: new Date(now - 3 * HOUR_MS) });
    for (const linked of [
      voided,
      await market(),
      await market({ status: 'closed' }),
      await market({ status: 'draft' }),
      no,
      yes,
    ]) {
      await put(hub.id, linked.id);
    }
    // A result of another published theme, decided last of all, and one in no theme: neither is
    // among this theme's results.
    const other = await theme();
    const othersOwn = await market({
      status: 'resolved',
      resolvedResult: 'NO',
      resolvedAt: new Date(now - 60_000),
    });
    await put(other.id, othersOwn.id);
    await market({ status: 'voided', voidedAt: new Date(now - 30_000) });
    const results = (await page<ThemeResult>(`/themes/${hub.id}/results`)).data;
    expect(results).toEqual([
      {
        marketId: yes.id,
        slug: yes.slug,
        title: yes.title,
        status: 'resolved',
        result: 'YES',
        decidedAt: new Date(now - HOUR_MS).toISOString(),
      },
      expect.objectContaining({ marketId: no.id, status: 'settled', result: 'NO' }),
      {
        marketId: voided.id,
        slug: voided.slug,
        title: voided.title,
        status: 'voided',
        result: null,
        decidedAt: new Date(now - 3 * HOUR_MS).toISOString(),
      },
    ]);
    expect(await walk(`/themes/${hub.id}/results?limit=1`, 'marketId')).toEqual([
      yes.id,
      no.id,
      voided.id,
    ]);
    expect(await walk(`/themes/${other.id}/results`, 'marketId')).toEqual([othersOwn.id]);
  });

  it('links a market’s detail to the published themes it is in, any status, in the list’s order', async () => {
    const today = await kstToday();
    const linked = await market();
    const ended = await theme({ startDate: shift(today, -10), endDate: shift(today, -5) });
    const ongoing = await theme({ startDate: shift(today, -1), endDate: shift(today, 5) });
    const unpublished = await theme({ publishedAt: null });
    // Published and holding a market, only not this one.
    const unrelated = await theme();
    await put(unrelated.id, (await market()).id);
    for (const holder of [ended, ongoing, unpublished]) await put(holder.id, linked.id);
    const res = await get(`/markets/${linked.id}/themes`);
    expect(res.statusCode).toBe(200);
    const rows = res.json<{ data: ThemeSummary[] }>().data;
    expect(rows.map((row) => [row.id, row.status])).toEqual([
      [ongoing.id, 'ongoing'],
      [ended.id, 'ended'],
    ]);
    expect(rows.map((row) => row.id)).not.toContain(unrelated.id);
    // A draft market has no detail, and so no themes either.
    const draft = await market({ status: 'draft' });
    await put(ongoing.id, draft.id);
    expect((await get(`/markets/${draft.id}/themes`)).statusCode).toBe(404);
    expect((await get(`/markets/${randomUUID()}/themes`)).statusCode).toBe(404);
    expect((await get(`/markets/${linked.slug}/themes`)).statusCode).toBe(400);
  });
});
