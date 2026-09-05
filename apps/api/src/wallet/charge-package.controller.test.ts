/**
 * Admin CRUD for the charge catalogue (ADR-0026). Runs against the docker `test` profile;
 * skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import { SIGNUP_BONUS_P, discountPercent, type ChargePackage } from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from '../payments/payment-provider.js';
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

describe.skipIf(!hasTestInfra)('admin charge packages (integration)', () => {
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
    await t.app.get(AdminGuard).invalidate(admin.id);
  });

  const create = (payload: Record<string, unknown>, cookie = admin.cookie) =>
    t.app.inject({
      method: 'POST',
      url: '/api/v1/admin/charge-packages',
      headers: { ...jsonHeaders, cookie },
      payload,
    });

  it('creates a package whose price is below face value (the discount)', async () => {
    const res = await create({ amountP: '5000', priceKrw: 4900, sortOrder: 10 });
    expect(res.statusCode).toBe(201);
    const created = res.json<{ data: ChargePackage }>().data;
    expect(created).toMatchObject({ amountP: '5000', priceKrw: 4900, isActive: true });
    expect(discountPercent(BigInt(created.amountP), created.priceKrw)).toBe(2);
  });

  it('refuses a price above face value: P is never sold above 1P = 1원', async () => {
    const res = await create({ amountP: '5000', priceKrw: 5001 });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(await t.db.select().from(schema.chargePackages)).toHaveLength(0);
  });

  it('edits a package, including retiring and reviving it', async () => {
    const pack = await createTestPackage(t.db, { amountP: 10_000n, priceKrw: 9_700 });

    const patched = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/charge-packages/${pack.id}`,
      headers: { ...jsonHeaders, cookie: admin.cookie },
      payload: { priceKrw: 9_000, sortOrder: 5 },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json<{ data: ChargePackage }>().data).toMatchObject({
      priceKrw: 9_000,
      sortOrder: 5,
      amountP: '10000',
    });

    const retired = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/charge-packages/${pack.id}`,
      headers: { ...jsonHeaders, cookie: admin.cookie },
      payload: { isActive: false },
    });
    expect(retired.json<{ data: ChargePackage }>().data.isActive).toBe(false);

    const publicList = await t.app.inject({ method: 'GET', url: '/api/v1/charge-packages' });
    expect(publicList.json<{ data: ChargePackage[] }>().data).toHaveLength(0);

    const adminList = await t.app.inject({
      method: 'GET',
      url: '/api/v1/admin/charge-packages',
      headers: { cookie: admin.cookie },
    });
    expect(adminList.json<{ data: ChargePackage[] }>().data).toHaveLength(1);
  });

  it('refuses a patch that would push the price above the amount', async () => {
    const pack = await createTestPackage(t.db, { amountP: 10_000n, priceKrw: 9_700 });
    const res = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/charge-packages/${pack.id}`,
      headers: { ...jsonHeaders, cookie: admin.cookie },
      payload: { priceKrw: 10_001 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('deletes a package while past payments keep their amount and price', async () => {
    const pack = await createTestPackage(t.db);
    await t.app.inject({
      method: 'POST',
      url: '/api/v1/payments/charge',
      headers: chargeHeaders(member.cookie),
      payload: chargeBody(pack),
    });

    const deleted = await t.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/charge-packages/${pack.id}`,
      headers: { cookie: admin.cookie },
    });
    expect(deleted.statusCode).toBe(204);
    expect(await t.db.select().from(schema.chargePackages)).toHaveLength(0);

    const [payment] = await t.db.select().from(schema.payments);
    expect(payment).toMatchObject({ amountP: 10_000n, priceKrw: 9_700, packageId: null });

    const missing = await t.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/charge-packages/${pack.id}`,
      headers: { cookie: admin.cookie },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('records who created, edited and deleted a package in admin_actions', async () => {
    // ADMIN_ACTION_TYPES declares charge_package_create/update/delete; a hard-deleted package
    // leaves the audit payload as the only record of the price it carried.
    const created = await create({ amountP: '20000', priceKrw: 19_000 });
    expect(created.statusCode).toBe(201);
    const pack = created.json<{ data: ChargePackage }>().data;

    const patched = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/charge-packages/${pack.id}`,
      headers: { ...jsonHeaders, cookie: admin.cookie },
      payload: { priceKrw: 18_000 },
    });
    expect(patched.statusCode).toBe(200);

    const removed = await t.app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/charge-packages/${pack.id}`,
      headers: { cookie: admin.cookie },
    });
    expect(removed.statusCode).toBe(204);

    const actions = await t.db
      .select()
      .from(schema.adminActions)
      .orderBy(schema.adminActions.createdAt, schema.adminActions.id);
    expect(actions.map((row) => row.type)).toEqual([
      'charge_package_create',
      'charge_package_update',
      'charge_package_delete',
    ]);
    expect(actions.every((row) => row.adminId === admin.id)).toBe(true);
    expect(actions.every((row) => row.targetType === 'charge_package')).toBe(true);
    expect(actions.every((row) => row.targetId === pack.id)).toBe(true);
    expect(actions[1]?.payload).toMatchObject({
      before: { priceKrw: 19_000 },
      after: { priceKrw: 18_000 },
    });
    // The row is gone, so this payload is the only surviving copy of its amount and price.
    expect(actions[2]?.payload).toMatchObject({ amountP: '20000', priceKrw: 18_000 });
  });

  it('writes no audit row when the patch is refused', async () => {
    const pack = await createTestPackage(t.db, { amountP: 10_000n, priceKrw: 9_700 });
    const refused = await t.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/charge-packages/${pack.id}`,
      headers: { ...jsonHeaders, cookie: admin.cookie },
      payload: { priceKrw: 20_000 }, // above the face value the row still holds
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    // The whole update is one transaction, so a refusal leaves neither a change nor a trace.
    expect(await t.db.select().from(schema.adminActions)).toHaveLength(0);
    const [row] = await t.db.select().from(schema.chargePackages);
    expect(row).toMatchObject({ priceKrw: 9_700 });
  });

  it('survives a package deleted after the provider accepted the charge', async () => {
    // The window the FK used to break in: `charge` read the package, the provider accepted,
    // and only then was the payment inserted. ON DELETE SET NULL governs rows that already
    // exist, not an INSERT naming a parent that is gone — that is a 23503, which the exception
    // filter can only render as a 500, after the user has been charged. The payment row is
    // now reserved before the provider runs (PLAN 5.4), so a package deleted during the call
    // is the SET NULL case proper; deleting from inside the provider call still exercises the
    // whole path deterministically.
    const pack = await createTestPackage(t.db, { amountP: 10_000n, priceKrw: 9_700 });
    const provider = t.app.get<PaymentProvider>(PAYMENT_PROVIDER);
    const spy = vi.spyOn(provider, 'charge').mockImplementation(async (request) => {
      await t.db.delete(schema.chargePackages).where(eq(schema.chargePackages.id, pack.id));
      return { status: 'succeeded', providerRef: `mock_${request.paymentId}` };
    });

    try {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/v1/payments/charge',
        headers: chargeHeaders(member.cookie),
        payload: chargeBody(pack),
      });
      expect(res.statusCode).toBe(200);

      // The payment keeps its own amount and price; only the back-reference is lost, which is
      // exactly the state ON DELETE SET NULL would have left a moment later (ADR-0026).
      const [payment] = await t.db.select().from(schema.payments);
      expect(payment).toMatchObject({
        amountP: 10_000n,
        priceKrw: 9_700,
        packageId: null,
        status: 'succeeded',
      });
      // And the P actually landed: the FK failure used to roll the whole transaction back.
      const [balance] = await t.db
        .select()
        .from(schema.balances)
        .where(eq(schema.balances.userId, member.id));
      expect(balance?.availableP).toBe(SIGNUP_BONUS_P + 10_000n);
    } finally {
      spy.mockRestore();
    }
  });

  it('does not let a concurrent isActive patch revert a price change', async () => {
    // update() reads the row to supply the half of the amount/price pair a PATCH omitted, then
    // writes both back — a read-modify-write, and `charge` snapshots the price it leaves onto
    // the payment. Holding the row from another transaction makes the interleaving
    // deterministic: without `FOR UPDATE` the read returns the pre-commit price and writes it
    // straight back, erasing the other admin's change; with it, the read waits and sees 8,000.
    const pack = await createTestPackage(t.db, { amountP: 10_000n, priceKrw: 9_700 });

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = t.db.transaction(async (tx) => {
      await tx
        .update(schema.chargePackages)
        .set({ priceKrw: 8_000 })
        .where(eq(schema.chargePackages.id, pack.id));
      await held;
    });

    const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
    await settle(); // let the holder take the row lock
    const patched = t.app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/charge-packages/${pack.id}`,
      headers: { ...jsonHeaders, cookie: admin.cookie },
      payload: { isActive: false },
    });
    await settle(); // and let the patch reach its read
    release();
    await holder;

    expect((await patched).statusCode).toBe(200);
    const [row] = await t.db.select().from(schema.chargePackages);
    expect(row).toMatchObject({ priceKrw: 8_000, isActive: false, amountP: 10_000n });
  });

  it('is closed to members', async () => {
    expect((await create({ amountP: '5000', priceKrw: 4900 }, member.cookie)).statusCode).toBe(403);
    const list = await t.app.inject({
      method: 'GET',
      url: '/api/v1/admin/charge-packages',
      headers: { cookie: member.cookie },
    });
    expect(list.statusCode).toBe(403);
  });
});
