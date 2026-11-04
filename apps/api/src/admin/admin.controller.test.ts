/**
 * Admin surface integration tests (PLAN M2 AC 3-4, PLAN 7.3/12) against the docker `test`
 * profile. Skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import { completeOnboarding, createMarketMakerAccount } from '@buddha/db/test';
import { MARKET_MAKER_ACCOUNT_EMAIL, type AdminUser } from '@buddha/shared';
import { eq } from 'drizzle-orm';
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
import { hasTestInfra } from '../test/setup-env.js';

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
    // An admin finishes the onboarding like any account before /admin answers it (ADR-0072).
    await completeOnboarding(t.db, { userId: admin.id });
    // The guard caches roles for 60 s (PLAN 10.5); the promotion above happened behind it.
    await t.app.get(AdminGuard).invalidate(admin.id);
  });

  /** Buys a package worth `amountCoin` (ADR-0026: users can only buy what an admin listed). */
  const chargeMember = async (amountCoin: bigint) => {
    const pack = await createTestPackage(t.db, { amountCoin, priceKrw: Number(amountCoin) });
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

  it('has no balance adjustment: the route is gone, nothing moves (#116, ADR-0107 결정 2 #73 7항)', async () => {
    // Neither direction remains: no admin grants or takes Coin at discretion (결정 4 #116).
    await chargeMember(10_000n);
    for (const amountCoin of ['2500', '-3000']) {
      const res = await t.app.inject({
        method: 'POST',
        url: `/api/v1/admin/users/${member.id}/balance-adjust`,
        headers: { ...jsonHeaders, cookie: admin.cookie },
        payload: { amountCoin, memo: '조정', expectedAccountId: admin.id },
      });
      expect(res.statusCode, res.body).toBe(404);
    }
    expect(await balanceOf(member.id)).toMatchObject({ availableCoin: 10_000n });
    expect(await t.db.select().from(schema.adminActions)).toHaveLength(0);
  });

  it('does not list the 운영 마켓메이커 account, which has no profile (#115)', async () => {
    await createMarketMakerAccount(t.db);
    const search = await t.app.inject({
      method: 'GET',
      url: `/api/v1/admin/users?q=${encodeURIComponent(MARKET_MAKER_ACCOUNT_EMAIL)}`,
      headers: { cookie: admin.cookie },
    });
    expect(search.statusCode).toBe(200);
    expect(search.json<{ data: AdminUser[] }>().data).toEqual([]);
  });

  it('is closed to members and to anonymous callers', async () => {
    const asMember = await t.app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: { cookie: member.cookie },
    });
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
      url: `/api/v1/admin/users?q=${encodeURIComponent(profile!.nickname!)}`,
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
      data: [{ userId: member.id, amountCoin: '7000', status: 'succeeded' }],
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
      // The admin on screen named (ADR-0092), so the refusal is the path's alone.
      const res = await t.app.inject({
        method: method as 'PATCH' | 'DELETE',
        url: method === 'PATCH' ? url : `${url}?expectedAccountId=${admin.id}`,
        headers: { ...jsonHeaders, cookie: admin.cookie },
        ...(method === 'PATCH'
          ? { payload: { isActive: false, expectedAccountId: admin.id } }
          : {}),
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
    // An admin write that leaves an audit row: issuing a coupon (preserved code, open in this
    // sale-enabled app; the balance adjustment this case probed went with #116).
    const post = (origin: string | undefined, body: { type: 'form' | 'json' }) =>
      t.app.inject({
        method: 'POST',
        url: '/api/v1/admin/coupons',
        headers: {
          ...(origin === undefined ? {} : { origin }),
          cookie: admin.cookie,
          'content-type':
            body.type === 'form' ? 'application/x-www-form-urlencoded' : 'application/json',
        },
        payload:
          body.type === 'form'
            ? `amountCoin=3000&memo=csrf&expectedAccountId=${admin.id}`
            : { amountCoin: '3000', memo: 'csrf', expectedAccountId: admin.id },
      });

    for (const origin of ['https://evil.example', 'null']) {
      for (const type of ['form', 'json'] as const) {
        const res = await post(origin, { type });
        expect({ origin, type, status: res.statusCode }).toEqual({ origin, type, status: 403 });
        expect(res.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
      }
    }
    expect(await t.db.select().from(schema.coupons)).toHaveLength(0);
    expect(await t.db.select().from(schema.adminActions)).toHaveLength(0);

    // A form from our own origin is refused for its shape, not its origin.
    const form = await post('http://localhost:3000', { type: 'form' });
    expect(form.statusCode).toBe(400);
    expect(form.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    // JSON from our own origin passes; so does JSON with no Origin at all (curl, a server):
    // no browser sent it, so it cannot be a forgery.
    expect((await post('http://localhost:3000', { type: 'json' })).statusCode).toBe(201);
    expect((await post(undefined, { type: 'json' })).statusCode).toBe(201);
    expect(await t.db.select().from(schema.coupons)).toHaveLength(2);
    expect(await t.db.select().from(schema.adminActions)).toHaveLength(2);

    // Reads are never checked: without CORS headers nothing cross-origin can read them anyway.
    const read = await t.app.inject({
      method: 'GET',
      url: '/api/v1/admin/users',
      headers: { origin: 'https://evil.example', cookie: admin.cookie },
    });
    expect(read.statusCode).toBe(200);
  });
});
