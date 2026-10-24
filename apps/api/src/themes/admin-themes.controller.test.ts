/**
 * 테마 (#81) for admins against the docker `test` profile: making, editing, publishing and
 * unpublishing a theme, putting markets in and taking them out, and the page's notices
 * (`/admin/themes`). Owner decisions under test (ADR-0069 decision 4, the #81 rows): admins only;
 * free composition (any market status, no cap, a market in several themes, editable after the
 * period); unpublished, never deleted; the admin and the time recorded for every change and
 * nothing else, no second admin; a theme touches none of its markets. And of 2026-10-19
 * (ADR-0088): the period in Korean dates, a notice hidden and never deleted, the slug chosen at
 * creation and fixed once published, a publish only with a market in it. And this PR's choice:
 * every write that changes nothing records nothing.
 * Skips when TEST_* are unset.
 */
import { clockTimestamp, schema } from '@buddha/db';
import {
  closeAccount,
  completeOnboarding,
  createCategory,
  createMarket,
  createTheme,
  createThemeMarket,
  createThemeNotice,
} from '@buddha/db/test';
import {
  koreanDateAt,
  type AdminTheme,
  type AdminThemeMarket,
  type AdminThemeSummary,
  type Theme,
} from '@buddha/shared';
import { randomUUID } from 'node:crypto';
import { asc, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { ThemeAdminService } from './theme-admin.service.js';
import { dateOfEpochDay, epochDayOf } from './theme-rows.js';

const ORIGIN = 'http://localhost:3000';
const jsonHeaders = { origin: ORIGIN, 'content-type': 'application/json' };

type ErrorBody = {
  error: { code: string; message: string; details?: { path: (string | number)[] }[] };
};

describe.skipIf(!hasTestInfra)('themes for admins (integration)', () => {
  let t: TestApp;
  let admin: TestUser;
  let other: TestUser;
  let member: TestUser;
  let category: { id: number };

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    admin = await signUpTestUser(t);
    other = await signUpTestUser(t);
    member = await signUpTestUser(t);
    for (const user of [admin, other]) {
      await t.db
        .update(schema.profiles)
        .set({ role: 'admin' })
        .where(eq(schema.profiles.userId, user.id));
      // The guard caches roles for 60 s (PLAN 10.5); the promotion above happened behind it.
      await t.app.get(AdminGuard).invalidate(user.id);
      // Past the onboarding, as every /admin route asks of an admin (ADR-0072, admin-access.test).
      await completeOnboarding(t.db, { userId: user.id });
    }
    category = await createCategory(t.db, { slug: 'economy', nameKo: '경제' });
  });

  const market = (input: Parameters<typeof createMarket>[1] = {}) =>
    createMarket(t.db, { createdBy: admin.id, categoryId: category.id, ...input });

  const send = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
    /** `null` for a visitor with no session; the admin's by default. */
    cookie: string | null = admin.cookie,
  ) =>
    t.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        ...(payload === undefined ? { origin: ORIGIN } : jsonHeaders),
        ...(cookie ? { cookie } : {}),
      },
      ...(payload === undefined ? {} : { payload }),
    });

  const data = <T>(res: { json: <U>() => U }) => res.json<{ data: T }>().data;
  const errorOf = (res: { json: <U>() => U }) => res.json<ErrorBody>().error;

  /** The Korean date `days` from `date`. */
  const shift = (date: string, days: number) => dateOfEpochDay(epochDayOf(date) + days);
  /** A period of Korean dates around today (KST): 진행 중 from yesterday for a week. */
  async function period(offsetDays = 0) {
    const today = shift(koreanDateAt(await clockTimestamp(t.db)), offsetDays);
    return { startDate: shift(today, -1), endDate: shift(today, 7) };
  }

  let slugs = 0;
  async function create(input: Partial<{ slug: string; name: string; intro: string }> = {}) {
    slugs += 1;
    const res = await send('POST', '/admin/themes', {
      slug: input.slug ?? `theme-${String(slugs)}`,
      name: input.name ?? '노벨상 주간',
      intro: input.intro ?? '수상자를 두고 거래하는 시장 모음',
      ...(await period()),
    });
    expect(res.statusCode).toBe(201);
    return data<AdminTheme>(res);
  }

  /** Puts a fresh open market in the theme without a record, so the theme may be published. */
  async function withMarket(themeId: string) {
    const linked = await market();
    await createThemeMarket(t.db, { themeId, marketId: linked.id, createdBy: admin.id });
    return linked;
  }

  async function actions() {
    return t.db
      .select()
      .from(schema.adminActions)
      .where(like(schema.adminActions.type, 'theme_%'))
      .orderBy(asc(schema.adminActions.createdAt));
  }
  const types = async () => (await actions()).map((row) => row.type);

  async function nicknameOf(userId: string) {
    const [row] = await t.db
      .select({ nickname: schema.profiles.nickname })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, userId));
    return row!.nickname;
  }

  /** The public page's status code: 200 while published, 404 otherwise. */
  const publicStatus = async (id: string) =>
    (await t.app.inject({ method: 'GET', url: `/api/v1/themes/${id}` })).statusCode;

  it('creates an unpublished theme and records who and when, with what it wrote', async () => {
    const theme = await create({
      slug: '2026-노벨상',
      name: '  노벨상 주간 ',
      intro: '첫 줄\n둘째 줄',
    });
    expect(theme).toMatchObject({
      slug: '2026-노벨상',
      name: '노벨상 주간',
      intro: '첫 줄\n둘째 줄',
      status: 'ongoing',
      publishedAt: null,
      firstPublishedAt: null,
      createdBy: { id: admin.id, nickname: await nicknameOf(admin.id) },
      notices: [],
    });
    // Not public until it is published.
    expect(await publicStatus(theme.id)).toBe(404);

    const [audit] = await actions();
    expect(audit).toMatchObject({
      adminId: admin.id,
      type: 'theme_create',
      targetType: 'theme',
      targetId: theme.id,
      payload: {
        slug: '2026-노벨상',
        name: '노벨상 주간',
        intro: '첫 줄\n둘째 줄',
        startDate: theme.startDate,
        endDate: theme.endDate,
      },
    });
    // One clock reading for the row and its record; no reason is asked or kept, and the keys
    // are the ones ADMIN_ACTION_TYPES documents.
    expect(audit!.createdAt.toISOString()).toBe(theme.createdAt);
    expect(Object.keys(audit!.payload ?? {}).sort()).toEqual([
      'endDate',
      'intro',
      'name',
      'slug',
      'startDate',
    ]);
  });

  it('refuses a theme without its fields, with a period that ends before it starts or a taken slug', async () => {
    const { startDate, endDate } = await period();
    const base = { slug: 'nobel-week', name: '테마', intro: '소개', startDate, endDate };
    for (const body of [
      { ...base, name: ' ' },
      { ...base, intro: '' },
      { slug: 'nobel-week', name: '테마', intro: '소개', startDate },
      { name: '테마', intro: '소개', startDate, endDate },
      { ...base, slug: 'No Spaces' },
      { ...base, endDate: shift(startDate, -1) },
      { ...base, startDate: `${startDate}T00:00:00Z` },
    ]) {
      const res = await send('POST', '/admin/themes', body);
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
    }
    const backwards = await send('POST', '/admin/themes', {
      ...base,
      endDate: shift(startDate, -1),
    });
    expect(errorOf(backwards).details?.map((detail) => detail.path)).toEqual([['endDate']]);
    expect(await t.db.select().from(schema.themes)).toEqual([]);
    expect(await actions()).toEqual([]);
    // A one-day theme is a period: both days are in it.
    const oneDay = await send('POST', '/admin/themes', { ...base, endDate: startDate });
    expect(oneDay.statusCode).toBe(201);
    // The address is one theme's: another theme asking for it is told which field.
    const taken = await send('POST', '/admin/themes', { ...base, name: '다른 테마' });
    expect(taken.statusCode).toBe(400);
    expect(errorOf(taken).details).toEqual([{ path: ['slug'], message: 'already exists' }]);
    expect(await types()).toEqual(['theme_create']);
  });

  it('takes the dates from 2000-01-01 to 2100-12-31 and refuses others naming the field, the year 0000 too and not as a 500 (owner decision 2026-10-19, second round)', async () => {
    const base = { slug: 'far-dates', name: '테마', intro: '소개' };
    for (const [field, body] of [
      ['startDate', { startDate: '1999-12-31', endDate: '2026-10-20' }],
      ['endDate', { startDate: '2026-10-20', endDate: '2101-01-01' }],
      ['startDate', { startDate: '0000-01-01', endDate: '2026-10-20' }],
      ['endDate', { startDate: '2000-01-01', endDate: '9999-12-31' }],
    ] as const) {
      const res = await send('POST', '/admin/themes', { ...base, ...body });
      expect(res.statusCode).toBe(400);
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
      expect(errorOf(res).details).toContainEqual({
        path: [field],
        message: 'must be between 2000-01-01 and 2100-12-31',
      });
    }
    expect(await t.db.select().from(schema.themes)).toEqual([]);
    const far = await send('POST', '/admin/themes', {
      ...base,
      startDate: '2000-01-01',
      endDate: '2100-12-31',
    });
    expect(far.statusCode).toBe(201);
    const stored = data<AdminTheme>(far);
    expect(stored).toMatchObject({ startDate: '2000-01-01', endDate: '2100-12-31' });
    for (const [field, body] of [
      ['startDate', { startDate: '1999-12-31' }],
      ['endDate', { endDate: '2101-01-01' }],
      ['startDate', { startDate: '0000-06-01' }],
      ['endDate', { endDate: '9999-12-31' }],
    ] as const) {
      const edited = await send('PATCH', `/admin/themes/${stored.id}`, body);
      expect(edited.statusCode).toBe(400);
      expect(errorOf(edited).details).toEqual([
        { path: [field], message: 'must be between 2000-01-01 and 2100-12-31' },
      ]);
    }
    expect(await types()).toEqual(['theme_create']);
  });

  it('edits any field at any time, records only what changed, before and after', async () => {
    const theme = await create();
    const renamed = await send('PATCH', `/admin/themes/${theme.id}`, { name: '새 이름' });
    expect(renamed.statusCode).toBe(200);
    expect(data<AdminTheme>(renamed)).toMatchObject({ name: '새 이름', intro: theme.intro });
    const [, update] = await actions();
    expect(update).toMatchObject({
      type: 'theme_update',
      targetId: theme.id,
      payload: { before: { name: '노벨상 주간' }, after: { name: '새 이름' } },
    });

    // The same values again change nothing and record nothing.
    const same = await send('PATCH', `/admin/themes/${theme.id}`, {
      name: '새 이름',
      startDate: theme.startDate,
      slug: theme.slug,
    });
    expect(same.statusCode).toBe(200);
    expect(await types()).toEqual(['theme_create', 'theme_update']);

    // After the period, too (ADR-0069 decision 4, '끝난 뒤에도 편성 수정'): moved into the past, it
    // is 종료 and still edited.
    const past = {
      startDate: shift(theme.startDate, -30),
      endDate: shift(theme.startDate, -20),
    };
    const moved = await send('PATCH', `/admin/themes/${theme.id}`, past);
    expect(data<AdminTheme>(moved)).toMatchObject({ ...past, status: 'ended' });
    const edited = await send('PATCH', `/admin/themes/${theme.id}`, { intro: '끝난 뒤 고친 소개' });
    expect(data<AdminTheme>(edited)).toMatchObject({ intro: '끝난 뒤 고친 소개', status: 'ended' });
    const records = await actions();
    expect(records.map((row) => row.payload)).toEqual([
      expect.anything(),
      expect.anything(),
      { before: { startDate: theme.startDate, endDate: theme.endDate }, after: past },
      { before: { intro: theme.intro }, after: { intro: '끝난 뒤 고친 소개' } },
    ]);
  });

  it('checks a period half sent alone against the other as stored, naming the half sent', async () => {
    const theme = await create();
    const late = shift(theme.endDate, 1);
    const early = shift(theme.startDate, -1);
    const startAfterEnd = await send('PATCH', `/admin/themes/${theme.id}`, { startDate: late });
    expect(startAfterEnd.statusCode).toBe(400);
    // The words of THEME_REFUSALS, which the edit form reads to say which half is out of order.
    expect(errorOf(startAfterEnd).details).toEqual([
      { path: ['startDate'], message: 'must not be after endDate' },
    ]);
    const endBeforeStart = await send('PATCH', `/admin/themes/${theme.id}`, { endDate: early });
    expect(errorOf(endBeforeStart).details).toEqual([
      { path: ['endDate'], message: 'must not be before startDate' },
    ]);
    const bothBackwards = await send('PATCH', `/admin/themes/${theme.id}`, {
      startDate: theme.endDate,
      endDate: early,
    });
    expect(errorOf(bothBackwards).details).toEqual([
      { path: ['endDate'], message: 'must not be before startDate' },
    ]);
    expect(await types()).toEqual(['theme_create']);
    // The end on the start's own day is a one-day period, not a refusal.
    const oneDay = await send('PATCH', `/admin/themes/${theme.id}`, { endDate: theme.startDate });
    expect(data<AdminTheme>(oneDay).endDate).toBe(theme.startDate);
    expect((await send('PATCH', `/admin/themes/${randomUUID()}`, { name: 'x' })).statusCode).toBe(
      404,
    );
  });

  it('publishes only a theme with a public market in it, and any admin may then empty it (owner decisions 2026-10-19)', async () => {
    const refusedFor = {
      path: ['markets'],
      message: 'at least one market that is not a draft is required to publish',
    };
    // Another theme holds a market: the count is this theme's own.
    const busy = await create();
    await withMarket(busy.id);
    const theme = await create();
    const empty = await send('POST', `/admin/themes/${theme.id}/publish`);
    expect(empty.statusCode).toBe(400);
    expect(errorOf(empty)).toMatchObject({ code: 'VALIDATION_ERROR', details: [refusedFor] });
    expect(await publicStatus(theme.id)).toBe(404);
    // A draft does not count (second round): it is on no public page, so the theme would go
    // public as an empty page.
    const draft = await market({ status: 'draft' });
    await send('POST', `/admin/themes/${theme.id}/markets`, { marketId: draft.id });
    const draftOnly = await send('POST', `/admin/themes/${theme.id}/publish`);
    expect(draftOnly.statusCode).toBe(400);
    expect(errorOf(draftOnly)).toMatchObject({ code: 'VALIDATION_ERROR', details: [refusedFor] });
    expect(await publicStatus(theme.id)).toBe(404);
    // Once the draft opens, it counts.
    await t.db
      .update(schema.markets)
      .set({ status: 'open' })
      .where(eq(schema.markets.id, draft.id));
    const published = await send('POST', `/admin/themes/${theme.id}/publish`);
    expect(published.statusCode).toBe(200);
    // Taking every market out afterwards is allowed; the theme stays public.
    await send('DELETE', `/admin/themes/${theme.id}/markets/${draft.id}`);
    expect(await publicStatus(theme.id)).toBe(200);
    expect(await types()).toEqual([
      'theme_create',
      'theme_create',
      'theme_market_link',
      'theme_publish',
      'theme_market_unlink',
    ]);
    // Already public, so a publish again is no change and no refusal.
    expect((await send('POST', `/admin/themes/${theme.id}/publish`)).statusCode).toBe(200);
  });

  it('counts every public status toward a publish, a voided or ended market too, and never a draft', async () => {
    for (const status of ['open', 'closed', 'resolved', 'settled', 'voided'] as const) {
      const theme = await create();
      // A draft beside it changes nothing either way.
      const draft = await market({ status: 'draft' });
      const shown = await market({ status });
      for (const linked of [draft, shown]) {
        await createThemeMarket(t.db, {
          themeId: theme.id,
          marketId: linked.id,
          createdBy: admin.id,
        });
      }
      const res = await send('POST', `/admin/themes/${theme.id}/publish`);
      expect(res.statusCode, status).toBe(200);
    }
  });

  it('refuses an edit to another theme’s slug naming slug, as a create is refused', async () => {
    await create({ slug: 'first-address' });
    const second = await create({ slug: 'other-address' });
    const taken = await send('PATCH', `/admin/themes/${second.id}`, { slug: 'first-address' });
    expect(taken.statusCode).toBe(400);
    expect(errorOf(taken)).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ path: ['slug'], message: 'already exists' }],
    });
    expect(data<AdminTheme>(await send('GET', `/admin/themes/${second.id}`)).slug).toBe(
      'other-address',
    );
    expect(await types()).toEqual(['theme_create', 'theme_create']);
  });

  it('changes the slug until the first publish and never after, unpublished or not (owner decision 2026-10-19)', async () => {
    const theme = await create({ slug: 'first-address' });
    const moved = await send('PATCH', `/admin/themes/${theme.id}`, { slug: 'second-address' });
    expect(data<AdminTheme>(moved).slug).toBe('second-address');
    expect((await actions()).at(-1)?.payload).toEqual({
      before: { slug: 'first-address' },
      after: { slug: 'second-address' },
    });
    await withMarket(theme.id);
    const published = data<AdminTheme>(await send('POST', `/admin/themes/${theme.id}/publish`));
    expect(published.firstPublishedAt).toBe(published.publishedAt);
    expect(await publicStatus('second-address')).toBe(200);
    // The address may have been announced: fixed from the first publish on, through an unpublish.
    await send('POST', `/admin/themes/${theme.id}/unpublish`);
    const fixed = await send('PATCH', `/admin/themes/${theme.id}`, {
      slug: 'third-address',
      name: '함께 보낸 이름',
    });
    expect(fixed.statusCode).toBe(400);
    expect(errorOf(fixed).details).toEqual([{ path: ['slug'], message: 'fixed once published' }]);
    // The same slug again is no change, so a form that sends every field still saves.
    const same = await send('PATCH', `/admin/themes/${theme.id}`, {
      slug: 'second-address',
      name: '새 이름',
    });
    expect(data<AdminTheme>(same)).toMatchObject({ slug: 'second-address', name: '새 이름' });
    // A second publish keeps the first one's time as the fixing time.
    const again = data<AdminTheme>(await send('POST', `/admin/themes/${theme.id}/publish`));
    expect(again.firstPublishedAt).toBe(published.publishedAt);
    expect(again.publishedAt).not.toBe(published.publishedAt);
  });

  it('publishes and unpublishes, each once, and never deletes', async () => {
    const theme = await create();
    await withMarket(theme.id);
    const published = data<AdminTheme>(await send('POST', `/admin/themes/${theme.id}/publish`));
    expect(published.publishedAt).not.toBeNull();
    expect(await publicStatus(theme.id)).toBe(200);
    // Again: nothing changes, nothing is recorded, the first publish time stays.
    const again = data<AdminTheme>(await send('POST', `/admin/themes/${theme.id}/publish`));
    expect(again.publishedAt).toBe(published.publishedAt);

    const unpublished = data<AdminTheme>(await send('POST', `/admin/themes/${theme.id}/unpublish`));
    expect(unpublished.publishedAt).toBeNull();
    expect(await publicStatus(theme.id)).toBe(404);
    expect((await send('POST', `/admin/themes/${theme.id}/unpublish`)).statusCode).toBe(200);
    expect(await types()).toEqual(['theme_create', 'theme_publish', 'theme_unpublish']);
    const [, publish, unpublish] = await actions();
    expect(publish).toMatchObject({ adminId: admin.id, targetId: theme.id, payload: null });
    expect(publish!.createdAt.toISOString()).toBe(published.publishedAt);
    expect(unpublish).toMatchObject({ targetId: theme.id, payload: null });

    // Kept for the admin, and there is no route that deletes it.
    const list = data<AdminThemeSummary[]>(await send('GET', '/admin/themes'));
    expect(list.map((row) => row.id)).toEqual([theme.id]);
    expect((await send('DELETE', `/admin/themes/${theme.id}`)).statusCode).toBe(404);
    expect(await t.db.select().from(schema.themes)).toHaveLength(1);
    // Another admin may publish it again: any admin, no second admin's approval.
    const republished = await send(
      'POST',
      `/admin/themes/${theme.id}/publish`,
      undefined,
      other.cookie,
    );
    expect(data<AdminTheme>(republished).publishedAt).not.toBeNull();
    expect((await actions()).at(-1)).toMatchObject({ type: 'theme_publish', adminId: other.id });
  });

  it('records one publish when two admins publish at once', async () => {
    const theme = await create();
    await withMarket(theme.id);
    const answers = await Promise.all([
      send('POST', `/admin/themes/${theme.id}/publish`),
      send('POST', `/admin/themes/${theme.id}/publish`, undefined, other.cookie),
      send('POST', `/admin/themes/${theme.id}/publish`),
    ]);
    expect(answers.map((res) => res.statusCode)).toEqual([200, 200, 200]);
    expect(await types()).toEqual(['theme_create', 'theme_publish']);
  });

  it('puts markets of any status in and takes them out, each change once, naming who put it in', async () => {
    const theme = await create();
    const draft = await market({ status: 'draft' });
    const open = await market();
    const voided = await market({ status: 'voided' });
    for (const linked of [draft, open, voided]) {
      const res = await send('POST', `/admin/themes/${theme.id}/markets`, { marketId: linked.id });
      expect(res.statusCode).toBe(200);
    }
    const rows = data<AdminThemeMarket[]>(await send('GET', `/admin/themes/${theme.id}/markets`));
    // The latest put in first, every status, who and when.
    expect(rows.map((row) => row.id)).toEqual([voided.id, open.id, draft.id]);
    expect(rows[0]).toMatchObject({
      status: 'voided',
      linkedBy: { id: admin.id, nickname: await nicknameOf(admin.id) },
    });
    // Again, upper-cased: the same market, nothing written.
    const again = await send('POST', `/admin/themes/${theme.id}/markets`, {
      marketId: open.id.toUpperCase(),
    });
    expect(data<AdminThemeMarket[]>(again)).toHaveLength(3);

    const removed = await send('DELETE', `/admin/themes/${theme.id}/markets/${open.id}`);
    expect(data<AdminThemeMarket[]>(removed).map((row) => row.id)).toEqual([voided.id, draft.id]);
    expect((await send('DELETE', `/admin/themes/${theme.id}/markets/${open.id}`)).statusCode).toBe(
      200,
    );
    expect(await types()).toEqual([
      'theme_create',
      'theme_market_link',
      'theme_market_link',
      'theme_market_link',
      'theme_market_unlink',
    ]);
    const unlink = (await actions()).at(-1);
    expect(unlink).toMatchObject({
      adminId: admin.id,
      targetType: 'theme',
      targetId: theme.id,
      payload: { themeId: theme.id, marketId: open.id },
    });
    const stored = await t.db
      .select()
      .from(schema.themeMarkets)
      .where(eq(schema.themeMarkets.marketId, voided.id));
    expect(rows[0]!.linkedAt).toBe(stored[0]!.createdAt.toISOString());
  });

  it('puts one market in several themes, and any number of markets in one', async () => {
    const [one, two] = [await create(), await create({ name: '두 번째' })];
    const shared = await market();
    for (const theme of [one, two]) {
      await send('POST', `/admin/themes/${theme.id}/markets`, { marketId: shared.id });
    }
    // No cap (ADR-0069 decision 4, '시장 수 상한 없음'): 30 more in the first.
    for (let i = 0; i < 30; i += 1) {
      const linked = await market();
      expect(
        (await send('POST', `/admin/themes/${one.id}/markets`, { marketId: linked.id })).statusCode,
      ).toBe(200);
    }
    expect(
      data<AdminThemeMarket[]>(await send('GET', `/admin/themes/${one.id}/markets`)),
    ).toHaveLength(31);
    expect(
      data<AdminThemeMarket[]>(await send('GET', `/admin/themes/${two.id}/markets`)).map(
        (row) => row.id,
      ),
    ).toEqual([shared.id]);

    // Taking it out of one theme leaves it in the other.
    const removed = await send('DELETE', `/admin/themes/${one.id}/markets/${shared.id}`);
    expect(removed.statusCode).toBe(200);
    const left = data<AdminThemeMarket[]>(removed);
    expect(left).toHaveLength(30);
    expect(left.map((row) => row.id)).not.toContain(shared.id);
    expect(
      data<AdminThemeMarket[]>(await send('GET', `/admin/themes/${two.id}/markets`)).map(
        (row) => row.id,
      ),
    ).toEqual([shared.id]);
    const rows = await t.db
      .select()
      .from(schema.themeMarkets)
      .where(eq(schema.themeMarkets.marketId, shared.id));
    expect(rows.map((row) => row.themeId)).toEqual([two.id]);
    expect((await actions()).at(-1)).toMatchObject({
      type: 'theme_market_unlink',
      targetId: one.id,
      payload: { themeId: one.id, marketId: shared.id },
    });
  });

  it('records one link when two admins put the same market in at once, and one unlink likewise', async () => {
    const theme = await create();
    const linked = await market();
    const url = `/admin/themes/${theme.id}/markets`;
    const links = await Promise.all([
      send('POST', url, { marketId: linked.id }),
      send('POST', url, { marketId: linked.id }, other.cookie),
      send('POST', url, { marketId: linked.id }),
    ]);
    expect(links.map((res) => res.statusCode)).toEqual([200, 200, 200]);
    const unlinks = await Promise.all([
      send('DELETE', `${url}/${linked.id}`),
      send('DELETE', `${url}/${linked.id}`, undefined, other.cookie),
    ]);
    expect(unlinks.map((res) => res.statusCode)).toEqual([200, 200]);
    expect(await types()).toEqual(['theme_create', 'theme_market_link', 'theme_market_unlink']);
  });

  it('refuses unknown themes, markets and notices, naming the field that sent them', async () => {
    const theme = await create();
    const linked = await market();
    const unknown = randomUUID();
    const body = await send('POST', `/admin/themes/${theme.id}/markets`, { marketId: unknown });
    expect(body.statusCode).toBe(404);
    expect(errorOf(body).details?.[0]?.path).toEqual(['marketId']);
    const path = await send('DELETE', `/admin/themes/${theme.id}/markets/${unknown}`);
    expect(path.statusCode).toBe(404);
    expect(errorOf(path).details?.[0]?.path).toEqual(['marketId']);
    for (const res of [
      await send('POST', `/admin/themes/${unknown}/markets`, { marketId: linked.id }),
      await send('GET', `/admin/themes/${unknown}`),
      await send('GET', `/admin/themes/${unknown}/markets`),
      await send('POST', `/admin/themes/${unknown}/publish`),
      await send('POST', `/admin/themes/${unknown}/notices`, { title: '안내', body: '내용' }),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(errorOf(res).details).toBeUndefined();
    }
    // A notice of another theme is not this theme's.
    const second = await create({ name: '다른 테마' });
    const withNotice = data<AdminTheme>(
      await send('POST', `/admin/themes/${second.id}/notices`, { title: '안내', body: '내용' }),
    );
    const foreign = await send(
      'PATCH',
      `/admin/themes/${theme.id}/notices/${withNotice.notices[0]!.id}`,
      { title: '바꿈' },
    );
    expect(foreign.statusCode).toBe(404);
    expect(errorOf(foreign).details?.[0]?.path).toEqual(['noticeId']);
    // Malformed ids are bad input, not a 500.
    expect((await send('GET', '/admin/themes/nope')).statusCode).toBe(400);
    expect(
      (await send('POST', `/admin/themes/${theme.id}/markets`, { marketId: 'nope' })).statusCode,
    ).toBe(400);
    expect(await types()).toEqual(['theme_create', 'theme_create', 'theme_notice_create']);
  });

  it('writes, edits, hides and shows notices, keeping the earlier text in the record only', async () => {
    const theme = await create();
    await withMarket(theme.id);
    await send('POST', `/admin/themes/${theme.id}/publish`);
    const first = data<AdminTheme>(
      await send('POST', `/admin/themes/${theme.id}/notices`, {
        title: ' 일정 안내 ',
        body: '첫 줄\n둘째 줄',
      }),
    );
    const notice = first.notices[0]!;
    expect(notice).toMatchObject({
      title: '일정 안내',
      body: '첫 줄\n둘째 줄',
      editedAt: null,
      hiddenAt: null,
      createdBy: { id: admin.id, nickname: await nicknameOf(admin.id) },
    });
    const second = data<AdminTheme>(
      await send('POST', `/admin/themes/${theme.id}/notices`, { title: '둘째', body: '내용' }),
    );
    // Newest first.
    expect(second.notices.map((row) => row.title)).toEqual(['둘째', '일정 안내']);

    const editedTheme = data<AdminTheme>(
      await send('PATCH', `/admin/themes/${theme.id}/notices/${notice.id}`, { body: '고친 내용' }),
    );
    const edited = editedTheme.notices.find((row) => row.id === notice.id)!;
    expect(edited).toMatchObject({ title: '일정 안내', body: '고친 내용' });
    expect(edited.editedAt).not.toBeNull();
    // The same text again is no edit.
    await send('PATCH', `/admin/themes/${theme.id}/notices/${notice.id}`, { body: '고친 내용' });

    const hidden = data<AdminTheme>(
      await send('POST', `/admin/themes/${theme.id}/notices/${notice.id}/hide`),
    );
    expect(hidden.notices.find((row) => row.id === notice.id)?.hiddenAt).not.toBeNull();
    // Hiding is not an edit, and hiding twice records once.
    expect(hidden.notices.find((row) => row.id === notice.id)?.editedAt).toBe(edited.editedAt);
    await send('POST', `/admin/themes/${theme.id}/notices/${notice.id}/hide`);
    const page = async () =>
      data<Theme>(await t.app.inject({ method: 'GET', url: `/api/v1/themes/${theme.id}` }));
    expect((await page()).notices.map((row) => row.title)).toEqual(['둘째']);

    await send('POST', `/admin/themes/${theme.id}/notices/${notice.id}/show`);
    expect((await page()).notices).toEqual([
      expect.objectContaining({ title: '둘째', editedAt: null }),
      {
        id: notice.id,
        title: '일정 안내',
        body: '고친 내용',
        createdAt: notice.createdAt,
        editedAt: edited.editedAt,
      },
    ]);

    const records = (await actions()).filter((row) => row.type.startsWith('theme_notice_'));
    expect(records.map((row) => [row.type, row.payload])).toEqual([
      ['theme_notice_create', { noticeId: notice.id, title: '일정 안내', body: '첫 줄\n둘째 줄' }],
      ['theme_notice_create', expect.objectContaining({ title: '둘째' })],
      [
        'theme_notice_update',
        { noticeId: notice.id, before: { body: '첫 줄\n둘째 줄' }, after: { body: '고친 내용' } },
      ],
      ['theme_notice_hide', { noticeId: notice.id }],
      ['theme_notice_show', { noticeId: notice.id }],
    ]);
    // Never deleted: there is no route for it.
    expect(
      (await send('DELETE', `/admin/themes/${theme.id}/notices/${notice.id}`)).statusCode,
    ).toBe(404);
    expect(await t.db.select().from(schema.themeNotices)).toHaveLength(2);
  });

  it('commits a change and its record together or not at all', async () => {
    // The record is written, then the transaction fails: neither may remain (AUDITED's rule,
    // admin-audit.test.ts).
    const service = t.app.get<ThemeAdminService, { audit: (...args: unknown[]) => Promise<void> }>(
      ThemeAdminService,
    );
    const original = service.audit.bind(service);
    const failAfterRecord = () =>
      vi.spyOn(service, 'audit').mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error('injected failure');
      });

    const creating = failAfterRecord();
    const failedCreate = await send('POST', '/admin/themes', {
      slug: 'failing',
      name: '실패',
      intro: '소개',
      ...(await period()),
    });
    creating.mockRestore();
    expect(failedCreate.statusCode).toBe(500);
    expect(await t.db.select().from(schema.themes)).toEqual([]);
    expect(await actions()).toEqual([]);

    const theme = await create();
    // In without a record, so the publish below gets as far as its record.
    const kept = await withMarket(theme.id);
    const linked = await market();
    for (const [method, url, payload] of [
      ['POST', `/admin/themes/${theme.id}/publish`, undefined],
      ['POST', `/admin/themes/${theme.id}/markets`, { marketId: linked.id }],
      ['PATCH', `/admin/themes/${theme.id}`, { name: '바뀌지 않음' }],
      ['POST', `/admin/themes/${theme.id}/notices`, { title: '안내', body: '내용' }],
    ] as const) {
      const failing = failAfterRecord();
      const res = await send(method, url, payload);
      failing.mockRestore();
      expect({ url, status: res.statusCode }).toEqual({ url, status: 500 });
    }
    const after = data<AdminTheme>(await send('GET', `/admin/themes/${theme.id}`));
    expect(after).toMatchObject({ name: theme.name, publishedAt: null, notices: [] });
    expect((await t.db.select().from(schema.themeMarkets)).map((row) => row.marketId)).toEqual([
      kept.id,
    ]);
    expect(await types()).toEqual(['theme_create']);
  });

  it('touches none of its markets: no row, rule, status or event moves', async () => {
    const theme = await create();
    const traded = await market({ lastPrice: 61, tradeCount: 3, volumeCoin: 700n });
    const closed = await market({ status: 'closed' });
    const row = async (id: string) =>
      (await t.db.select().from(schema.markets).where(eq(schema.markets.id, id)))[0];
    const before = [await row(traded.id), await row(closed.id)];
    for (const linked of [traded, closed]) {
      await send('POST', `/admin/themes/${theme.id}/markets`, { marketId: linked.id });
    }
    await send('POST', `/admin/themes/${theme.id}/publish`);
    await send('PATCH', `/admin/themes/${theme.id}`, await period(-30));
    await send('POST', `/admin/themes/${theme.id}/unpublish`);
    await send('DELETE', `/admin/themes/${theme.id}/markets/${traded.id}`);
    expect([await row(traded.id), await row(closed.id)]).toEqual(before);
    expect(await t.db.select().from(schema.marketEvents)).toEqual([]);
  });

  it('lists every theme for the admin, newest first, page by page', async () => {
    const now = (await clockTimestamp(t.db)).getTime();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const theme = await createTheme(t.db, {
        createdBy: admin.id,
        createdAt: new Date(now - i * 1000),
        publishedAt: i % 2 === 0 ? new Date() : null,
      });
      ids.push(theme.id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query = cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
      const res = await send('GET', `/admin/themes?limit=2${query}`);
      expect(res.statusCode).toBe(200);
      const page = res.json<{ data: AdminThemeSummary[]; meta: { nextCursor: string | null } }>();
      seen.push(...page.data.map((row) => row.id));
      cursor = page.meta.nextCursor;
    } while (cursor);
    expect(seen).toEqual(ids);
    const [first] = data<AdminThemeSummary[]>(await send('GET', '/admin/themes?limit=1'));
    expect(first).toMatchObject({ id: ids[0], status: 'ongoing' });
    expect(first!.publishedAt).not.toBeNull();
  });

  it('answers the admin market list of a theme with markets in any status', async () => {
    const theme = await createTheme(t.db, { createdBy: admin.id });
    const draft = await market({ status: 'draft' });
    await createThemeMarket(t.db, { themeId: theme.id, marketId: draft.id, createdBy: other.id });
    const rows = data<AdminThemeMarket[]>(await send('GET', `/admin/themes/${theme.id}/markets`));
    expect(rows).toEqual([
      expect.objectContaining({
        id: draft.id,
        status: 'draft',
        linkedBy: { id: other.id, nickname: await nicknameOf(other.id) },
      }),
    ]);
  });

  it('names an admin who has closed the account since by id alone, with no nickname (#140)', async () => {
    // A former admin: the role revoked, then the account closed (ADR-0086) — the theme, the market
    // it put in and the notice it wrote stay, and the admin screen names it as AdminAccountActor
    // does for every closed account (the screen shows '탈퇴한 사용자').
    const theme = await createTheme(t.db, { createdBy: other.id });
    const linked = await market();
    await createThemeMarket(t.db, { themeId: theme.id, marketId: linked.id, createdBy: other.id });
    await createThemeNotice(t.db, { themeId: theme.id, createdBy: other.id });
    await t.db
      .update(schema.profiles)
      .set({ role: 'user' })
      .where(eq(schema.profiles.userId, other.id));
    await closeAccount(t.db, other.id);

    const read = data<AdminTheme>(await send('GET', `/admin/themes/${theme.id}`));
    expect(read.createdBy).toEqual({ id: other.id, nickname: null });
    expect(read.notices.map((notice) => notice.createdBy)).toEqual([
      { id: other.id, nickname: null },
    ]);
    const rows = data<AdminThemeMarket[]>(await send('GET', `/admin/themes/${theme.id}/markets`));
    expect(rows.map((row) => row.linkedBy)).toEqual([{ id: other.id, nickname: null }]);
  });

  it('is the admin’s alone: members and visitors are refused, and a foreign Origin too', async () => {
    const theme = await create();
    const linked = await market();
    const notice = data<AdminTheme>(
      await send('POST', `/admin/themes/${theme.id}/notices`, { title: '안내', body: '내용' }),
    ).notices[0]!;
    const routes = [
      ['GET', '/admin/themes', undefined],
      [
        'POST',
        '/admin/themes',
        { slug: 'refused', name: '테마', intro: '소개', ...(await period()) },
      ],
      ['GET', `/admin/themes/${theme.id}`, undefined],
      ['PATCH', `/admin/themes/${theme.id}`, { name: '바꿈' }],
      ['POST', `/admin/themes/${theme.id}/publish`, undefined],
      ['POST', `/admin/themes/${theme.id}/unpublish`, undefined],
      ['GET', `/admin/themes/${theme.id}/markets`, undefined],
      ['POST', `/admin/themes/${theme.id}/markets`, { marketId: linked.id }],
      ['DELETE', `/admin/themes/${theme.id}/markets/${linked.id}`, undefined],
      ['POST', `/admin/themes/${theme.id}/notices`, { title: '안내', body: '내용' }],
      ['PATCH', `/admin/themes/${theme.id}/notices/${notice.id}`, { title: '바꿈' }],
      ['POST', `/admin/themes/${theme.id}/notices/${notice.id}/hide`, undefined],
      ['POST', `/admin/themes/${theme.id}/notices/${notice.id}/show`, undefined],
    ] as const;
    const recorded = await types();
    for (const [method, url, payload] of routes) {
      const asMember = await send(method, url, payload, member.cookie);
      expect({ method, url, status: asMember.statusCode }).toEqual({ method, url, status: 403 });
      const anonymous = await send(method, url, payload, null);
      expect({ method, url, status: anonymous.statusCode }).toEqual({ method, url, status: 401 });
    }
    for (const [method, url, payload] of routes.filter(([method]) => method !== 'GET')) {
      const foreign = await t.app.inject({
        method,
        url: `/api/v1${url}`,
        headers: {
          origin: 'https://evil.example',
          cookie: admin.cookie,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { payload }),
      });
      expect({ method, url, status: foreign.statusCode }).toEqual({ method, url, status: 403 });
    }
    expect(await types()).toEqual(recorded);
    expect(await t.db.select().from(schema.themeMarkets)).toEqual([]);
  });
});
