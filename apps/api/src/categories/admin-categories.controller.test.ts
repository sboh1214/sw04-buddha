/**
 * 카테고리 관리 (#17) for admins against the docker `test` profile: the tree on `/admin/categories`
 * — the list with hidden ones and market counts, adding a top-level category or a sub-category,
 * renaming, ordering a group, hiding and showing again. Owner decisions under test (ADR-0093
 * decision 2 #172 item 1 and decision 3's #17 rows): two levels; never deleted, hidden, and a
 * hidden category's markets keep it; operators set the order, a new one last; every add, rename,
 * reorder and hide recorded with the actor, the time and the value before and after, no reason
 * and no second admin; sports and politics may be added (D10). And #17's choices: the slug fixed
 * at creation, a sub-category only under an active top-level one, siblings never sharing a name,
 * a reorder naming every sibling, hiding a parent hiding its sub-categories without touching their
 * own state, and a write that changes nothing recording nothing. The public `GET /categories`
 * answers every write.
 * Skips when TEST_* are unset.
 */
import { clockTimestamp, schema } from '@buddha/db';
import { completeOnboarding, createCategory, createMarket } from '@buddha/db/test';
import {
  CATEGORY_GROUP_MAX,
  CATEGORY_REFUSALS,
  type AdminCategory,
  type Category,
} from '@buddha/shared';
import { asc, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { CategoryAdminService } from './category-admin.service.js';

const ORIGIN = 'http://localhost:3000';
const jsonHeaders = { origin: ORIGIN, 'content-type': 'application/json' };

type ErrorBody = {
  error: {
    code: string;
    message: string;
    details?: { path: (string | number)[]; message: string }[];
  };
};

describe.skipIf(!hasTestInfra)('categories for admins (integration)', () => {
  let t: TestApp;
  let admin: TestUser;
  let other: TestUser;
  let member: TestUser;

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
  });

  /** The account a cookie of this suite signs in as; none for a visitor. */
  const accountOf = (cookie: string | null) =>
    [admin, other, member].find((user) => user.cookie === cookie)?.id;
  /**
   * A request as the screen sends it. A write names the admin on screen (ADR-0092) in its body —
   * the cookie's own account unless `shown` says another, `null` for none.
   */
  const send = (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
    url: string,
    payload?: object,
    /** `null` for a visitor with no session; the admin's by default. */
    cookie: string | null = admin.cookie,
    shown: string | null | undefined = accountOf(cookie),
  ) => {
    const named = method === 'GET' || shown == null ? undefined : shown;
    const body = named === undefined ? payload : { ...payload, expectedAccountId: named };
    return t.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        ...(body === undefined ? { origin: ORIGIN } : jsonHeaders),
        ...(cookie ? { cookie } : {}),
      },
      ...(body === undefined ? {} : { payload: body }),
    });
  };

  const data = <T>(res: { json: <U>() => U }) => res.json<{ data: T }>().data;
  const errorOf = (res: { json: <U>() => U }) => res.json<ErrorBody>().error;

  let slugs = 0;
  /** `POST /admin/categories`, expected to succeed. */
  async function create(input: { slug?: string; nameKo?: string; parentId?: number | null }) {
    slugs += 1;
    const res = await send('POST', '/admin/categories', {
      slug: input.slug ?? `made-${String(slugs)}`,
      nameKo: input.nameKo ?? `만든 ${String(slugs)}`,
      parentId: input.parentId ?? null,
    });
    expect(res.statusCode, res.body).toBe(201);
    return data<AdminCategory>(res);
  }

  const list = async () => data<AdminCategory[]>(await send('GET', '/admin/categories'));
  /** The public `GET /categories`: what explore, the pickers and the interest pick show. */
  const publicList = async () =>
    data<Category[]>(await t.app.inject({ method: 'GET', url: '/api/v1/categories' }));
  const publicIds = async () => (await publicList()).map((row) => row.id);

  async function actions() {
    return t.db
      .select()
      .from(schema.adminActions)
      .where(like(schema.adminActions.type, 'category_%'))
      .orderBy(asc(schema.adminActions.createdAt));
  }
  const types = async () => (await actions()).map((row) => row.type);
  const categoryRows = () =>
    t.db.select().from(schema.categories).orderBy(asc(schema.categories.id));

  /** A VALIDATION_ERROR naming one of the CATEGORY_REFUSALS, as the screen reads it. */
  function expectRefusal(
    res: Awaited<ReturnType<typeof send>>,
    which: (typeof CATEGORY_REFUSALS)[keyof typeof CATEGORY_REFUSALS],
  ) {
    expect(res.statusCode, res.body).toBe(400);
    expect(errorOf(res)).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ path: [which.field], message: which.message }],
    });
  }

  it('lists every category, hidden ones too, in the public order, each with the markets filed under it', async () => {
    const economy = await createCategory(t.db, { slug: 'economy', nameKo: '경제', sortOrder: 20 });
    const culture = await createCategory(t.db, { slug: 'culture', nameKo: '문화', sortOrder: 10 });
    const retired = await createCategory(t.db, {
      slug: 'retired',
      nameKo: '숨김',
      sortOrder: 30,
      isActive: false,
    });
    const rates = await createCategory(t.db, {
      slug: 'rates',
      nameKo: '금리',
      sortOrder: 10,
      parentId: economy.id,
    });
    const jobs = await createCategory(t.db, {
      slug: 'jobs',
      nameKo: '고용',
      sortOrder: 5,
      parentId: economy.id,
      isActive: false,
    });
    const film = await createCategory(t.db, {
      slug: 'film',
      nameKo: '영화',
      sortOrder: 20,
      parentId: culture.id,
    });
    // Any status counts, and a market on the top-level row is its own, not its sub-categories'.
    await createMarket(t.db, { createdBy: admin.id, categoryId: rates.id, status: 'draft' });
    await createMarket(t.db, { createdBy: admin.id, categoryId: rates.id, status: 'closed' });
    await createMarket(t.db, { createdBy: admin.id, categoryId: economy.id });
    await createMarket(t.db, { createdBy: admin.id, categoryId: jobs.id, status: 'review' });

    const rows = await list();
    // parent_id NULLS FIRST, then sort_order, then id: the public list's order, hidden ones in.
    expect(rows.map((row) => row.slug)).toEqual([
      'culture',
      'economy',
      'retired',
      'jobs',
      'rates',
      'film',
    ]);
    expect(rows).toContainEqual({
      id: rates.id,
      slug: 'rates',
      nameKo: '금리',
      sortOrder: 10,
      parentId: economy.id,
      isActive: true,
      marketCount: 2,
    });
    expect(Object.fromEntries(rows.map((row) => [row.slug, row.marketCount]))).toEqual({
      culture: 0,
      economy: 1,
      retired: 0,
      jobs: 1,
      rates: 2,
      film: 0,
    });
    expect(rows.find((row) => row.id === retired.id)?.isActive).toBe(false);
    // The public list is the same order without the hidden ones.
    expect(await publicIds()).toEqual([culture.id, economy.id, rates.id, film.id]);
    // Reading records nothing.
    expect(await actions()).toEqual([]);
  });

  it('adds a top-level category and sub-categories last among their siblings, hidden ones counted, and records who, when and what', async () => {
    await createCategory(t.db, { slug: 'economy', nameKo: '경제', sortOrder: 10 });
    await createCategory(t.db, { slug: 'old', nameKo: '옛것', sortOrder: 40, isActive: false });
    const before = await clockTimestamp(t.db);
    // D10: sports may be added, and the name is trimmed with its inner spaces made one.
    const sports = await create({ slug: 'sports', nameKo: '  스포츠   종합 ' });
    const after = await clockTimestamp(t.db);
    expect(sports).toEqual({
      id: sports.id,
      slug: 'sports',
      nameKo: '스포츠 종합',
      // After the hidden 40, not the shown 10.
      sortOrder: 50,
      parentId: null,
      isActive: true,
      marketCount: 0,
    });
    const [record] = await actions();
    expect(record).toMatchObject({
      adminId: admin.id,
      type: 'category_create',
      targetType: 'category',
      targetId: String(sports.id),
      payload: {
        after: {
          slug: 'sports',
          nameKo: '스포츠 종합',
          parentId: null,
          sortOrder: 50,
          isActive: true,
        },
      },
    });
    // The database's clock, read in the write's transaction.
    expect(record!.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(record!.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());

    // The first sub-category is 10, the next one 10 more.
    const football = await create({ slug: 'football', nameKo: '축구', parentId: sports.id });
    const baseball = await create({ slug: 'baseball', nameKo: '야구', parentId: sports.id });
    expect([football.sortOrder, baseball.sortOrder]).toEqual([10, 20]);
    expect(football.parentId).toBe(sports.id);
    expect((await actions()).at(-1)).toMatchObject({
      type: 'category_create',
      targetId: String(baseball.id),
      payload: {
        after: { slug: 'baseball', nameKo: '야구', parentId: sports.id, sortOrder: 20 },
      },
    });
    // Politics too (D10).
    await create({ slug: 'politics', nameKo: '정치' });

    // The public list has them at once, in their places.
    expect((await publicList()).map((row) => row.slug)).toEqual([
      'economy',
      'sports',
      'politics',
      'football',
      'baseball',
    ]);
    expect(await types()).toEqual([
      'category_create',
      'category_create',
      'category_create',
      'category_create',
    ]);
  });

  it('keeps the markets of a top-level category that gets its first sub-category', async () => {
    const weather = await createCategory(t.db, { slug: 'weather', nameKo: '날씨' });
    const market = await createMarket(t.db, { createdBy: admin.id, categoryId: weather.id });
    const rain = await create({ slug: 'rain', nameKo: '강수', parentId: weather.id });
    const [row] = await t.db
      .select({ categoryId: schema.markets.categoryId })
      .from(schema.markets)
      .where(eq(schema.markets.id, market.id));
    expect(row!.categoryId).toBe(weather.id);
    const rows = await list();
    expect(rows.find((category) => category.id === weather.id)?.marketCount).toBe(1);
    expect(rows.find((category) => category.id === rain.id)?.marketCount).toBe(0);
  });

  it('takes no more than CATEGORY_GROUP_MAX categories in one group, hidden ones counted, so a reorder can always name it whole', async () => {
    const sports = await createCategory(t.db, { slug: 'sports', nameKo: '스포츠' });
    await t.db.insert(schema.categories).values(
      Array.from({ length: CATEGORY_GROUP_MAX }, (_, i) => ({
        slug: `league-${i}`,
        nameKo: `리그 ${i}`,
        parentId: sports.id,
        sortOrder: (i + 1) * 10,
        // Hidden ones count: a reorder names them too.
        isActive: i % 2 === 0,
      })),
    );
    const rows = await categoryRows();
    expectRefusal(
      await send('POST', '/admin/categories', {
        slug: 'one-more',
        nameKo: '하나 더',
        parentId: sports.id,
      }),
      CATEGORY_REFUSALS.groupFull,
    );
    expect(await categoryRows()).toEqual(rows);
    expect(await types()).toEqual([]);
    // The full group still reorders: the body takes exactly that many ids.
    const ids = rows.filter((row) => row.parentId === sports.id).map((row) => row.id);
    expect(ids).toHaveLength(CATEGORY_GROUP_MAX);
    const res = await send('PUT', '/admin/categories/order', {
      parentId: sports.id,
      ids: [...ids].reverse(),
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a taken slug, a sibling’s name, a parent that is a sub-category, hidden or unknown, and writes nothing', async () => {
    const economy = await createCategory(t.db, { slug: 'economy', nameKo: '경제' });
    const culture = await createCategory(t.db, { slug: 'culture', nameKo: '문화' });
    const hidden = await createCategory(t.db, {
      slug: 'hidden',
      nameKo: '숨김',
      isActive: false,
    });
    const rates = await createCategory(t.db, {
      slug: 'rates',
      nameKo: '금리',
      parentId: economy.id,
    });
    const rows = await categoryRows();
    const post = (body: object) => send('POST', '/admin/categories', body);

    // A slug is unique across the tree: a sub-category's too.
    expectRefusal(
      await post({ slug: 'rates', nameKo: '새것', parentId: culture.id }),
      CATEGORY_REFUSALS.slugTaken,
    );
    expectRefusal(
      await post({ slug: 'economy', nameKo: '새것', parentId: null }),
      CATEGORY_REFUSALS.slugTaken,
    );
    // A sibling's name, at either level, after the same normalisation.
    expectRefusal(
      await post({ slug: 'economy-2', nameKo: ' 경제 ', parentId: null }),
      CATEGORY_REFUSALS.nameTaken,
    );
    expectRefusal(
      await post({ slug: 'rates-2', nameKo: '금리', parentId: economy.id }),
      CATEGORY_REFUSALS.nameTaken,
    );
    // Two levels: a sub-category is no parent. A hidden parent takes none.
    expectRefusal(
      await post({ slug: 'deep', nameKo: '깊이', parentId: rates.id }),
      CATEGORY_REFUSALS.parentNotTopLevel,
    );
    expectRefusal(
      await post({ slug: 'under-hidden', nameKo: '아래', parentId: hidden.id }),
      CATEGORY_REFUSALS.parentInactive,
    );
    const unknown = await post({ slug: 'orphan', nameKo: '고아', parentId: 2_000_000_000 });
    expect(unknown.statusCode).toBe(404);
    expect(errorOf(unknown)).toMatchObject({
      code: 'NOT_FOUND',
      details: [{ path: ['parentId'], message: 'not found' }],
    });
    // The form itself: a slug of other characters, a blank or long name, no parentId at all.
    for (const [body, field] of [
      [{ slug: 'Upper', nameKo: '대문자', parentId: null }, 'slug'],
      [{ slug: 'two--hyphens', nameKo: '하이픈', parentId: null }, 'slug'],
      [{ slug: 'blank', nameKo: '   ', parentId: null }, 'nameKo'],
      [{ slug: 'long', nameKo: '가'.repeat(33), parentId: null }, 'nameKo'],
      [{ slug: 'no-parent', nameKo: '부모 없음' }, 'parentId'],
    ] as const) {
      const res = await post(body);
      expect({ field, status: res.statusCode }).toEqual({ field, status: 400 });
      expect(errorOf(res).details?.map((detail) => detail.path)).toEqual([[field]]);
    }
    expect(await categoryRows()).toEqual(rows);
    expect(await actions()).toEqual([]);

    // The same name under another parent, or at the other level, is no sibling's.
    const ratesElsewhere = await create({
      slug: 'culture-rates',
      nameKo: '금리',
      parentId: culture.id,
    });
    expect(ratesElsewhere.nameKo).toBe('금리');
    const ratesTop = await create({ slug: 'top-rates', nameKo: '금리', parentId: null });
    expect(ratesTop.parentId).toBeNull();
  });

  it('renames a category, keeping its slug; the same name again records nothing and a sibling’s is refused', async () => {
    const economy = await createCategory(t.db, { slug: 'economy', nameKo: '경제' });
    const rates = await createCategory(t.db, {
      slug: 'rates',
      nameKo: '금리',
      parentId: economy.id,
    });
    await createCategory(t.db, { slug: 'jobs', nameKo: '고용', parentId: economy.id });
    const culture = await createCategory(t.db, { slug: 'culture', nameKo: '문화' });
    await createCategory(t.db, { slug: 'film', nameKo: '영화', parentId: culture.id });

    const before = await clockTimestamp(t.db);
    const renamed = await send('PATCH', `/admin/categories/${String(rates.id)}`, {
      nameKo: ' 기준 금리 ',
    });
    const after = await clockTimestamp(t.db);
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(data<AdminCategory>(renamed)).toMatchObject({
      id: rates.id,
      slug: 'rates',
      nameKo: '기준 금리',
      parentId: economy.id,
    });
    const [record] = await actions();
    expect(record).toMatchObject({
      adminId: admin.id,
      type: 'category_rename',
      targetType: 'category',
      targetId: String(rates.id),
      payload: { before: { nameKo: '금리' }, after: { nameKo: '기준 금리' } },
    });
    expect(record!.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(record!.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
    expect((await publicList()).find((row) => row.id === rates.id)?.nameKo).toBe('기준 금리');

    // The same name again changes nothing and records nothing.
    const again = await send('PATCH', `/admin/categories/${String(rates.id)}`, {
      nameKo: '기준 금리',
    });
    expect(again.statusCode).toBe(200);
    expect(await types()).toEqual(['category_rename']);

    // A sibling's name is refused; a name under another parent is not a sibling's.
    expectRefusal(
      await send('PATCH', `/admin/categories/${String(rates.id)}`, { nameKo: '고용' }),
      CATEGORY_REFUSALS.nameTaken,
    );
    expectRefusal(
      await send('PATCH', `/admin/categories/${String(culture.id)}`, { nameKo: '경제' }),
      CATEGORY_REFUSALS.nameTaken,
    );
    const asFilm = await send('PATCH', `/admin/categories/${String(rates.id)}`, {
      nameKo: '영화',
    });
    expect(asFilm.statusCode).toBe(200);
    expect(await types()).toEqual(['category_rename', 'category_rename']);

    // An unknown id is NOT_FOUND; an id that is no positive int4 is malformed.
    const unknown = await send('PATCH', '/admin/categories/2000000000', { nameKo: '없음' });
    expect(unknown.statusCode).toBe(404);
    expect(errorOf(unknown).code).toBe('NOT_FOUND');
    for (const id of ['abc', '0', '-1', '1.5', '2147483648', '007']) {
      const res = await send('PATCH', `/admin/categories/${id}`, { nameKo: '없음' });
      expect({ id, status: res.statusCode }).toEqual({ id, status: 400 });
      expect(errorOf(res).code).toBe('VALIDATION_ERROR');
    }
    expect(await types()).toEqual(['category_rename', 'category_rename']);
  });

  it('orders a group by every sibling, hidden ones too, once each; records the order before and after; the same order records nothing', async () => {
    const economy = await createCategory(t.db, { slug: 'economy', nameKo: '경제', sortOrder: 10 });
    const culture = await createCategory(t.db, { slug: 'culture', nameKo: '문화', sortOrder: 20 });
    const hidden = await createCategory(t.db, {
      slug: 'hidden',
      nameKo: '숨김',
      sortOrder: 30,
      isActive: false,
    });
    const rates = await createCategory(t.db, {
      slug: 'rates',
      nameKo: '금리',
      sortOrder: 10,
      parentId: economy.id,
    });
    const jobs = await createCategory(t.db, {
      slug: 'jobs',
      nameKo: '고용',
      sortOrder: 20,
      parentId: economy.id,
    });
    const film = await createCategory(t.db, {
      slug: 'film',
      nameKo: '영화',
      sortOrder: 15,
      parentId: culture.id,
    });
    const order = (parentId: number | null, ids: number[]) =>
      send('PUT', '/admin/categories/order', { parentId, ids });

    // Every sibling, the hidden one included, once each: anything else names `ids`.
    for (const ids of [
      [culture.id, economy.id],
      [culture.id, economy.id, hidden.id, rates.id],
      [culture.id, economy.id, rates.id],
    ]) {
      expectRefusal(await order(null, ids), CATEGORY_REFUSALS.orderMismatch);
    }
    expectRefusal(await order(economy.id, [rates.id]), CATEGORY_REFUSALS.orderMismatch);
    expectRefusal(await order(economy.id, [rates.id, film.id]), CATEGORY_REFUSALS.orderMismatch);
    // A repeated id is malformed.
    const repeated = await order(null, [culture.id, culture.id, economy.id]);
    expect(repeated.statusCode).toBe(400);
    expect(errorOf(repeated).details?.[0]?.path).toEqual(['ids']);
    // A sub-category has no group under it; an unknown parent is NOT_FOUND naming parentId.
    expectRefusal(await order(rates.id, [rates.id]), CATEGORY_REFUSALS.parentNotTopLevel);
    const unknown = await order(2_000_000_000, [rates.id]);
    expect(unknown.statusCode).toBe(404);
    expect(errorOf(unknown).details?.[0]?.path).toEqual(['parentId']);
    expect(await actions()).toEqual([]);

    // The top level: spaced by 10 from 10, the group answered in its new order.
    const before = await clockTimestamp(t.db);
    const top = await order(null, [hidden.id, culture.id, economy.id]);
    const after = await clockTimestamp(t.db);
    expect(top.statusCode, top.body).toBe(200);
    expect(data<AdminCategory[]>(top).map((row) => [row.id, row.sortOrder, row.isActive])).toEqual([
      [hidden.id, 10, false],
      [culture.id, 20, true],
      [economy.id, 30, true],
    ]);
    const [record] = await actions();
    expect(record).toMatchObject({
      adminId: admin.id,
      type: 'category_reorder',
      targetType: 'category',
      targetId: null,
      payload: {
        parentId: null,
        before: [economy.id, culture.id, hidden.id],
        after: [hidden.id, culture.id, economy.id],
      },
    });
    expect(record!.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(record!.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
    // The public list follows, the hidden one left out.
    expect(
      (await publicList()).filter((row) => row.parentId === null).map((row) => row.id),
    ).toEqual([culture.id, economy.id]);

    // One parent's sub-categories: the record targets the parent.
    const sub = await order(economy.id, [jobs.id, rates.id]);
    expect(sub.statusCode).toBe(200);
    expect(data<AdminCategory[]>(sub).map((row) => [row.id, row.sortOrder])).toEqual([
      [jobs.id, 10],
      [rates.id, 20],
    ]);
    expect((await actions()).at(-1)).toMatchObject({
      type: 'category_reorder',
      targetId: String(economy.id),
      payload: { parentId: economy.id, before: [rates.id, jobs.id], after: [jobs.id, rates.id] },
    });
    // The other parent's sub-category is untouched.
    expect((await list()).find((row) => row.id === film.id)?.sortOrder).toBe(15);

    // The same order again changes nothing and records nothing.
    const same = await order(economy.id, [jobs.id, rates.id]);
    expect(same.statusCode).toBe(200);
    expect(await types()).toEqual(['category_reorder', 'category_reorder']);

    // A hidden parent's sub-categories may be ordered too.
    const shelved = await createCategory(t.db, {
      slug: 'shelved',
      nameKo: '보관',
      isActive: false,
    });
    const a = await createCategory(t.db, { slug: 'a', nameKo: '가', parentId: shelved.id });
    const b = await createCategory(t.db, { slug: 'b', nameKo: '나', parentId: shelved.id });
    expect((await order(shelved.id, [b.id, a.id])).statusCode).toBe(200);
  });

  it('hides and shows, each once: the public list drops a hidden category and a hidden parent’s sub-categories, whose own state stays', async () => {
    const economy = await createCategory(t.db, { slug: 'economy', nameKo: '경제' });
    const rates = await createCategory(t.db, {
      slug: 'rates',
      nameKo: '금리',
      parentId: economy.id,
    });
    const jobs = await createCategory(t.db, {
      slug: 'jobs',
      nameKo: '고용',
      parentId: economy.id,
      isActive: false,
    });
    const culture = await createCategory(t.db, { slug: 'culture', nameKo: '문화' });
    const market = await createMarket(t.db, { createdBy: admin.id, categoryId: rates.id });
    expect(await publicIds()).toEqual([economy.id, culture.id, rates.id]);

    const before = await clockTimestamp(t.db);
    const hidden = await send('POST', `/admin/categories/${String(economy.id)}/hide`, {});
    const after = await clockTimestamp(t.db);
    expect(hidden.statusCode, hidden.body).toBe(200);
    expect(data<AdminCategory>(hidden)).toMatchObject({ id: economy.id, isActive: false });
    const [record] = await actions();
    expect(record).toMatchObject({
      adminId: admin.id,
      type: 'category_hide',
      targetType: 'category',
      targetId: String(economy.id),
      payload: { before: { isActive: true }, after: { isActive: false } },
    });
    expect(record!.createdAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(record!.createdAt.getTime()).toBeLessThanOrEqual(after.getTime());
    // The parent and its sub-categories leave the public list; the sub-categories keep their own
    // state, and the market keeps its category.
    expect(await publicIds()).toEqual([culture.id]);
    const rows = await list();
    expect(rows.map((row) => [row.id, row.isActive])).toEqual([
      [economy.id, false],
      [culture.id, true],
      [rates.id, true],
      [jobs.id, false],
    ]);
    expect(rows.find((row) => row.id === rates.id)?.marketCount).toBe(1);
    const [kept] = await t.db
      .select({ categoryId: schema.markets.categoryId })
      .from(schema.markets)
      .where(eq(schema.markets.id, market.id));
    expect(kept!.categoryId).toBe(rates.id);

    // Hidden again: no change, no record.
    expect(
      (await send('POST', `/admin/categories/${String(economy.id)}/hide`, {})).statusCode,
    ).toBe(200);
    expect(await types()).toEqual(['category_hide']);

    // Shown again: exactly the sub-categories that were showing come back.
    const shown = await send('POST', `/admin/categories/${String(economy.id)}/show`, {});
    expect(shown.statusCode).toBe(200);
    expect(data<AdminCategory>(shown).isActive).toBe(true);
    expect((await actions()).at(-1)).toMatchObject({
      type: 'category_show',
      targetId: String(economy.id),
      payload: { before: { isActive: false }, after: { isActive: true } },
    });
    expect(await publicIds()).toEqual([economy.id, culture.id, rates.id]);
    expect(
      (await send('POST', `/admin/categories/${String(economy.id)}/show`, {})).statusCode,
    ).toBe(200);
    expect(await types()).toEqual(['category_hide', 'category_show']);

    // A sub-category alone.
    expect((await send('POST', `/admin/categories/${String(rates.id)}/hide`, {})).statusCode).toBe(
      200,
    );
    expect(await publicIds()).toEqual([economy.id, culture.id]);
    expect((await send('POST', `/admin/categories/${String(jobs.id)}/show`, {})).statusCode).toBe(
      200,
    );
    expect(await publicIds()).toEqual([economy.id, culture.id, jobs.id]);
    expect(await types()).toEqual([
      'category_hide',
      'category_show',
      'category_hide',
      'category_show',
    ]);

    const unknown = await send('POST', '/admin/categories/2000000000/hide', {});
    expect(unknown.statusCode).toBe(404);
  });

  it('places two categories added at once one after the other, and records one hide when two admins hide at once', async () => {
    await createCategory(t.db, { slug: 'economy', nameKo: '경제', sortOrder: 10 });
    const [first, second] = await Promise.all([
      send('POST', '/admin/categories', { slug: 'one', nameKo: '하나', parentId: null }),
      send(
        'POST',
        '/admin/categories',
        { slug: 'two', nameKo: '둘', parentId: null },
        other.cookie,
      ),
    ]);
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    // Each waited for the other's group lock: no two share a place.
    expect(
      [data<AdminCategory>(first).sortOrder, data<AdminCategory>(second).sortOrder].sort(),
    ).toEqual([20, 30]);

    const target = data<AdminCategory>(first);
    const hides = await Promise.all([
      send('POST', `/admin/categories/${String(target.id)}/hide`, {}),
      send('POST', `/admin/categories/${String(target.id)}/hide`, {}, other.cookie),
    ]);
    expect(hides.map((res) => res.statusCode)).toEqual([200, 200]);
    expect((await types()).filter((type) => type === 'category_hide')).toHaveLength(1);
  });

  it('commits a change and its record together or not at all', async () => {
    // The record is written, then the transaction fails: neither may remain (AUDITED's rule,
    // admin-audit.test.ts).
    const service = t.app.get<
      CategoryAdminService,
      { audit: (...args: unknown[]) => Promise<void> }
    >(CategoryAdminService);
    const original = service.audit.bind(service);
    const failAfterRecord = () =>
      vi.spyOn(service, 'audit').mockImplementationOnce(async (...args) => {
        await original(...args);
        throw new Error('injected failure');
      });
    const economy = await createCategory(t.db, { slug: 'economy', nameKo: '경제', sortOrder: 10 });
    const culture = await createCategory(t.db, { slug: 'culture', nameKo: '문화', sortOrder: 20 });
    const rows = await categoryRows();
    for (const [method, url, payload] of [
      ['POST', '/admin/categories', { slug: 'failing', nameKo: '실패', parentId: null }],
      ['PATCH', `/admin/categories/${String(economy.id)}`, { nameKo: '바뀌지 않음' }],
      ['PUT', '/admin/categories/order', { parentId: null, ids: [culture.id, economy.id] }],
      ['POST', `/admin/categories/${String(economy.id)}/hide`, {}],
    ] as const) {
      const failing = failAfterRecord();
      const res = await send(method, url, payload);
      failing.mockRestore();
      expect({ url, status: res.statusCode }).toEqual({ url, status: 500 });
    }
    expect(await categoryRows()).toEqual(rows);
    expect(await actions()).toEqual([]);
  });

  it('is the admin’s alone: members and visitors are refused, and a foreign Origin too', async () => {
    const economy = await createCategory(t.db, { slug: 'economy', nameKo: '경제' });
    const id = String(economy.id);
    const routes = [
      ['GET', '/admin/categories', undefined],
      ['POST', '/admin/categories', { slug: 'refused', nameKo: '거부', parentId: null }],
      ['PATCH', `/admin/categories/${id}`, { nameKo: '바꿈' }],
      ['PUT', '/admin/categories/order', { parentId: null, ids: [economy.id] }],
      ['POST', `/admin/categories/${id}/hide`, {}],
      ['POST', `/admin/categories/${id}/show`, {}],
    ] as const;
    const rows = await categoryRows();
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
          'content-type': 'application/json',
        },
        payload: { ...payload, expectedAccountId: admin.id },
      });
      expect({ method, url, status: foreign.statusCode }).toEqual({ method, url, status: 403 });
    }
    expect(await categoryRows()).toEqual(rows);
    expect(await actions()).toEqual([]);
  });

  it('refuses every write that names another admin than the cookie’s, and one that names none, before anything is read (ADR-0092)', async () => {
    const economy = await createCategory(t.db, { slug: 'economy', nameKo: '경제' });
    const id = String(economy.id);
    const writes = [
      ['POST', '/admin/categories', { slug: 'refused', nameKo: '거부', parentId: null }],
      ['PATCH', `/admin/categories/${id}`, { nameKo: '바꿈' }],
      ['PUT', '/admin/categories/order', { parentId: null, ids: [economy.id] }],
      ['POST', `/admin/categories/${id}/hide`, {}],
      ['POST', `/admin/categories/${id}/show`, {}],
    ] as const;
    const rows = await categoryRows();
    for (const [method, url, payload] of writes) {
      // The screen still shows `admin` while the tab's cookie is `other`'s.
      const refused = await send(method, url, payload, other.cookie, admin.id);
      expect({ method, url, status: refused.statusCode }).toEqual({ method, url, status: 403 });
      expect(errorOf(refused).code).toBe('FORBIDDEN');
      expect(errorOf(refused).details?.[0]?.path).toEqual(['expectedAccountId']);
      // No account at all: a validation error naming the field.
      const unnamed = await send(method, url, payload, admin.cookie, null);
      expect({ method, url, status: unnamed.statusCode }).toEqual({ method, url, status: 400 });
      expect(errorOf(unnamed).details?.map((detail) => detail.path)).toEqual([
        ['expectedAccountId'],
      ]);
    }
    expect(await categoryRows()).toEqual(rows);
    expect(await actions()).toEqual([]);
    // The cookie's own account is taken, and recorded as the one who acted.
    const hidden = await send('POST', `/admin/categories/${id}/hide`, {}, other.cookie);
    expect(hidden.statusCode, hidden.body).toBe(200);
    expect((await actions()).at(-1)).toMatchObject({ type: 'category_hide', adminId: other.id });
  });
});
