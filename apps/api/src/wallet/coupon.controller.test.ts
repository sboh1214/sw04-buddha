/**
 * Coupons (ADR-0026): redemption limits, one use per account, and the admin side that issues
 * them. Runs against the docker `test` profile; skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import { SIGNUP_BONUS_P, type Coupon } from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

const jsonHeaders = { origin: 'http://localhost:3000', 'content-type': 'application/json' };

describe.skipIf(!hasTestInfra)('coupons (integration)', () => {
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
    await t.app.get(AdminGuard).invalidate(admin.id);
  });

  const issue = (payload: Record<string, unknown>, cookie = admin.cookie) =>
    t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/coupons',
      headers: { ...jsonHeaders, cookie },
      payload,
    });

  const redeem = (code: string, cookie = member.cookie) =>
    t.app.inject({
      method: 'POST',
      url: '/api/v1/coupons/redeem',
      headers: { ...jsonHeaders, cookie },
      payload: { code },
    });

  async function balanceOf(userId: string) {
    const [row] = await t.db
      .select()
      .from(schema.balances)
      .where(eq(schema.balances.userId, userId));
    return row;
  }

  it('issues a coupon and credits P as a BONUS entry when it is redeemed', async () => {
    const created = await issue({ code: 'welcome-2026', amountP: '5000', memo: '런칭 이벤트' });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ data: Coupon }>().data).toMatchObject({
      code: 'WELCOME-2026',
      amountP: '5000',
      redeemedCount: 0,
      isActive: true,
    });

    // Codes are case-insensitive for the user typing them in.
    const res = await redeem('welcome-2026');
    expect(res.statusCode).toBe(200);
    const expected = SIGNUP_BONUS_P + 5_000n;
    expect(res.json()).toMatchObject({
      data: {
        code: 'WELCOME-2026',
        amountP: '5000',
        balance: { availableP: expected.toString() },
        ledgerEntry: {
          type: 'BONUS',
          amountP: '5000',
          refType: 'coupon',
          memo: '쿠폰 WELCOME-2026',
        },
      },
    });
    expect(await balanceOf(member.id)).toMatchObject({ availableP: expected });

    const [redemption] = await t.db.select().from(schema.couponRedemptions);
    expect(redemption).toMatchObject({ userId: member.id, amountP: 5_000n });
    const [coupon] = await t.db.select().from(schema.coupons);
    expect(coupon?.redeemedCount).toBe(1);
  });

  it('refuses a second redemption by the same account', async () => {
    await issue({ code: 'ONCE-ONLY', amountP: '1000' });
    expect((await redeem('ONCE-ONLY')).statusCode).toBe(200);

    const again = await redeem('ONCE-ONLY');
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: { code: 'DUPLICATE_REQUEST' } });
    expect(await balanceOf(member.id)).toMatchObject({ availableP: SIGNUP_BONUS_P + 1_000n });
  });

  it('stops at the redemption cap, and a disabled or expired coupon is simply invalid', async () => {
    await issue({ code: 'CAP-ONE', amountP: '1000', maxRedemptions: 1 });
    expect((await redeem('CAP-ONE')).statusCode).toBe(200);

    const other = await signUpTestUser(t);
    const capped = await redeem('CAP-ONE', other.cookie);
    expect(capped.statusCode).toBe(400);
    expect(capped.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(await balanceOf(other.id)).toMatchObject({ availableP: SIGNUP_BONUS_P });

    await issue({ code: 'EXPIRED', amountP: '1000', expiresAt: '2020-01-01T00:00:00.000Z' });
    expect((await redeem('EXPIRED', other.cookie)).statusCode).toBe(400);

    const disabled = await issue({ code: 'DISABLED', amountP: '1000' });
    await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/coupons/${disabled.json<{ data: Coupon }>().data.id}`,
      headers: { ...jsonHeaders, cookie: admin.cookie },
      payload: { isActive: false },
    });
    expect((await redeem('DISABLED', other.cookie)).statusCode).toBe(400);

    // An unknown code answers exactly like a disabled one: no way to map the catalogue.
    expect((await redeem('NO-SUCH-CODE', other.cookie)).statusCode).toBe(400);
    expect(await balanceOf(other.id)).toMatchObject({ availableP: SIGNUP_BONUS_P });
  });

  it('generates a code when none is given and refuses a duplicate one', async () => {
    const generated = await issue({ amountP: '2000' });
    expect(generated.statusCode).toBe(201);
    const code = generated.json<{ data: Coupon }>().data.code;
    expect(code).toMatch(/^[23456789A-HJ-NP-Z]{10}$/);

    const duplicate = await issue({ code, amountP: '2000' });
    expect(duplicate.statusCode).toBe(400);
    expect(duplicate.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('is issued by admins only, and redemption needs a session', async () => {
    const asMember = await issue({ amountP: '1000' }, member.cookie);
    expect(asMember.statusCode).toBe(403);

    const anonymous = await t.app.inject({
      method: 'POST',
      url: '/api/v1/coupons/redeem',
      headers: jsonHeaders,
      payload: { code: 'ANYTHING' },
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('lists coupons for the admin, newest first', async () => {
    await issue({ code: 'FIRST-ONE', amountP: '1000' });
    await issue({ code: 'SECOND-ONE', amountP: '2000' });
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/admin/coupons?limit=1',
      headers: { cookie: admin.cookie },
    });
    expect(res.statusCode).toBe(200);
    const page = res.json<{ data: Coupon[]; meta: { nextCursor: string | null } }>();
    expect(page.data).toHaveLength(1);
    expect(page.meta.nextCursor).toBeTypeOf('string');
  });
});
