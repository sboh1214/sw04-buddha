/**
 * 카테고리 변경 기록 (#145, ADR-0164; 145-10 "카테고리 화면에 보임 — … 변경 기록을 최신순으로
 * 보인다"; ADR-0096 결과 5) through `GET /admin/categories/changes` against the docker `test`
 * profile: the five writes of `/admin/categories` (추가, 이름 바꾸기, 순서 바꾸기, 숨기기, 다시
 * 보이기) made through their routes by two admins appear newest first, each with its admin, its
 * time and the values before and after, the categories by their current names; a write that
 * changed nothing writes no record and shows none; the pages add up; a member is refused (403) and
 * a visitor too (401). Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import { completeOnboarding } from '@buddha/db/test';
import {
  adminCategoryChangePageSchema,
  type AdminCategory,
  type AdminCategoryChange,
  type AdminCategoryChangePage,
} from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

const jsonHeaders = { origin: 'http://localhost:3000', 'content-type': 'application/json' };

describe.skipIf(!hasTestInfra)('카테고리 변경 기록 (integration)', () => {
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
      await t.app.get(AdminGuard).invalidate(user.id);
    }
    for (const user of [admin, other, member]) {
      await completeOnboarding(t.db, { userId: user.id });
    }
  });

  /** A write as the screen sends it, naming the admin on screen (ADR-0092). */
  async function write(
    method: 'POST' | 'PATCH' | 'PUT',
    url: string,
    who: TestUser,
    payload: Record<string, unknown> = {},
  ) {
    const res = await t.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { ...jsonHeaders, cookie: who.cookie },
      payload: { expectedAccountId: who.id, ...payload },
    });
    expect(res.statusCode, res.body).toBeLessThan(300);
    return res.json<{ data: AdminCategory }>().data;
  }
  const create = (nameKo: string, slug: string, parentId: number | null = null, who = admin) =>
    write('POST', '/admin/categories', who, { slug, nameKo, parentId });
  const get = (url: string, cookie?: string) =>
    t.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: cookie ? { cookie } : {} });

  async function page(query = ''): Promise<AdminCategoryChangePage> {
    const res = await get(`/admin/categories/changes${query}`, other.cookie);
    expect(res.statusCode, res.body).toBe(200);
    return adminCategoryChangePageSchema.parse(res.json<AdminCategoryChangePage>());
  }
  async function changes(limit = 100): Promise<AdminCategoryChange[]> {
    const rows: AdminCategoryChange[] = [];
    let cursor: string | null = null;
    do {
      const next = await page(
        `?limit=${String(limit)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      rows.push(...next.data);
      cursor = next.meta.nextCursor;
    } while (cursor !== null);
    return rows;
  }
  const actorOf = async (user: TestUser) => {
    const [profile] = await t.db
      .select({ nickname: schema.profiles.nickname })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, user.id));
    return { id: user.id, nickname: profile!.nickname };
  };

  it('lists the five writes newest first, with the admin, the time and the values before and after', async () => {
    expect(await page()).toEqual({ data: [], meta: { nextCursor: null } });
    const economy = await create('경제', 'economy');
    const politics = await create('정치', 'politics', null, other);
    const rates = await create('금리', 'rates', economy.id);
    await write('PATCH', `/admin/categories/${String(politics.id)}`, admin, {
      nameKo: '정치·사회',
    });
    // The same name again changes nothing and records nothing.
    await write('PATCH', `/admin/categories/${String(politics.id)}`, admin, {
      nameKo: '정치·사회',
    });
    await write('PUT', '/admin/categories/order', other, {
      parentId: null,
      ids: [politics.id, economy.id],
    });
    await write('POST', `/admin/categories/${String(rates.id)}/hide`, admin);
    await write('POST', `/admin/categories/${String(rates.id)}/show`, other);
    // Renamed after the reorder: the reorder's lists show the current name (one lookup).
    await write('PATCH', `/admin/categories/${String(economy.id)}`, other, { nameKo: '경제·금융' });

    const rows = await changes();
    const by = { admin: await actorOf(admin), other: await actorOf(other) };
    const ref = (id: number, nameKo: string) => ({ id, nameKo });
    expect(
      rows.map(({ type, actor, category, details }) => ({ type, actor, category, details })),
    ).toEqual([
      {
        type: 'category_rename',
        actor: by.other,
        category: ref(economy.id, '경제·금융'),
        details: { before: '경제', after: '경제·금융' },
      },
      {
        type: 'category_show',
        actor: by.other,
        category: ref(rates.id, '금리'),
        details: { before: false, after: true },
      },
      {
        type: 'category_hide',
        actor: by.admin,
        category: ref(rates.id, '금리'),
        details: { before: true, after: false },
      },
      {
        type: 'category_reorder',
        actor: by.other,
        // The top level: no parent, no target.
        category: null,
        details: {
          parent: null,
          before: [ref(economy.id, '경제·금융'), ref(politics.id, '정치·사회')],
          after: [ref(politics.id, '정치·사회'), ref(economy.id, '경제·금융')],
        },
      },
      {
        type: 'category_rename',
        actor: by.admin,
        category: ref(politics.id, '정치·사회'),
        details: { before: '정치', after: '정치·사회' },
      },
      {
        type: 'category_create',
        actor: by.admin,
        category: ref(rates.id, '금리'),
        details: { nameKo: '금리', parent: ref(economy.id, '경제·금융') },
      },
      {
        type: 'category_create',
        actor: by.other,
        category: ref(politics.id, '정치·사회'),
        details: { nameKo: '정치', parent: null },
      },
      {
        type: 'category_create',
        actor: by.admin,
        category: ref(economy.id, '경제·금융'),
        details: { nameKo: '경제', parent: null },
      },
    ]);
    // Newest first, each its stored record's id and instant.
    const stored = await t.db.select().from(schema.adminActions);
    const kept = stored.filter((row) => row.type.startsWith('category_'));
    expect(kept).toHaveLength(rows.length);
    for (const row of rows) {
      const action = kept.find((candidate) => candidate.id === row.id);
      expect(action?.createdAt.toISOString()).toBe(row.at);
    }
    const times = rows.map((row) => Date.parse(row.at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    // The pages add up at any size.
    for (const limit of [1, 3]) {
      expect((await changes(limit)).map((row) => row.id)).toEqual(rows.map((row) => row.id));
    }
  });

  it('is every admin’s and no one else’s: a member 403, a visitor 401, the public tree without it', async () => {
    await create('경제', 'economy');
    expect((await get('/admin/categories/changes', member.cookie)).statusCode).toBe(403);
    expect((await get('/admin/categories/changes')).statusCode).toBe(401);
    const shown = await get('/categories');
    expect(shown.statusCode).toBe(200);
    expect(shown.body).not.toContain('category_create');
  });
});
