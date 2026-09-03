/**
 * Wallet integration tests (PLAN M2 AC 1-2, PLAN 5.1/5.6, ADR-0026) against the docker `test`
 * profile. Skips when TEST_* are unset (fails under CI=true, see the harness).
 */
import { schema } from '@buddha/db';
import {
  SIGNUP_BONUS_P,
  type ChargePackage,
  type ChargeResult,
  type LedgerEntry,
} from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestApp,
  createTestPackage,
  signUpTestUser,
  type TestApp,
  type TestUser,
} from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

const jsonHeaders = { origin: 'http://localhost:3000', 'content-type': 'application/json' };

describe.skipIf(!hasTestInfra)('wallet (integration)', () => {
  let t: TestApp;
  let user: TestUser;
  /** 10,000P for 9,700원 (a 3% discount), like the seeded ladder. */
  let pack: { id: string; amountP: bigint; priceKrw: number };

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    user = await signUpTestUser(t);
    pack = await createTestPackage(t.db);
  });

  const charge = (packageId: string, cookie = user.cookie) =>
    t.app.inject({
      method: 'POST',
      url: '/api/v1/payments/charge',
      headers: { ...jsonHeaders, cookie },
      payload: { packageId },
    });

  async function balanceOf(userId: string) {
    const [row] = await t.db
      .select()
      .from(schema.balances)
      .where(eq(schema.balances.userId, userId));
    return row;
  }

  async function ledgerOf(userId: string) {
    return t.db.select().from(schema.ledgerEntries).where(eq(schema.ledgerEntries.userId, userId));
  }

  it('grants the sign-up bonus with a BONUS ledger entry (PLAN 17 Q2)', async () => {
    expect(await balanceOf(user.id)).toMatchObject({ availableP: SIGNUP_BONUS_P, lockedP: 0n });
    const entries = await ledgerOf(user.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      type: 'BONUS',
      amountP: SIGNUP_BONUS_P,
      balanceAfterP: SIGNUP_BONUS_P,
      memo: '가입 보너스',
    });
  });

  it('lists the packages on sale, hiding the retired ones', async () => {
    const retired = await createTestPackage(t.db, {
      amountP: 1_000n,
      priceKrw: 1_000,
      isActive: false,
    });
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/charge-packages' });
    expect(res.statusCode).toBe(200);
    const packages = res.json<{ data: ChargePackage[] }>().data;
    expect(packages.map((row) => row.id)).toEqual([pack.id]);
    expect(packages.map((row) => row.id)).not.toContain(retired.id);
    expect(packages[0]).toMatchObject({ amountP: '10000', priceKrw: 9700, isActive: true });
  });

  it('charges a package: P credited, KRW price recorded, one DEPOSIT entry (AC 1)', async () => {
    const res = await charge(pack.id);
    expect(res.statusCode).toBe(200);
    const { data } = res.json<{ data: ChargeResult }>();
    const expected = SIGNUP_BONUS_P + pack.amountP;
    expect(data.balance).toEqual({ availableP: expected.toString(), lockedP: '0' });
    expect(data.payment).toMatchObject({
      amountP: '10000',
      priceKrw: 9700,
      packageId: pack.id,
      provider: 'mock',
      status: 'succeeded',
    });
    expect(data.package).toMatchObject({ id: pack.id, amountP: '10000', priceKrw: 9700 });
    expect(data.ledgerEntry).toMatchObject({
      type: 'DEPOSIT',
      amountP: '10000',
      balanceAfterP: expected.toString(),
      refType: 'payment',
      refId: data.payment.id,
    });

    expect(await balanceOf(user.id)).toMatchObject({ availableP: expected });
    const deposits = (await ledgerOf(user.id)).filter((entry) => entry.type === 'DEPOSIT');
    expect(deposits).toHaveLength(1);
  });

  it('20 concurrent charges add up, with one ledger entry each (AC 2)', async () => {
    const responses = await Promise.all(Array.from({ length: 20 }, () => charge(pack.id)));
    expect(responses.map((res) => res.statusCode)).toEqual(Array.from({ length: 20 }, () => 200));

    const total = SIGNUP_BONUS_P + pack.amountP * 20n;
    expect(await balanceOf(user.id)).toMatchObject({ availableP: total });

    const deposits = (await ledgerOf(user.id)).filter((entry) => entry.type === 'DEPOSIT');
    expect(deposits).toHaveLength(20);
    expect(deposits.reduce((sum, entry) => sum + entry.amountP, 0n)).toBe(pack.amountP * 20n);
    // Every snapshot is distinct and the last one equals the final balance: the updates were
    // serialised by Postgres rather than overwriting each other.
    const snapshots = deposits.map((entry) => entry.balanceAfterP).sort((a, b) => Number(a - b));
    expect(new Set(snapshots).size).toBe(20);
    expect(snapshots.at(-1)).toBe(total);
  });

  it('refuses an unknown, retired or malformed package', async () => {
    const retired = await createTestPackage(t.db, { isActive: false });
    const unknown = await charge('3f1a5b6c-1111-4222-8333-444455556666');
    expect(unknown.statusCode).toBe(404);

    const inactive = await charge(retired.id);
    expect(inactive.statusCode).toBe(400);
    expect(inactive.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const malformed = await t.app.inject({
      method: 'POST',
      url: '/api/v1/payments/charge',
      headers: { ...jsonHeaders, cookie: user.cookie },
      payload: { amountP: '10000' },
    });
    expect(malformed.statusCode).toBe(400);

    expect(await balanceOf(user.id)).toMatchObject({ availableP: SIGNUP_BONUS_P });
  });

  it('requires a session', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/payments/charge',
      headers: jsonHeaders,
      payload: { packageId: pack.id },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('GET /me/ledger pages newest first and only shows the caller entries', async () => {
    await charge(pack.id);
    await charge(pack.id);
    const other = await signUpTestUser(t);
    await charge(pack.id, other.cookie);

    const first = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me/ledger?limit=2',
      headers: { cookie: user.cookie },
    });
    expect(first.statusCode).toBe(200);
    const firstPage = first.json<{ data: LedgerEntry[]; meta: { nextCursor: string | null } }>();
    expect(firstPage.data.map((entry) => entry.type)).toEqual(['DEPOSIT', 'DEPOSIT']);
    expect(firstPage.meta.nextCursor).toBeTypeOf('string');

    const second = await t.app.inject({
      method: 'GET',
      url: `/api/v1/me/ledger?limit=2&cursor=${encodeURIComponent(firstPage.meta.nextCursor!)}`,
      headers: { cookie: user.cookie },
    });
    const secondPage = second.json<{ data: LedgerEntry[]; meta: { nextCursor: string | null } }>();
    // The sign-up bonus is the oldest entry of every account.
    expect(secondPage.data.map((entry) => entry.type)).toEqual(['BONUS']);
    expect(secondPage.meta.nextCursor).toBeNull();
  });

  it('GET /me/payments lists the caller charges with the price paid', async () => {
    await charge(pack.id);
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me/payments',
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      data: [{ amountP: '10000', priceKrw: 9700, provider: 'mock', status: 'succeeded' }],
      meta: { nextCursor: null },
    });
  });

  it('rejects a cursor limit above the maximum', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me/ledger?limit=101',
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });
});
