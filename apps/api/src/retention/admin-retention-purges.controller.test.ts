/**
 * 경과 처리 기록 over HTTP (#184, ADR-0069 decision 4 #184 «종류·건수·시각을 운영 기록으로 남긴다»,
 * ADR-0087), against the docker `test` profile: an admin reads what the worker's retention purge
 * recorded — kind, count, the period applied, the run's instant and its outcome (a kind the run
 * gave up on is `failed`, owner decision 2026-10-24 14), newest run first, page by page — and
 * nothing about whose; a member and a visitor read nothing (admin-access.test.ts checks the
 * guards of every /admin route as well). The purge itself is the worker's (retention-purge.test.ts),
 * so the records are written here as it writes them.
 */
import { schema } from '@buddha/db';
import { completeOnboarding } from '@buddha/db/test';
import { retentionPurgeSchema, type RetentionPurge } from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

const URL = '/api/v1/admin/retention-purges';

describe.skipIf(!hasTestInfra)(
  '경과 처리 기록 /api/v1/admin/retention-purges (integration)',
  () => {
    let t: TestApp;
    let admin: TestUser;
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
      member = await signUpTestUser(t);
      await t.db
        .update(schema.profiles)
        .set({ role: 'admin' })
        .where(eq(schema.profiles.userId, admin.id));
      // An admin finishes the onboarding like any account before /admin answers it (ADR-0072).
      await completeOnboarding(t.db, { userId: admin.id });
      await t.app.get(AdminGuard).invalidate(admin.id);
    });

    /** As `cookie` (the admin by default), or as a visitor with `null`. */
    const read = (query = '', cookie: string | null = admin.cookie) =>
      t.app.inject({
        method: 'GET',
        url: `${URL}${query}`,
        headers: cookie === null ? {} : { cookie },
      });

    it('lists each run’s kinds and counts with the period and the instant, newest run first, page by page', async () => {
      const earlier = new Date('2026-10-22T19:30:00.000Z');
      const later = new Date('2026-10-23T19:30:00.000Z');
      await t.db.insert(schema.retentionPurges).values([
        { kind: 'nickname_holds', count: 2, periodDays: 30, ranAt: earlier },
        { kind: 'consent_records', count: 0, periodDays: 365, ranAt: earlier },
        { kind: 'nickname_holds', count: 0, periodDays: 30, ranAt: later },
        { kind: 'consent_records', count: 8, periodDays: 365, ranAt: later },
        { kind: 'deleted_posts', count: 0, periodDays: 90, ranAt: later, outcome: 'failed' },
      ]);
      const first = await read('?limit=3');
      expect(first.statusCode).toBe(200);
      const body = first.json<{ data: RetentionPurge[]; meta: { nextCursor: string | null } }>();
      for (const item of body.data) retentionPurgeSchema.parse(item);
      // Within a run, the last written first.
      // The kind the run gave up on says so; the rest were done.
      expect(
        body.data.map(({ kind, count, periodDays, ranAt, outcome }) => ({
          kind,
          count,
          periodDays,
          ranAt,
          outcome,
        })),
      ).toEqual([
        {
          kind: 'deleted_posts',
          count: 0,
          periodDays: 90,
          ranAt: later.toISOString(),
          outcome: 'failed',
        },
        {
          kind: 'consent_records',
          count: 8,
          periodDays: 365,
          ranAt: later.toISOString(),
          outcome: 'done',
        },
        {
          kind: 'nickname_holds',
          count: 0,
          periodDays: 30,
          ranAt: later.toISOString(),
          outcome: 'done',
        },
      ]);
      // Kind, count, period, instant and outcome: nothing about whose.
      expect(Object.keys(body.data[0]!).sort()).toEqual([
        'count',
        'id',
        'kind',
        'outcome',
        'periodDays',
        'ranAt',
      ]);
      expect(body.meta.nextCursor).not.toBeNull();
      const second = await read(`?limit=3&cursor=${encodeURIComponent(body.meta.nextCursor!)}`);
      const next = second.json<{ data: RetentionPurge[]; meta: { nextCursor: string | null } }>();
      expect(next.data.map(({ kind, ranAt }) => [kind, ranAt])).toEqual([
        ['consent_records', earlier.toISOString()],
        ['nickname_holds', earlier.toISOString()],
      ]);
      expect(next.meta.nextCursor).toBeNull();
    });

    it('never ends a page inside a run: the page takes the rest of the run its last record belongs to', async () => {
      const earlier = new Date('2026-10-22T19:30:00.000Z');
      const later = new Date('2026-10-23T19:30:00.000Z');
      // As the worker writes them: a kind per step, a record per batch (the larger batch first).
      await t.db.insert(schema.retentionPurges).values([
        { kind: 'nickname_holds', count: 0, periodDays: 30, ranAt: earlier },
        { kind: 'post_revisions', count: 500, periodDays: 90, ranAt: earlier },
        { kind: 'post_revisions', count: 12, periodDays: 90, ranAt: earlier },
        { kind: 'nickname_holds', count: 3, periodDays: 30, ranAt: later },
        { kind: 'post_revisions', count: 500, periodDays: 90, ranAt: later },
        { kind: 'post_revisions', count: 12, periodDays: 90, ranAt: later },
        { kind: 'consent_records', count: 0, periodDays: 365, ranAt: later },
      ]);
      type Body = { data: RetentionPurge[]; meta: { nextCursor: string | null } };
      const lines = (body: Body) =>
        body.data.map(({ kind, count, ranAt }) => [kind, count, ranAt === later.toISOString()]);

      // Two records asked for: the later run's four, its first batch and holds included.
      const first = (await read('?limit=2')).json<Body>();
      expect(lines(first)).toEqual([
        ['consent_records', 0, true],
        ['post_revisions', 12, true],
        ['post_revisions', 500, true],
        ['nickname_holds', 3, true],
      ]);
      expect(first.meta.nextCursor).not.toBeNull();
      // The next page starts with the earlier run and takes it whole too: nothing after it.
      const second = (
        await read(`?limit=2&cursor=${encodeURIComponent(first.meta.nextCursor!)}`)
      ).json<Body>();
      expect(lines(second)).toEqual([
        ['post_revisions', 12, false],
        ['post_revisions', 500, false],
        ['nickname_holds', 0, false],
      ]);
      expect(second.meta.nextCursor).toBeNull();

      // A page that ends exactly at a run's end is not stretched.
      const exact = (await read('?limit=4')).json<Body>();
      expect(exact.data).toHaveLength(4);
      expect(exact.meta.nextCursor).not.toBeNull();
    });

    it('answers an empty list before any run', async () => {
      const res = await read();
      expect(res.statusCode).toBe(200);
      expect(res.json<{ data: RetentionPurge[] }>().data).toEqual([]);
    });

    it('is for admins only: a member is refused, a visitor is asked to sign in', async () => {
      expect((await read('', member.cookie)).statusCode).toBe(403);
      expect((await read('', null)).statusCode).toBe(401);
    });
  },
);
