/**
 * Admin surface integration tests (PLAN M2 AC 3-4, PLAN 7.3/12) against the docker `test`
 * profile. Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import { SIGNUP_BONUS_P, type AdminBalanceAdjustResult, type AdminUser } from '@buddha/shared';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import {
  chargeBody,
  chargeHeaders,
  createTestApp,
  createTestPackage,
  signUpTestUser,
  type TestApp,
  type TestUser,
} from '../test/app.js';
import { expectLedgerChain } from '../test/ledger.js';
import { hasTestInfra } from '../test/setup-env.js';
import { waitForLockWaiter } from '../test/wait.js';

const jsonHeaders = { origin: 'http://localhost:3000', 'content-type': 'application/json' };

describe.skipIf(!hasTestInfra)('admin (integration)', () => {
  let t: TestApp;
  let admin: TestUser;
  let member: TestUser;

  beforeAll(async () => {
    // `chargeMember` funds the member through the charge: preserved code, closed in production
    // while paid Coin is off (ADR-0049), open for this app.
    t = await createTestApp({ paidCoinSales: true });
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
      headers: chargeHeaders(member.cookie),
      payload: chargeBody(pack, member.id),
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

  it('stamps the adjustment after the balance lock, not at transaction start (A-M3-14)', async () => {
    // The adjustment transaction begins and then waits on the balance row this connection
    // holds. Whatever committed against the account meanwhile is already in its
    // balance_after_p, so its ledger and audit rows must sort after it.
    const holder = await t.db.$client.connect();
    let pending: ReturnType<typeof adjust> | undefined;
    let released = false;
    let releasedMs!: number;
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT user_id FROM balances WHERE user_id = '${member.id}' FOR UPDATE`);
      pending = adjust({ amountP: '2500', memo: '보상 지급' });
      await waitForLockWaiter(holder, 'the adjustment on the balance row');
      const { rows } = await holder.query<{ ms: string }>(
        'SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint::text AS ms',
      );
      releasedMs = Number(rows[0]!.ms);
      await holder.query('COMMIT');
      released = true;
      expect((await pending).statusCode).toBe(200);
    } finally {
      if (!released) await holder.query('ROLLBACK');
      holder.release();
      await pending?.catch(() => undefined);
    }

    const ledger = await t.db
      .select()
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.userId, member.id))
      .orderBy(asc(schema.ledgerEntries.id));
    const adjusted = ledger.find((entry) => entry.type === 'ADMIN_ADJUST')!;
    expect(adjusted.createdAt.getTime()).toBeGreaterThanOrEqual(releasedMs);
    expect((await balanceOf(member.id))!.updatedAt.getTime()).toBe(adjusted.createdAt.getTime());
    // The audit row of the same transaction carries that instant too.
    const [action] = await t.db
      .select()
      .from(schema.adminActions)
      .where(eq(schema.adminActions.targetId, member.id));
    expect(action!.createdAt.getTime()).toBe(adjusted.createdAt.getTime());
    expectLedgerChain(ledger, SIGNUP_BONUS_P + 2_500n);
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

  it('rejects a malformed uuid path param as VALIDATION_ERROR, not a 500', async () => {
    // Straight through to a `where id = 'not-a-uuid'` on a uuid column, Postgres raises
    // 22P02, and the exception filter has no SQLSTATE mapping — so this used to be a 500.
    const routes: [string, string][] = [
      ['PATCH', '/api/v1/admin/charge-packages/not-a-uuid'],
      ['DELETE', '/api/v1/admin/charge-packages/not-a-uuid'],
      ['PATCH', '/api/v1/admin/coupons/not-a-uuid'],
    ];
    for (const [method, url] of routes) {
      const res = await t.app.inject({
        method: method as 'PATCH' | 'DELETE',
        url,
        headers: { ...jsonHeaders, cookie: admin.cookie },
        ...(method === 'PATCH' ? { payload: { isActive: false } } : {}),
      });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 400 });
      expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
  });

  it('serves the first page for a malformed cursor instead of a 500', async () => {
    // A cursor is opaque and server-minted, so a corrupted one is not worth an error — but it
    // must not reach the query. `0_not-a-uuid` hit `id < $1` on a uuid column (22P02) and a
    // digits-only id hit a bigint (also 22P02); both rendered as 500 because the exception
    // filter has no SQLSTATE branch. The timestamp half is worse: between 8.64e15 and
    // MAX_SAFE_INTEGER it built an Invalid Date, and drizzle's encoder threw RangeError before
    // any query was sent — which broke even /admin/users, whose id column is plain text.
    const routes = [
      '/api/v1/admin/coupons',
      '/api/v1/admin/payments',
      '/api/v1/admin/audit-failures',
      '/api/v1/admin/users',
    ];
    for (const route of routes) {
      for (const cursor of ['0_not-a-uuid', '0_not-a-number', '8640000000000001_x']) {
        const res = await t.app.inject({
          method: 'GET',
          url: `${route}?cursor=${encodeURIComponent(cursor)}`,
          headers: { cookie: admin.cookie },
        });
        expect({ route, cursor, status: res.statusCode }).toEqual({
          route,
          cursor,
          status: 200,
        });
      }
    }
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

  it('refuses a cookie-authenticated mutation whose Origin is not ours (CSRF)', async () => {
    // The session cookie is SameSite=Lax and web + API share one site (ADR-0017), so a page on
    // a sibling host can submit a form with the admin's cookie attached, and the browser sends
    // it without any CORS preflight. Two things stop it now: SessionGuard refuses a foreign
    // Origin (403, before the session is even looked up), and the urlencoded body parser is
    // off, so a form body is no body at all (400) even from our own origin — this API speaks
    // JSON, which no cross-origin page can send without a preflight we never answer. Before
    // this round the form was stopped by accident alone: the parser 500ed for want of `qs`.
    const post = (origin: string | undefined, body: { type: 'form' | 'json' }) =>
      t.app.inject({
        method: 'POST',
        url: `/api/v1/admin/users/${member.id}/balance-adjust`,
        headers: {
          ...(origin === undefined ? {} : { origin }),
          cookie: admin.cookie,
          'content-type':
            body.type === 'form' ? 'application/x-www-form-urlencoded' : 'application/json',
        },
        payload:
          body.type === 'form' ? 'amountP=-3000&memo=csrf' : { amountP: '-3000', memo: 'csrf' },
      });

    for (const origin of ['https://evil.example', 'null']) {
      for (const type of ['form', 'json'] as const) {
        const res = await post(origin, { type });
        expect({ origin, type, status: res.statusCode }).toEqual({ origin, type, status: 403 });
        expect(res.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
      }
    }
    expect(await balanceOf(member.id)).toMatchObject({ availableP: SIGNUP_BONUS_P });
    expect(await t.db.select().from(schema.adminActions)).toHaveLength(0);

    // A form from our own origin is refused for its shape, not its origin.
    const form = await post('http://localhost:3000', { type: 'form' });
    expect(form.statusCode).toBe(400);
    expect(form.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    // JSON from our own origin passes; so does JSON with no Origin at all (curl, a server):
    // no browser sent it, so it cannot be a forgery.
    expect((await post('http://localhost:3000', { type: 'json' })).statusCode).toBe(200);
    expect((await post(undefined, { type: 'json' })).statusCode).toBe(200);
    expect(await balanceOf(member.id)).toMatchObject({ availableP: SIGNUP_BONUS_P - 6_000n });

    // Reads are never checked: without CORS headers nothing cross-origin can read them anyway.
    const read = await t.app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: { origin: 'https://evil.example', cookie: admin.cookie },
    });
    expect(read.statusCode).toBe(200);
  });
});
