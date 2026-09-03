/**
 * Wallet integration tests (PLAN M2 AC 1-2, PLAN 5.1/5.6) against the docker `test` profile.
 * Skips when TEST_* are unset (fails under CI=true, see the harness).
 */
import { schema } from '@buddha/db';
import { CHARGE_MAX_P, CHARGE_MIN_P, type ChargeResult, type LedgerEntry } from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

const jsonHeaders = { origin: 'http://localhost:3000', 'content-type': 'application/json' };

describe.skipIf(!hasTestInfra)('wallet (integration)', () => {
  let t: TestApp;
  let user: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
    user = await signUpTestUser(t);
  });

  const charge = (amountP: string, cookie = user.cookie) =>
    t.app.inject({
      method: 'POST',
      url: '/api/v1/payments/charge',
      headers: { ...jsonHeaders, cookie },
      payload: { amountP },
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

  it('charges 10,000P: balance, one DEPOSIT entry and the payment row agree (AC 1)', async () => {
    const res = await charge('10000');
    expect(res.statusCode).toBe(200);
    const { data } = res.json<{ data: ChargeResult }>();
    expect(data.balance).toEqual({ availableP: '10000', lockedP: '0' });
    expect(data.payment).toMatchObject({ amountP: '10000', provider: 'mock', status: 'succeeded' });
    expect(data.ledgerEntry).toMatchObject({
      type: 'DEPOSIT',
      amountP: '10000',
      balanceAfterP: '10000',
      refType: 'payment',
      refId: data.payment.id,
    });

    expect(await balanceOf(user.id)).toMatchObject({ availableP: 10_000n, lockedP: 0n });
    const entries = await ledgerOf(user.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'DEPOSIT', amountP: 10_000n, balanceAfterP: 10_000n });

    const payments = await t.db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.userId, user.id));
    expect(payments).toHaveLength(1);
    expect(payments[0]?.providerRef).toMatch(/^mock_/);
  });

  it('20 concurrent charges add up, with one ledger entry each (AC 2)', async () => {
    const amounts = Array.from({ length: 20 }, (_, i) => BigInt((i + 1) * 1000));
    const responses = await Promise.all(amounts.map((amount) => charge(amount.toString())));
    expect(responses.map((res) => res.statusCode)).toEqual(Array.from({ length: 20 }, () => 200));

    const total = amounts.reduce((sum, amount) => sum + amount, 0n);
    expect(await balanceOf(user.id)).toMatchObject({ availableP: total });

    const entries = await ledgerOf(user.id);
    expect(entries).toHaveLength(20);
    expect(entries.reduce((sum, entry) => sum + entry.amountP, 0n)).toBe(total);
    // Every snapshot is distinct and the last one equals the final balance: the updates were
    // serialised by Postgres rather than overwriting each other.
    const snapshots = entries.map((entry) => entry.balanceAfterP).sort((a, b) => Number(a - b));
    expect(new Set(snapshots).size).toBe(20);
    expect(snapshots.at(-1)).toBe(total);
  });

  it('rejects amounts outside the charge bounds and non-integers', async () => {
    for (const amountP of [
      (CHARGE_MIN_P - 1n).toString(),
      (CHARGE_MAX_P + 1n).toString(),
      '0',
      '-5000',
      '1000.5',
    ]) {
      const res = await charge(amountP);
      expect(res.statusCode, amountP).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    }
    expect(await balanceOf(user.id)).toMatchObject({ availableP: 0n });
    expect(await ledgerOf(user.id)).toHaveLength(0);
  });

  it('requires a session', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/payments/charge',
      headers: jsonHeaders,
      payload: { amountP: '10000' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('GET /me/ledger pages newest first and only shows the caller entries', async () => {
    for (const amount of ['1000', '2000', '3000']) await charge(amount);
    const other = await signUpTestUser(t);
    await charge('9000', other.cookie);

    const first = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me/ledger?limit=2',
      headers: { cookie: user.cookie },
    });
    expect(first.statusCode).toBe(200);
    const firstPage = first.json<{ data: LedgerEntry[]; meta: { nextCursor: string | null } }>();
    expect(firstPage.data.map((entry) => entry.amountP)).toEqual(['3000', '2000']);
    expect(firstPage.meta.nextCursor).toBeTypeOf('string');

    const second = await t.app.inject({
      method: 'GET',
      url: `/api/v1/me/ledger?limit=2&cursor=${encodeURIComponent(firstPage.meta.nextCursor!)}`,
      headers: { cookie: user.cookie },
    });
    const secondPage = second.json<{ data: LedgerEntry[]; meta: { nextCursor: string | null } }>();
    expect(secondPage.data.map((entry) => entry.amountP)).toEqual(['1000']);
    expect(secondPage.meta.nextCursor).toBeNull();
  });

  it('GET /me/payments lists the caller charges', async () => {
    await charge('5000');
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me/payments',
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      data: [{ amountP: '5000', provider: 'mock', status: 'succeeded' }],
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
