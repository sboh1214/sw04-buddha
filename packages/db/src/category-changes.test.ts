import type { AdminCategoryChange } from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readCategoryChanges } from './category-changes.js';
import { adminActions, categories } from './schema/index.js';
import { createCategory, createUser } from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import { clockTimestamp } from './tx-helpers.js';

describe.skipIf(!hasTestDb())(
  '카테고리 변경 기록 reader (#145, ADR-0164; 145-10; integration)',
  () => {
    let t: TestDb;
    let now: Date;
    const at = (seconds: number) => new Date(now.getTime() + seconds * 1_000);

    beforeAll(async () => {
      t = await connectTestDb();
    });
    afterAll(async () => {
      await t?.close();
    });
    beforeEach(async () => {
      await t.reset();
      now = await clockTimestamp(t.db);
    });

    async function record(
      adminId: string,
      type: string,
      targetId: number | null,
      payload: Record<string, unknown>,
      createdAt: Date,
    ): Promise<string> {
      const [row] = await t.db
        .insert(adminActions)
        .values({
          adminId,
          type,
          targetType: 'category',
          targetId: targetId === null ? null : String(targetId),
          payload,
          createdAt,
        })
        .returning({ id: adminActions.id });
      return row!.id;
    }

    /** The five writes as the category service records them (category-admin.service.ts). */
    async function seed() {
      const admin = (await createUser(t.db, { role: 'admin', nickname: '분류담당' })).user.id;
      const economy = await createCategory(t.db, { nameKo: '경제' });
      const politics = await createCategory(t.db, { nameKo: '정치' });
      const jobs = await createCategory(t.db, { nameKo: '고용', parentId: economy.id });
      const ids = {
        admin,
        economy: economy.id,
        politics: politics.id,
        jobs: jobs.id,
        create: await record(
          admin,
          'category_create',
          jobs.id,
          {
            after: {
              slug: jobs.slug,
              nameKo: '일자리',
              parentId: economy.id,
              sortOrder: 0,
              isActive: true,
            },
          },
          at(-50),
        ),
        rename: await record(
          admin,
          'category_rename',
          jobs.id,
          { before: { nameKo: '일자리' }, after: { nameKo: '고용' } },
          at(-40),
        ),
        reorderTop: await record(
          admin,
          'category_reorder',
          null,
          { parentId: null, before: [economy.id, politics.id], after: [politics.id, economy.id] },
          at(-30),
        ),
        hide: await record(
          admin,
          'category_hide',
          politics.id,
          { before: { isActive: true }, after: { isActive: false } },
          at(-20),
        ),
        show: await record(
          admin,
          'category_show',
          politics.id,
          { before: { isActive: false }, after: { isActive: true } },
          at(-10),
        ),
      };
      // Not a category record: never listed.
      await t.db.insert(adminActions).values({
        adminId: admin,
        type: 'theme_create',
        targetType: 'theme',
        targetId: null,
        payload: {},
        createdAt: at(-5),
      });
      return ids;
    }

    async function walk(limit?: number): Promise<AdminCategoryChange[]> {
      const rows: AdminCategoryChange[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 50; page += 1) {
        const result = await readCategoryChanges(t.db, { limit, cursor });
        rows.push(...result.data);
        if (result.meta.nextCursor === null) return rows;
        cursor = result.meta.nextCursor;
      }
      throw new Error('walk: too many pages');
    }

    it('lists the five kinds of record newest first, with the actor and the time', async () => {
      const ids = await seed();
      const rows = await walk();
      expect(rows.map((row) => row.id)).toEqual([
        ids.show,
        ids.hide,
        ids.reorderTop,
        ids.rename,
        ids.create,
      ]);
      for (const row of rows) expect(row.actor).toEqual({ id: ids.admin, nickname: '분류담당' });
      expect(rows.at(-1)!.at).toBe(at(-50).toISOString());
    });

    it('gives the values before and after, ids read as current names', async () => {
      const ids = await seed();
      // A rename since the reorder: the reorder shows the current name.
      await t.db
        .update(categories)
        .set({ nameKo: '경제·금융' })
        .where(eq(categories.id, ids.economy));
      const byId = new Map((await walk()).map((row) => [row.id, row]));
      expect(byId.get(ids.create)).toMatchObject({
        type: 'category_create',
        category: { id: ids.jobs, nameKo: '고용' },
        details: { nameKo: '일자리', parent: { id: ids.economy, nameKo: '경제·금융' } },
      });
      // A rename's own before and after are the stored names.
      expect(byId.get(ids.rename)).toMatchObject({
        type: 'category_rename',
        details: { before: '일자리', after: '고용' },
      });
      expect(byId.get(ids.reorderTop)).toMatchObject({
        type: 'category_reorder',
        category: null,
        details: {
          parent: null,
          before: [
            { id: ids.economy, nameKo: '경제·금융' },
            { id: ids.politics, nameKo: '정치' },
          ],
          after: [
            { id: ids.politics, nameKo: '정치' },
            { id: ids.economy, nameKo: '경제·금융' },
          ],
        },
      });
      expect(byId.get(ids.hide)).toMatchObject({
        type: 'category_hide',
        category: { id: ids.politics, nameKo: '정치' },
        details: { before: true, after: false },
      });
      expect(byId.get(ids.show)!.details).toEqual({ before: false, after: true });
    });

    it('names the parent of a sub-category reorder as its category', async () => {
      const ids = await seed();
      const other = await createCategory(t.db, { nameKo: '물가', parentId: ids.economy });
      const reorder = await record(
        ids.admin,
        'category_reorder',
        ids.economy,
        { parentId: ids.economy, before: [ids.jobs, other.id], after: [other.id, ids.jobs] },
        at(-1),
      );
      const [first] = (await readCategoryChanges(t.db, { limit: 1 })).data;
      expect(first).toMatchObject({
        id: reorder,
        category: { id: ids.economy, nameKo: '경제' },
        details: {
          parent: { id: ids.economy, nameKo: '경제' },
          after: [
            { id: other.id, nameKo: '물가' },
            { id: ids.jobs, nameKo: '고용' },
          ],
        },
      });
    });

    it('pages without repeats or gaps, two records at one instant included', async () => {
      const ids = await seed();
      await record(
        ids.admin,
        'category_hide',
        ids.jobs,
        { before: { isActive: true }, after: { isActive: false } },
        at(-10),
      );
      const all = (await walk()).map((row) => row.id);
      expect(all).toHaveLength(6);
      for (const limit of [1, 2, 4]) expect((await walk(limit)).map((row) => row.id)).toEqual(all);
    });
  },
);
