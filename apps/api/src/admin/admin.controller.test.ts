/**
 * Admin surface integration tests (PLAN M2 AC 3-4, PLAN 7.3/12) against the docker `test`
 * profile. Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import { SIGNUP_BONUS_P, type AdminBalanceAdjustResult, type AdminUser } from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import {
  createTestApp,
  createTestPackage,
  signUpTestUser,
  type TestApp,
  type TestUser,
} from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

const jsonHeaders = { origin: 'http://localhost:3000', 'content-type': 'application/json' };

describe.skipIf(!hasTestInfra)('admin (integration)', () => {
  let t: TestApp;
  let admin: TestUser;
  let member: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    admin = await signUpTestUser(t);
    member = await signUpTestUser(t);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, admin.id));
    // The guard caches roles for 60 s (PLAN 10.5); the promotion above happened behind it.
    await t.app.get(AdminGuard).invalidate(admin.id);
  });

  const adjust = (payload: Record<string, unknown>, cookie = admin.cookie, target = member.id) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/users/${target}/balance-adjust`,
      headers: { ...jsonHeaders, cookie },
      payload,
    });

  /** Buys a package worth `amountP` (ADR-0026: users can only buy what an admin listed). */
  const chargeMember = async (amountP: bigint) => {
    const pack = await createTestPackage(t.db, { amountP, priceKrw: Number(amountP) });
    return t.app.inject({
      method: 'POST',
      url: '/api/v1/payments/charge',
      headers: { ...jsonHeaders, cookie: member.cookie },
      payload: { packageId: pack.id },
    });
  };

  async function balanceOf(userId: string) {
    const [row] = await t.db
      .select()
      .from(schema.balances)
      .where(eq(schema.balances.userId, userId));
    return row;
  }

  it('debits 3,000P from a charged balance and records ADMIN_ADJUST with the reason (AC 3)', async () => {
    await chargeMember(10_000n);
    const afterAdjust = SIGNUP_BONUS_P + 10_000n - 3_000n;

    const res = await adjust({ amountP: '-3000', memo: '중복 충전 회수' });
    expect(res.statusCode).toBe(200);
    const { data } = res.json<{ data: AdminBalanceAdjustResult }>();
    expect(data.user.balance).toEqual({ availableP: afterAdjust.toString(), lockedP: '0' });
    expect(data.ledgerEntry).toMatchObject({
      type: 'ADMIN_ADJUST',
      amountP: '-3000',
      balanceAfterP: afterAdjust.toString(),
      refType: 'admin_action',
      memo: '중복 충전 회수',
    });

    expect(await balanceOf(member.id)).toMatchObject({ availableP: afterAdjust });
    const [action] = await t.db
      .select()
      .from(schema.adminActions)
      .where(eq(schema.adminActions.targetId, member.id));
    expect(action).toMatchObject({ adminId: admin.id, type: 'balance_adjust', targetType: 'user' });
    expect(data.ledgerEntry.refId).toBe(action?.id);
  });

  it('refuses an adjustment that would make the balance negative, changing nothing (AC 4)', async () => {
    await chargeMember(10_000n);
    const balance = SIGNUP_BONUS_P + 10_000n;

    const res = await adjust({ amountP: (-balance - 1n).toString(), memo: '과다 회수' });
    expect(res.statusCode).toBe(409); // HTTP_STATUS_BY_CODE: INSUFFICIENT_BALANCE -> CONFLICT
    expect(res.json()).toMatchObject({ error: { code: 'INSUFFICIENT_BALANCE' } });

    expect(await balanceOf(member.id)).toMatchObject({ availableP: balance });
    const entries = await t.db
      .select()
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.userId, member.id))
      .orderBy(schema.ledgerEntries.id);
    // The sign-up bonus and the charge; the refused adjustment added nothing.
    expect(entries.map((entry) => entry.type)).toEqual(['BONUS', 'DEPOSIT']);
    // The audit row is rolled back with the rest of the transaction.
    expect(
      await t.db
        .select()
        .from(schema.adminActions)
        .where(eq(schema.adminActions.targetId, member.id)),
    ).toHaveLength(0);
  });

  it('credits P as well, and requires a memo and a non-zero amount', async () => {
    const credited = await adjust({ amountP: '2500', memo: '보상 지급' });
    expect(credited.statusCode).toBe(200);
    expect(await balanceOf(member.id)).toMatchObject({ availableP: SIGNUP_BONUS_P + 2_500n });

    for (const payload of [
      { amountP: '1000' },
      { amountP: '1000', memo: '   ' },
      { amountP: '0', memo: '영원' },
    ]) {
      const res = await adjust(payload);
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
    expect(await balanceOf(member.id)).toMatchObject({ availableP: SIGNUP_BONUS_P + 2_500n });
  });

  it('404s for an unknown user without writing an audit row', async () => {
    const res = await adjust(
      { amountP: '1000', memo: '없는 사용자' },
      admin.cookie,
      'no-such-user',
    );
    expect(res.statusCode).toBe(404);
    expect(await t.db.select().from(schema.adminActions)).toHaveLength(0);
  });

  it('is closed to members and to anonymous callers', async () => {
    const asMember = await adjust({ amountP: '1000', memo: '권한 없음' }, member.cookie);
    expect(asMember.statusCode).toBe(403);
    expect(asMember.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });

    const anonymous = await t.app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('searches users by email and nickname', async () => {
    const [profile] = await t.db
      .select()
      .from(schema.profiles)
      .where(eq(schema.profiles.userId, member.id));

    const byNickname = await t.app.inject({
      method: 'GET',
      url: `/api/v1/admin/users?q=${encodeURIComponent(profile!.nickname)}`,
      headers: { cookie: admin.cookie },
    });
    expect(byNickname.statusCode).toBe(200);
    const found = byNickname.json<{ data: AdminUser[] }>().data;
    expect(found.map((row) => row.id)).toEqual([member.id]);
    expect(found[0]).toMatchObject({ email: member.email, role: 'user' });

    const byEmail = await t.app.inject({
      method: 'GET',
      url: `/api/v1/admin/users?q=${encodeURIComponent(member.email)}`,
      headers: { cookie: admin.cookie },
    });
    expect(byEmail.json<{ data: AdminUser[] }>().data.map((row) => row.id)).toEqual([member.id]);

    const noMatch = await t.app.inject({
      method: 'GET',
      url: '/api/v1/admin/users?q=%25', // a bare LIKE wildcard must not match everything
      headers: { cookie: admin.cookie },
    });
    expect(noMatch.json<{ data: AdminUser[] }>().data).toHaveLength(0);
  });

  it('lists payments and audit failures', async () => {
    await chargeMember(7_000n);
    const payments = await t.app.inject({
      method: 'GET',
      url: '/api/v1/admin/payments',
      headers: { cookie: admin.cookie },
    });
    expect(payments.statusCode).toBe(200);
    expect(payments.json()).toMatchObject({
      data: [{ userId: member.id, amountP: '7000', status: 'succeeded' }],
    });

    await t.db
      .insert(schema.auditFailures)
      .values({ kind: 'ledger_balance_mismatch', payload: { userId: member.id } });
    const failures = await t.app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-failures',
      headers: { cookie: admin.cookie },
    });
    expect(failures.json()).toMatchObject({
      data: [{ kind: 'ledger_balance_mismatch', payload: { userId: member.id } }],
    });
  });

  it('pages past rows that share one created_at instead of dropping them', async () => {
    // One statement, so all five rows carry the same transaction `now()` — what the
    // ledger.audit job writes when it finds several broken accounts at once. The cursor is a
    // JS Date, so before migration 0005 rounded the columns to milliseconds it was strictly
    // older than the value it came from, and page 2 matched neither `< cursor` nor
    // `= cursor`: the listing simply ended after 20 rows with no error.
    await t.db.insert(schema.auditFailures).values(
      [1, 2, 3, 4, 5].map((n) => ({
        kind: 'ledger_balance_mismatch' as const,
        payload: { userId: member.id, n },
      })),
    );

    const seen: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const url: string = `/api/v1/admin/audit-failures?limit=2${
        cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`
      }`;
      const res = await t.app.inject({ method: 'GET', url, headers: { cookie: admin.cookie } });
      expect(res.statusCode).toBe(200);
      const body = res.json<{
        data: { payload: { n: number } }[];
        meta: { nextCursor: string | null };
      }>();
      seen.push(...body.data.map((row) => row.payload.n));
      cursor = body.meta.nextCursor;
      if (cursor === null) break;
    }

    expect(cursor).toBeNull();
    // Newest first, every row exactly once — no gap and no repeat across the tie.
    expect(seen).toEqual([5, 4, 3, 2, 1]);
  });
});
