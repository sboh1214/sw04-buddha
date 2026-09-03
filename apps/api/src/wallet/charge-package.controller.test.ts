/**
 * Admin CRUD for the charge catalogue (ADR-0026). Runs against the docker `test` profile;
 * skips when TEST_* are unset.
 */
import { schema } from '@buddha/db';
import { discountPercent, type ChargePackage } from '@buddha/shared';
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

describe.skipIf(!hasTestInfra)('admin charge packages (integration)', () => {
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
      headers: { ...jsonHeaders, cookie: member.cookie },
      payload: { packageId: pack.id },
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
