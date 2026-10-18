/**
 * Paid Coin closed (#112, ADR-0049) against the docker `test` profile: the app as production
 * ships it refuses every route that sells Coin or hands it out for a code — the charge, its
 * catalogue, the provider info, coupon redemption — and the admin refund of an existing charge,
 * 404 NOT_FOUND naming no feature, signed in or not, and nothing about the balance or the
 * payments moves. What stays open is pinned too: the admin catalogue and coupon CRUD, the admin
 * payment list and the payer's own payment history. Skips when TEST_* are unset.
 */
import { randomUUID } from 'node:crypto';
import { schema } from '@buddha/db';
import { PAID_COIN_SALES_ENABLED } from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import {
  chargeBody,
  chargeHeaders,
  createTestApp,
  createTestPackage,
  signUpTestUser,
  type TestApp,
  type TestPackage,
  type TestUser,
} from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { MockPaymentProvider } from './mock-payment.provider.js';
import { PAID_COIN_SALES } from './paid-coin-sales.guard.js';

const jsonHeaders = { origin: 'http://localhost:3000', 'content-type': 'application/json' };

/** The whole answer to a closed route: no feature named, no details. */
const CLOSED = { error: { code: 'NOT_FOUND', message: 'Not available' } };

describe.skipIf(!hasTestInfra)('paid Coin closed (integration)', () => {
  let t: TestApp;
  let admin: TestUser;
  let member: TestUser;
  let pack: TestPackage;

  beforeAll(async () => {
    // No `paidCoinSales`: what production runs.
    t = await createTestApp();
  });
  afterAll(async () => {
    vi.restoreAllMocks();
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
    pack = await createTestPackage(t.db);
  });

  /** Everything a closed route could have moved for `member`. */
  async function moneyOf(userId: string) {
    const [balance] = await t.db
      .select({
        availableCoin: schema.balances.availableCoin,
        lockedCoin: schema.balances.lockedCoin,
      })
      .from(schema.balances)
      .where(eq(schema.balances.userId, userId));
    const ledger = await t.db
      .select({ type: schema.ledgerEntries.type, amountCoin: schema.ledgerEntries.amountCoin })
      .from(schema.ledgerEntries)
      .where(eq(schema.ledgerEntries.userId, userId));
    const payments = await t.db
      .select({ id: schema.payments.id, status: schema.payments.status })
      .from(schema.payments)
      .where(eq(schema.payments.userId, userId));
    const redemptions = await t.db
      .select({ couponId: schema.couponRedemptions.couponId })
      .from(schema.couponRedemptions)
      .where(eq(schema.couponRedemptions.userId, userId));
    return { balance, ledger, payments, redemptions };
  }

  it('ships closed', () => {
    expect(PAID_COIN_SALES_ENABLED).toBe(false);
    expect(t.app.get(PAID_COIN_SALES)).toBe(false);
  });

  it('serves no catalogue and no provider info, signed in or not', async () => {
    for (const url of ['/api/v1/charge-packages', '/api/v1/payments/provider']) {
      for (const cookie of [undefined, member.cookie]) {
        const res = await t.app.inject({
          method: 'GET',
          url,
          headers: cookie === undefined ? {} : { cookie },
        });
        const who = cookie === undefined ? 'anonymous' : 'member';
        expect({ url, who, status: res.statusCode }).toEqual({ url, who, status: 404 });
        expect(res.json()).toEqual(CLOSED);
        // Nothing of the offer leaks through the refusal.
        expect(res.body).not.toContain(String(pack.priceKrw));
      }
    }
  });

  it('refuses a charge before anything, signed in or not, and credits nothing', async () => {
    const before = await moneyOf(member.id);
    expect(before.balance).toEqual({ availableCoin: 0n, lockedCoin: 0n });
    const charge = vi.spyOn(t.app.get(MockPaymentProvider), 'charge');

    const requests = [
      // Anonymous, with a body that would buy.
      {
        headers: { ...jsonHeaders, 'idempotency-key': randomUUID() },
        payload: chargeBody(pack, member.id),
      },
      // Signed in, the request the wallet would send.
      { headers: chargeHeaders(member.cookie), payload: chargeBody(pack, member.id) },
      // Signed in, with no key and no body: refused as closed, not as malformed.
      { headers: { ...jsonHeaders, cookie: member.cookie }, payload: {} },
    ];
    for (const [i, request] of requests.entries()) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/v1/payments/charge',
        ...request,
      });
      expect([i, res.statusCode]).toEqual([i, 404]);
      expect(res.json()).toEqual(CLOSED);
    }

    expect(charge).not.toHaveBeenCalled();
    charge.mockRestore();
    expect(await moneyOf(member.id)).toEqual(before);
    expect(await t.db.select().from(schema.payments)).toHaveLength(0);
  });

  it('refuses a coupon, signed in or not, and hands out nothing', async () => {
    // Issuing stays open to admins (owner decision: only the menu is hidden).
    const issued = await t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/coupons',
      headers: { ...jsonHeaders, cookie: admin.cookie },
      payload: { code: 'WELCOME-2026', amountCoin: '3000' },
    });
    expect(issued.statusCode).toBe(201);
    const before = await moneyOf(member.id);

    for (const cookie of [undefined, member.cookie]) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/v1/coupons/redeem',
        headers: cookie === undefined ? jsonHeaders : { ...jsonHeaders, cookie },
        payload: { code: 'WELCOME-2026', expectedAccountId: member.id },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual(CLOSED);
    }

    expect(await moneyOf(member.id)).toEqual(before);
    expect(await t.db.select().from(schema.couponRedemptions)).toHaveLength(0);
  });

  it('refuses the admin refund of an existing charge, and moves nothing', async () => {
    // A charge from before the close: written directly, as the charge route is shut.
    const [payment] = await t.db
      .insert(schema.payments)
      .values({
        userId: member.id,
        amountCoin: pack.amountCoin,
        priceKrw: pack.priceKrw,
        packageId: pack.id,
        provider: 'mock',
        providerRef: `mock_${randomUUID()}`,
        status: 'succeeded',
        approvedAt: new Date(),
        idempotencyKey: randomUUID(),
      })
      .returning();
    const before = await moneyOf(member.id);
    const cancel = vi.spyOn(t.app.get(MockPaymentProvider), 'cancel');
    const refund = (cookie?: string) =>
      t.app.inject({
        method: 'POST',
        url: `/api/v1/admin/payments/${payment!.id}/refund`,
        headers: cookie === undefined ? jsonHeaders : { ...jsonHeaders, cookie },
        payload: { reason: '청약철회' },
      });

    // Admin routes check the session and the role first, as everywhere under /admin.
    expect((await refund()).statusCode).toBe(401);
    expect((await refund(member.cookie)).statusCode).toBe(403);
    const res = await refund(admin.cookie);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(CLOSED);

    expect(cancel).not.toHaveBeenCalled();
    cancel.mockRestore();
    expect(await moneyOf(member.id)).toEqual(before);
    expect(await t.db.select().from(schema.paymentEvents)).toHaveLength(0);
    expect(await t.db.select().from(schema.adminActions)).toHaveLength(0);
  });

  it('keeps the admin catalogue, coupons and payment list, and the payer history, open', async () => {
    const asAdmin = { ...jsonHeaders, cookie: admin.cookie };
    const created = await t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/charge-packages',
      headers: asAdmin,
      payload: { amountCoin: '5000', priceKrw: 4900 },
    });
    expect(created.statusCode).toBe(201);
    for (const url of [
      '/api/v1/admin/charge-packages',
      '/api/v1/admin/coupons',
      '/api/v1/admin/payments',
    ]) {
      const res = await t.app.inject({ method: 'GET', url, headers: { cookie: admin.cookie } });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 200 });
    }
    for (const url of ['/api/v1/me/payments', '/api/v1/me/ledger']) {
      const res = await t.app.inject({ method: 'GET', url, headers: { cookie: member.cookie } });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 200 });
    }
  });
});
