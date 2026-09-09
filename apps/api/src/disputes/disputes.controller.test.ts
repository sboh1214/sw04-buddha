/**
 * Disputes (PLAN 5.5, 7.2, 7.3, 12; M5 design 3.4) against the docker `test` profile: filing
 * per market status and window, the one-per-user rule, the caller's own list, the admin list
 * and review with its audit row, and the guard surface (401/403/CSRF). Skips when TEST_* are
 * unset.
 */
import { schema } from '@buddha/db';
import { createDispute, createMarket, createUser } from '@buddha/db/test';
import { DISPUTE_REASON_MAX, type AdminDispute, type Dispute } from '@buddha/shared';
import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

const jsonHeaders = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
const HOUR_MS = 60 * 60 * 1000;

type Page<T> = { data: T[]; meta: { nextCursor: string | null } };
type ErrorBody = {
  error: { code: string; message: string; details?: { path: (string | number)[] }[] };
};

describe.skipIf(!hasTestInfra)('disputes (integration)', () => {
  let t: TestApp;
  let admin: TestUser;
  let user: TestUser;
  let other: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    admin = await signUpTestUser(t);
    user = await signUpTestUser(t);
    other = await signUpTestUser(t);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, admin.id));
    // The guard caches roles for 60 s (PLAN 10.5); the promotion above happened behind it.
    await t.app.get(AdminGuard).invalidate(admin.id);
  });

  const post = (url: string, payload: Record<string, unknown> | undefined, cookie: string) =>
    t.app.inject({ method: 'POST', url, headers: { ...jsonHeaders, cookie }, payload });
  const patch = (url: string, payload: Record<string, unknown>, cookie = admin.cookie) =>
    t.app.inject({ method: 'PATCH', url, headers: { ...jsonHeaders, cookie }, payload });
  const get = (url: string, cookie = user.cookie) =>
    t.app.inject({ method: 'GET', url, headers: { cookie } });

  const disputeBody = (overrides: Record<string, unknown> = {}) => ({
    reason: '공식 발표는 아니오였습니다.',
    evidenceUrl: 'https://example.com/announcement',
    ...overrides,
  });
  const file = (
    marketId: string,
    cookie = user.cookie,
    body: Record<string, unknown> = disputeBody(),
  ) => post(`/api/v1/markets/${marketId}/disputes`, body, cookie);
  const review = (id: string, payload: Record<string, unknown>, cookie = admin.cookie) =>
    patch(`/api/v1/admin/disputes/${id}`, payload, cookie);

  /**
   * A market mid-settlement, as `POST /admin/markets/:id/resolve` leaves it: the factory
   * writes the resolution columns as given (no event, no job), which is all filing reads.
   */
  const resolving = (input: Parameters<typeof createMarket>[1] = {}) => {
    const resolvedAt = new Date(Date.now() - HOUR_MS);
    return createMarket(t.db, {
      createdBy: admin.id,
      status: 'resolving',
      resolvedResult: 'YES',
      resolvedAt,
      disputeUntil: new Date(resolvedAt.getTime() + 24 * HOUR_MS),
      // `POST /admin/markets/:id/resolve` always writes one alongside the status (A-M3-19), so
      // a factory-made resolving market carries one too, and the admin row can answer it.
      statusEventId: 7101,
      ...input,
    });
  };

  const data = <T>(res: { json: <U>() => U }) => res.json<{ data: T }>().data;
  const pageOf = <T>(res: { json: <U>() => U }) => res.json<Page<T>>();
  const errorOf = (res: { json: <U>() => U }) => res.json<ErrorBody>().error;
  const detailPath = (res: { json: <U>() => U }) => errorOf(res).details?.[0]?.path;

  async function disputeRows(marketId?: string) {
    return t.db
      .select()
      .from(schema.disputes)
      .where(marketId ? eq(schema.disputes.marketId, marketId) : undefined)
      .orderBy(asc(schema.disputes.createdAt), asc(schema.disputes.id));
  }
  async function actionsFor(targetId: string) {
    return t.db
      .select()
      .from(schema.adminActions)
      .where(eq(schema.adminActions.targetId, targetId))
      .orderBy(asc(schema.adminActions.createdAt));
  }
  async function nicknameOf(userId: string) {
    const [row] = await t.db
      .select({ nickname: schema.profiles.nickname })
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, userId));
    return row!.nickname;
  }

  // --- POST /markets/:id/disputes ------------------------------------------------------
  describe('POST /markets/:id/disputes', () => {
    it('files a dispute during resolving: the row, and the answer joined with the market', async () => {
      const market = await resolving();
      const before = Date.now();
      const res = await file(market.id);
      expect(res.statusCode).toBe(201);
      const dispute = data<Dispute>(res);

      const rows = await disputeRows(market.id);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row).toMatchObject({
        id: dispute.id,
        marketId: market.id,
        userId: user.id,
        reason: '공식 발표는 아니오였습니다.',
        evidenceUrl: 'https://example.com/announcement',
        status: 'open',
        adminNote: null,
        reviewedBy: null,
        reviewedAt: null,
      });
      // created_at from the database clock, read inside the filing transaction (clock.ts).
      expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1_000);
      expect(row.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);

      expect(dispute).toEqual({
        id: row.id,
        marketId: market.id,
        marketSlug: market.slug,
        marketTitle: market.title,
        marketStatus: 'resolving',
        resolvedResult: 'YES',
        reason: row.reason,
        evidenceUrl: row.evidenceUrl,
        status: 'open',
        adminNote: null,
        reviewedAt: null,
        createdAt: row.createdAt.toISOString(),
      });
      // Filing writes no market change and no admin audit row (PLAN 12: review is the admin's step).
      const [after] = await t.db
        .select()
        .from(schema.markets)
        .where(eq(schema.markets.id, market.id));
      expect(after).toMatchObject({ status: 'resolving', resolvedResult: 'YES' });
      expect(await t.db.select().from(schema.adminActions)).toHaveLength(0);
    });

    it('stores a null evidenceUrl when the body omits it', async () => {
      const market = await resolving();
      const res = await file(market.id, user.cookie, { reason: '근거 없이 제기' });
      expect(res.statusCode).toBe(201);
      expect(data<Dispute>(res).evidenceUrl).toBeNull();
      expect((await disputeRows(market.id))[0]!.evidenceUrl).toBeNull();
    });

    it('refuses the same user a second time (DUPLICATE_REQUEST) while another user may still file', async () => {
      const market = await resolving();
      expect((await file(market.id)).statusCode).toBe(201);

      const again = await file(market.id, user.cookie, disputeBody({ reason: '다시 제기' }));
      expect(again.statusCode).toBe(409);
      expect(errorOf(again).code).toBe('DUPLICATE_REQUEST');

      const byOther = await file(market.id, other.cookie);
      expect(byOther.statusCode).toBe(201);
      expect(data<Dispute>(byOther).marketId).toBe(market.id);

      const rows = await disputeRows(market.id);
      expect(rows.map((row) => row.userId).sort()).toEqual([user.id, other.id].sort());
      // The refused filing left nothing behind: the first row still carries its own reason.
      expect(rows.find((row) => row.userId === user.id)!.reason).toBe(
        '공식 발표는 아니오였습니다.',
      );
    });

    it('answers DISPUTE_WINDOW_CLOSED once disputeUntil has passed, and for a settled or voided market', async () => {
      const past = new Date(Date.now() - 60_000);
      const expired = await resolving({
        resolvedAt: new Date(past.getTime() - 24 * HOUR_MS),
        disputeUntil: past,
      });
      const settled = await createMarket(t.db, {
        createdBy: admin.id,
        status: 'settled',
        resolvedResult: 'YES',
        resolvedAt: new Date(past.getTime() - 24 * HOUR_MS),
        disputeUntil: past,
        settledAt: past,
      });
      const voided = await createMarket(t.db, { createdBy: admin.id, status: 'voided' });

      for (const market of [expired, settled, voided]) {
        const res = await file(market.id);
        expect({ status: market.status, code: res.statusCode }).toEqual({
          status: market.status,
          code: 409,
        });
        expect(errorOf(res).code).toBe('DISPUTE_WINDOW_CLOSED');
      }
      expect(await disputeRows()).toHaveLength(0);
    });

    it('treats a resolving row without a dispute_until as closed', async () => {
      // Never written by resolve(), which sets both columns in one UPDATE; a window that
      // cannot be verified is not open (design 3.4, conservative reading).
      const market = await resolving({ disputeUntil: null });
      const res = await file(market.id);
      expect(res.statusCode).toBe(409);
      expect(errorOf(res).code).toBe('DISPUTE_WINDOW_CLOSED');
    });

    it('refuses an open or closed market naming status (nothing proposed yet)', async () => {
      for (const status of ['open', 'closed'] as const) {
        const market = await createMarket(t.db, { createdBy: admin.id, status });
        const res = await file(market.id);
        expect({ status, code: res.statusCode }).toEqual({ status, code: 400 });
        expect(errorOf(res).code).toBe('VALIDATION_ERROR');
        expect(detailPath(res)).toEqual(['status']);
      }
      expect(await disputeRows()).toHaveLength(0);
    });

    it('answers 404 for a draft and for an unknown id alike', async () => {
      const draft = await createMarket(t.db, { createdBy: admin.id, status: 'draft' });
      for (const id of [draft.id, randomUUID()]) {
        const res = await file(id);
        expect(res.statusCode).toBe(404);
        expect(errorOf(res).code).toBe('NOT_FOUND');
      }
      expect(await disputeRows()).toHaveLength(0);
    });

    it('validates the body: blank reason, overlong reason, non-http(s) or malformed URL', async () => {
      const market = await resolving();
      const bad: Record<string, unknown>[] = [
        { reason: '' },
        { reason: '   ' },
        { reason: 'x'.repeat(DISPUTE_REASON_MAX + 1) },
        { reason: 'ok', evidenceUrl: 'ftp://example.com/file' },
        { reason: 'ok', evidenceUrl: 'not a url' },
        { reason: 'ok', evidenceUrl: 'javascript:alert(1)' },
      ];
      for (const payload of bad) {
        const res = await file(market.id, user.cookie, payload);
        expect({ payload, code: res.statusCode }).toEqual({ payload, code: 400 });
        expect(errorOf(res).code).toBe('VALIDATION_ERROR');
      }
      // A reason at the bound, trimmed, is accepted.
      const ok = await file(market.id, user.cookie, {
        reason: ` ${'x'.repeat(DISPUTE_REASON_MAX)} `,
      });
      expect(ok.statusCode).toBe(201);
      expect(data<Dispute>(ok).reason).toHaveLength(DISPUTE_REASON_MAX);
      expect(await disputeRows(market.id)).toHaveLength(1);
    });

    it('answers 401 without a cookie and 403 for a foreign Origin', async () => {
      const market = await resolving();
      const anonymous = await t.app.inject({
        method: 'POST',
        url: `/api/v1/markets/${market.id}/disputes`,
        headers: jsonHeaders,
        payload: disputeBody(),
      });
      expect(anonymous.statusCode).toBe(401);
      expect(errorOf(anonymous).code).toBe('UNAUTHENTICATED');

      for (const origin of ['https://evil.example', 'null']) {
        const res = await t.app.inject({
          method: 'POST',
          url: `/api/v1/markets/${market.id}/disputes`,
          headers: { origin, 'content-type': 'application/json', cookie: user.cookie },
          payload: disputeBody(),
        });
        expect({ origin, code: res.statusCode }).toEqual({ origin, code: 403 });
        expect(errorOf(res).code).toBe('FORBIDDEN');
      }
      expect(await disputeRows()).toHaveLength(0);
    });
  });

  // --- GET /me/disputes ----------------------------------------------------------------
  describe('GET /me/disputes', () => {
    it('lists only the caller’s disputes, newest first, joined with each market', async () => {
      const first = await resolving({ title: '첫 시장' });
      const second = await resolving({ title: '둘째 시장' });
      const mine1 = await createDispute(t.db, { marketId: first.id, userId: user.id });
      // A later created_at: the factory leaves the column to the database default, so two
      // rows inserted back to back may share a millisecond and order by id instead.
      const mine2 = await createDispute(t.db, {
        marketId: second.id,
        userId: user.id,
        status: 'rejected',
        adminNote: '출처가 다릅니다',
        reviewedBy: admin.id,
        reviewedAt: new Date(),
      });
      await t.db
        .update(schema.disputes)
        .set({ createdAt: new Date(mine1.createdAt.getTime() + 1_000) })
        .where(eq(schema.disputes.id, mine2.id));
      await createDispute(t.db, { marketId: first.id, userId: other.id });

      const res = await get('/api/v1/me/disputes');
      expect(res.statusCode).toBe(200);
      const page = pageOf<Dispute>(res);
      expect(page.meta.nextCursor).toBeNull();
      expect(page.data.map((d) => d.id)).toEqual([mine2.id, mine1.id]);
      expect(page.data[0]).toMatchObject({
        marketId: second.id,
        marketSlug: second.slug,
        marketTitle: '둘째 시장',
        marketStatus: 'resolving',
        resolvedResult: 'YES',
        status: 'rejected',
        adminNote: '출처가 다릅니다',
      });
      expect(page.data[0]!.reviewedAt).not.toBeNull();
      // The own shape carries no user id and no reviewer (those are the admin's columns), and
      // no ordering key for the market snapshot: only the admin list reconciles two of those.
      expect(page.data[0]).not.toHaveProperty('userId');
      expect(page.data[0]).not.toHaveProperty('reviewedBy');
      expect(page.data[0]).not.toHaveProperty('nickname');
      expect(page.data[0]).not.toHaveProperty('statusEventId');

      const theirs = await get('/api/v1/me/disputes', other.cookie);
      expect(pageOf<Dispute>(theirs).data.map((d) => d.marketId)).toEqual([first.id]);
    });

    it('narrows to one market with ?marketId', async () => {
      const first = await resolving();
      const second = await resolving();
      await createDispute(t.db, { marketId: first.id, userId: user.id });
      const wanted = await createDispute(t.db, { marketId: second.id, userId: user.id });

      const res = await get(`/api/v1/me/disputes?marketId=${second.id}`);
      expect(res.statusCode).toBe(200);
      expect(pageOf<Dispute>(res).data.map((d) => d.id)).toEqual([wanted.id]);

      const none = await get(`/api/v1/me/disputes?marketId=${randomUUID()}`);
      expect(pageOf<Dispute>(none).data).toEqual([]);
      const malformed = await get('/api/v1/me/disputes?marketId=not-a-uuid');
      expect(malformed.statusCode).toBe(400);
      expect(errorOf(malformed).code).toBe('VALIDATION_ERROR');
    });

    it('pages with the keyset cursor', async () => {
      const markets = [await resolving(), await resolving(), await resolving()];
      const base = Date.now() - 10_000;
      const ids: string[] = [];
      for (const [i, market] of markets.entries()) {
        const row = await createDispute(t.db, { marketId: market.id, userId: user.id });
        await t.db
          .update(schema.disputes)
          .set({ createdAt: new Date(base + i * 1_000) })
          .where(eq(schema.disputes.id, row.id));
        ids.push(row.id);
      }
      const newestFirst = [...ids].reverse();

      const page1 = pageOf<Dispute>(await get('/api/v1/me/disputes?limit=1'));
      expect(page1.data.map((d) => d.id)).toEqual([newestFirst[0]]);
      expect(page1.meta.nextCursor).not.toBeNull();

      const page2 = pageOf<Dispute>(
        await get(`/api/v1/me/disputes?limit=1&cursor=${page1.meta.nextCursor!}`),
      );
      expect(page2.data.map((d) => d.id)).toEqual([newestFirst[1]]);
      expect(page2.meta.nextCursor).not.toBeNull();

      const page3 = pageOf<Dispute>(
        await get(`/api/v1/me/disputes?limit=2&cursor=${page2.meta.nextCursor!}`),
      );
      expect(page3.data.map((d) => d.id)).toEqual([newestFirst[2]]);
      expect(page3.meta.nextCursor).toBeNull();

      // A cursor whose id half is not a uuid starts over rather than reaching the uuid column.
      const reset = pageOf<Dispute>(await get('/api/v1/me/disputes?cursor=0_not-a-uuid'));
      expect(reset.data.map((d) => d.id)).toEqual(newestFirst);
    });

    it('answers 401 without a cookie', async () => {
      const res = await t.app.inject({ method: 'GET', url: '/api/v1/me/disputes' });
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).code).toBe('UNAUTHENTICATED');
    });
  });

  // --- GET /admin/disputes -------------------------------------------------------------
  describe('GET /admin/disputes', () => {
    it('lists every user’s disputes with the filer’s nickname, filtered by status and marketId', async () => {
      const first = await resolving();
      const second = await resolving();
      const a = await createDispute(t.db, { marketId: first.id, userId: user.id });
      const b = await createDispute(t.db, {
        marketId: first.id,
        userId: other.id,
        status: 'accepted',
        reviewedBy: admin.id,
        reviewedAt: new Date(),
      });
      const c = await createDispute(t.db, { marketId: second.id, userId: user.id });
      for (const [i, row] of [a, b, c].entries()) {
        await t.db
          .update(schema.disputes)
          .set({ createdAt: new Date(Date.now() - 10_000 + i * 1_000) })
          .where(eq(schema.disputes.id, row.id));
      }

      const all = await get('/api/v1/admin/disputes', admin.cookie);
      expect(all.statusCode).toBe(200);
      const page = pageOf<AdminDispute>(all);
      expect(page.data.map((d) => d.id)).toEqual([c.id, b.id, a.id]);
      expect(page.data[1]).toMatchObject({
        id: b.id,
        userId: other.id,
        nickname: await nicknameOf(other.id),
        marketId: first.id,
        marketSlug: first.slug,
        marketTitle: first.title,
        marketStatus: 'resolving',
        resolvedResult: 'YES',
        // The bigint column reaches the wire as a decimal string, like `MarketSummary`'s: it is
        // what orders two snapshots of one market in the admin list's 시장별 그룹.
        statusEventId: '7101',
        status: 'accepted',
        reviewedBy: admin.id,
      });
      expect(page.data[2]).toMatchObject({
        userId: user.id,
        nickname: await nicknameOf(user.id),
        status: 'open',
        reviewedBy: null,
        reviewedAt: null,
      });

      const open = pageOf<AdminDispute>(
        await get('/api/v1/admin/disputes?status=open', admin.cookie),
      );
      expect(open.data.map((d) => d.id)).toEqual([c.id, a.id]);
      const accepted = pageOf<AdminDispute>(
        await get('/api/v1/admin/disputes?status=accepted', admin.cookie),
      );
      expect(accepted.data.map((d) => d.id)).toEqual([b.id]);
      const byMarket = pageOf<AdminDispute>(
        await get(`/api/v1/admin/disputes?marketId=${first.id}`, admin.cookie),
      );
      expect(byMarket.data.map((d) => d.id)).toEqual([b.id, a.id]);
      const both = pageOf<AdminDispute>(
        await get(`/api/v1/admin/disputes?marketId=${first.id}&status=open`, admin.cookie),
      );
      expect(both.data.map((d) => d.id)).toEqual([a.id]);

      const badStatus = await get('/api/v1/admin/disputes?status=pending', admin.cookie);
      expect(badStatus.statusCode).toBe(400);
      expect(errorOf(badStatus).code).toBe('VALIDATION_ERROR');
    });

    it('pages with the keyset cursor', async () => {
      const market = await resolving();
      const filers = [user, other, { id: (await createUser(t.db)).user.id }];
      const ids: string[] = [];
      for (const [i, filer] of filers.entries()) {
        const row = await createDispute(t.db, { marketId: market.id, userId: filer.id });
        await t.db
          .update(schema.disputes)
          .set({ createdAt: new Date(Date.now() - 10_000 + i * 1_000) })
          .where(eq(schema.disputes.id, row.id));
        ids.push(row.id);
      }
      const page1 = pageOf<AdminDispute>(await get('/api/v1/admin/disputes?limit=2', admin.cookie));
      expect(page1.data.map((d) => d.id)).toEqual([ids[2], ids[1]]);
      expect(page1.meta.nextCursor).not.toBeNull();
      const page2 = pageOf<AdminDispute>(
        await get(`/api/v1/admin/disputes?limit=2&cursor=${page1.meta.nextCursor!}`, admin.cookie),
      );
      expect(page2.data.map((d) => d.id)).toEqual([ids[0]]);
      expect(page2.meta.nextCursor).toBeNull();
    });

    it('answers 403 for a member and 401 without a cookie', async () => {
      const market = await resolving();
      const row = await createDispute(t.db, { marketId: market.id, userId: user.id });
      for (const [method, url, payload] of [
        ['GET', '/api/v1/admin/disputes', undefined],
        ['PATCH', `/api/v1/admin/disputes/${row.id}`, { status: 'rejected', adminNote: 'x' }],
      ] as const) {
        const asMember = await t.app.inject({
          method,
          url,
          headers: { ...jsonHeaders, cookie: user.cookie },
          payload,
        });
        expect({ method, status: asMember.statusCode }).toEqual({ method, status: 403 });
        expect(errorOf(asMember).code).toBe('FORBIDDEN');

        const anonymous = await t.app.inject({ method, url, headers: jsonHeaders, payload });
        expect({ method, status: anonymous.statusCode }).toEqual({ method, status: 401 });
        expect(errorOf(anonymous).code).toBe('UNAUTHENTICATED');
      }
      expect((await disputeRows(market.id))[0]!.status).toBe('open');
      expect(await t.db.select().from(schema.adminActions)).toHaveLength(0);
    });
  });

  // --- PATCH /admin/disputes/:id -------------------------------------------------------
  describe('PATCH /admin/disputes/:id', () => {
    it('accepts with a note: row columns, reviewer, review instant and the audit row', async () => {
      const market = await resolving();
      const row = await createDispute(t.db, { marketId: market.id, userId: user.id });
      const before = Date.now();

      const res = await review(row.id, {
        status: 'accepted',
        adminNote: '근거 확인, 결과 변경 예정',
      });
      expect(res.statusCode).toBe(200);
      const dispute = data<AdminDispute>(res);
      expect(dispute).toMatchObject({
        id: row.id,
        marketId: market.id,
        marketSlug: market.slug,
        marketTitle: market.title,
        marketStatus: 'resolving',
        resolvedResult: 'YES',
        userId: user.id,
        nickname: await nicknameOf(user.id),
        reason: row.reason,
        status: 'accepted',
        adminNote: '근거 확인, 결과 변경 예정',
        reviewedBy: admin.id,
        createdAt: row.createdAt.toISOString(),
      });

      const [stored] = await disputeRows(market.id);
      expect(stored).toMatchObject({
        status: 'accepted',
        adminNote: '근거 확인, 결과 변경 예정',
        reviewedBy: admin.id,
      });
      expect(stored!.reviewedAt).not.toBeNull();
      expect(stored!.reviewedAt!.getTime()).toBeGreaterThanOrEqual(before - 1_000);
      expect(stored!.reviewedAt!.toISOString()).toBe(dispute.reviewedAt);

      const actions = await actionsFor(row.id);
      expect(actions).toHaveLength(1);
      expect(actions[0]).toMatchObject({
        adminId: admin.id,
        type: 'dispute_review',
        targetType: 'dispute',
        targetId: row.id,
        payload: {
          before: { status: 'open', adminNote: null },
          after: { status: 'accepted', adminNote: '근거 확인, 결과 변경 예정' },
          marketId: market.id,
          userId: user.id,
        },
      });
      // Same instant as the review, from the database clock inside the transaction.
      expect(actions[0]!.createdAt.toISOString()).toBe(dispute.reviewedAt);

      // PLAN 12: accepting changes nothing on the market by itself.
      const [after] = await t.db
        .select()
        .from(schema.markets)
        .where(eq(schema.markets.id, market.id));
      expect(after).toMatchObject({ status: 'resolving', resolvedResult: 'YES' });
    });

    it('rejects without a note, and the user sees the verdict on GET /me/disputes', async () => {
      const market = await resolving();
      const row = await createDispute(t.db, { marketId: market.id, userId: user.id });
      const res = await review(row.id, { status: 'rejected' });
      expect(res.statusCode).toBe(200);
      expect(data<AdminDispute>(res)).toMatchObject({
        status: 'rejected',
        adminNote: null,
        reviewedBy: admin.id,
      });
      const mine = pageOf<Dispute>(await get('/api/v1/me/disputes'));
      expect(mine.data[0]).toMatchObject({ id: row.id, status: 'rejected', adminNote: null });
      expect(mine.data[0]!.reviewedAt).not.toBeNull();
    });

    it('re-review flips the verdict, keeps an omitted note, clears a null one, and audits each step', async () => {
      const market = await resolving();
      const row = await createDispute(t.db, { marketId: market.id, userId: user.id });
      expect((await review(row.id, { status: 'rejected', adminNote: '첫 판단' })).statusCode).toBe(
        200,
      );
      const firstReviewedAt = (await disputeRows(market.id))[0]!.reviewedAt!;

      const flipped = await review(row.id, { status: 'accepted' });
      expect(flipped.statusCode).toBe(200);
      expect(data<AdminDispute>(flipped)).toMatchObject({
        status: 'accepted',
        adminNote: '첫 판단',
        reviewedBy: admin.id,
      });
      const [afterFlip] = await disputeRows(market.id);
      expect(afterFlip!.status).toBe('accepted');
      expect(afterFlip!.reviewedAt!.getTime()).toBeGreaterThanOrEqual(firstReviewedAt.getTime());

      const cleared = await review(row.id, { status: 'accepted', adminNote: null });
      expect(cleared.statusCode).toBe(200);
      expect(data<AdminDispute>(cleared).adminNote).toBeNull();

      const actions = await actionsFor(row.id);
      expect(actions.map((a) => a.payload)).toEqual([
        expect.objectContaining({
          before: { status: 'open', adminNote: null },
          after: { status: 'rejected', adminNote: '첫 판단' },
        }),
        expect.objectContaining({
          before: { status: 'rejected', adminNote: '첫 판단' },
          after: { status: 'accepted', adminNote: '첫 판단' },
        }),
        expect.objectContaining({
          before: { status: 'accepted', adminNote: '첫 판단' },
          after: { status: 'accepted', adminNote: null },
        }),
      ]);
      expect(actions.every((a) => a.type === 'dispute_review')).toBe(true);
    });

    it('validates the body: `open` is not a verdict, the note is bounded', async () => {
      const market = await resolving();
      const row = await createDispute(t.db, { marketId: market.id, userId: user.id });
      for (const payload of [
        { status: 'open' },
        { status: 'maybe' },
        { adminNote: 'x' },
        { status: 'accepted', adminNote: 'x'.repeat(1_001) },
      ]) {
        const res = await review(row.id, payload);
        expect({ payload, code: res.statusCode }).toEqual({ payload, code: 400 });
        expect(errorOf(res).code).toBe('VALIDATION_ERROR');
      }
      expect((await disputeRows(market.id))[0]!.status).toBe('open');
      expect(await actionsFor(row.id)).toHaveLength(0);
    });

    it('answers 404 for an unknown id and 400 for a malformed one', async () => {
      const missing = await review(randomUUID(), { status: 'accepted' });
      expect(missing.statusCode).toBe(404);
      expect(errorOf(missing).code).toBe('NOT_FOUND');
      const malformed = await review('not-a-uuid', { status: 'accepted' });
      expect(malformed.statusCode).toBe(400);
      expect(errorOf(malformed).code).toBe('VALIDATION_ERROR');
      expect(await t.db.select().from(schema.adminActions)).toHaveLength(0);
    });

    it('refuses a cookie-authenticated review whose Origin is not ours (CSRF)', async () => {
      const market = await resolving();
      const row = await createDispute(t.db, { marketId: market.id, userId: user.id });
      const res = await t.app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/disputes/${row.id}`,
        headers: {
          origin: 'https://evil.example',
          'content-type': 'application/json',
          cookie: admin.cookie,
        },
        payload: { status: 'accepted' },
      });
      expect(res.statusCode).toBe(403);
      expect(errorOf(res).code).toBe('FORBIDDEN');
      expect((await disputeRows(market.id))[0]!.status).toBe('open');
    });
  });
});
