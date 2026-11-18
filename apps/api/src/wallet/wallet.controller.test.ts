/**
 * Wallet integration tests (PLAN M2 AC 1-2, PLAN 5.1/5.6, ADR-0026) against the docker `test`
 * profile. The charge, its catalogue and the provider info are preserved code, closed in
 * production while paid Coin is off (ADR-0049; paid-coin-sales.test.ts), so this app opens them.
 * Skips when TEST_* are unset (fails under CI=true, see the harness).
 */
import { ledgerKeys, recordLedgerEntry, schema, settleMarketPositions } from '@buddha/db';
import {
  createFillRecord,
  createMarket,
  createStartGrant,
  fundMarketMakerFunds,
  ledgerOf as accountLedgerOf,
  mintTestPairs,
  withLedgerGuardsOff,
} from '@buddha/db/test';
import {
  LEDGER_FILTER_EXCLUDED,
  LEDGER_FILTER_KINDS,
  ledgerEntrySchema,
  userChannel,
  type ChargePackage,
  type ChargeResult,
  type LedgerEntry,
  type LedgerEntryKind,
  type Payment,
} from '@buddha/shared';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PAYMENT_PROVIDER, type PaymentProvider } from '../payments/payment-provider.js';
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
import { expectLedgerChain } from '../test/ledger.js';
import { hasTestInfra } from '../test/setup-env.js';
import { waitForLockWaiter, waitForMessages } from '../test/wait.js';

const jsonHeaders = { origin: 'http://localhost:3000', 'content-type': 'application/json' };

/**
 * Every field of a ledger entry (#69, ADR-0144): no stored type, no counterparty account, order
 * or account type.
 */
const LEDGER_ENTRY_FIELDS = [
  'amountCoin',
  'balanceAfterCoin',
  'correctionEffect',
  'createdAt',
  'id',
  'kind',
  'marketId',
  'marketSlug',
  'marketTitle',
  'memo',
  'orderId',
  'refId',
  'refType',
];

describe.skipIf(!hasTestInfra)('wallet (integration)', () => {
  let t: TestApp;
  let user: TestUser;
  /** 10,000 Coin for 9,700원 (a 3% discount), like the seeded ladder. */
  let pack: { id: string; amountCoin: bigint; priceKrw: number };

  beforeAll(async () => {
    // PLAN M2 AC 2 proves the charge transaction with twenty concurrent charges by one
    // account, which is above PLAN 7.5's own 10/min/user ceiling for the same route. The
    // shipped limit is pinned by rate-limit.controller.test.ts; this suite is about the
    // transaction, so it raises the ceiling out of the way instead of thinning the AC.
    t = await createTestApp({ paidCoinSales: true, rateLimits: { charge: 500 } });
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    user = await signUpTestUser(t);
    pack = await createTestPackage(t.db);
  });

  /**
   * One purchase by `as` (cookie and the account the screen shows): a fresh Idempotency-Key
   * unless the test re-sends one (PLAN 5.4).
   */
  const charge = (pack: TestPackage, as: TestUser = user, idempotencyKey?: string) =>
    t.app.inject({
      method: 'POST',
      url: '/api/v1/payments/charge',
      headers: chargeHeaders(as.cookie, idempotencyKey),
      payload: chargeBody(pack, as.id),
    });

  async function paymentsOf(userId: string) {
    return t.db.select().from(schema.payments).where(eq(schema.payments.userId, userId));
  }

  async function balanceOf(userId: string) {
    const [row] = await t.db
      .select()
      .from(schema.balances)
      .where(eq(schema.balances.userId, userId));
    return row;
  }

  /** Deletes a person's balance row, as only a broken database lacks it (no app role may). */
  const deleteBalanceRow = (userId: string) =>
    withLedgerGuardsOff((client) =>
      client.query('DELETE FROM balances WHERE user_id = $1', [userId]),
    );

  /** The account's ledger, each event from its side (`ledgerOf` of @buddha/db/test, #116). */
  const ledgerOf = (userId: string) => accountLedgerOf(t.db, userId);

  it('starts a new account at 0 with no ledger entry: signing up grants nothing (#70)', async () => {
    // The start Coin comes from the start grant once the onboarding is done (ADR-0071).
    expect(await balanceOf(user.id)).toMatchObject({ availableCoin: 0n, lockedCoin: 0n });
    expect(await ledgerOf(user.id)).toEqual([]);
  });

  it('lists the packages on sale, hiding the retired ones', async () => {
    const retired = await createTestPackage(t.db, {
      amountCoin: 1_000n,
      priceKrw: 1_000,
      isActive: false,
    });
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/charge-packages' });
    expect(res.statusCode).toBe(200);
    const packages = res.json<{ data: ChargePackage[] }>().data;
    expect(packages.map((row) => row.id)).toEqual([pack.id]);
    expect(packages.map((row) => row.id)).not.toContain(retired.id);
    expect(packages[0]).toMatchObject({ amountCoin: '10000', priceKrw: 9700, isActive: true });
  });

  it('charges a package: Coin credited, KRW price recorded, one DEPOSIT entry (AC 1)', async () => {
    const res = await charge(pack);
    expect(res.statusCode).toBe(200);
    const { data } = res.json<{ data: ChargeResult }>();
    const expected = pack.amountCoin;
    expect(data.balance).toEqual({ availableCoin: expected.toString(), lockedCoin: '0' });
    expect(data.payment).toMatchObject({
      amountCoin: '10000',
      priceKrw: 9700,
      packageId: pack.id,
      provider: 'mock',
      status: 'succeeded',
    });
    // ADR-0042 fields: a mock charge has no PG method or message, is approved at the instant it
    // is credited (the DEPOSIT's own clock, after the balance lock) and is not refunded.
    expect(data.payment).toMatchObject({
      method: null,
      refundedAt: null,
      resultMessage: null,
      approvedAt: data.ledgerEntry.createdAt,
    });
    // The kept answer carries the wallet's entry (#69): its kind, and no link — a payment has no
    // market, order or correction.
    expect(data.ledgerEntry).toMatchObject({
      kind: 'DEPOSIT',
      amountCoin: '10000',
      balanceAfterCoin: expected.toString(),
      refType: 'payment',
      refId: data.payment.id,
      memo: null,
      marketId: null,
      marketSlug: null,
      marketTitle: null,
      orderId: null,
      correctionEffect: null,
    });
    expect(data.ledgerEntry).not.toHaveProperty('type');

    expect(await balanceOf(user.id)).toMatchObject({ availableCoin: expected });
    const deposits = (await ledgerOf(user.id)).filter((entry) => entry.type === 'DEPOSIT');
    expect(deposits).toHaveLength(1);
    // A kept type on the ledger accounts (#116, ADR-0107 결정 2 #73 2항): a mint into the
    // account, keyed by the payment.
    const [stored] = await t.db.select().from(schema.ledgerEntries);
    expect(stored).toMatchObject({
      type: 'DEPOSIT',
      fromAccountId: null,
      idempotencyKey: data.payment.id,
    });
  });

  it('20 concurrent charges add up, with one ledger entry each (AC 2)', async () => {
    const responses = await Promise.all(Array.from({ length: 20 }, () => charge(pack)));
    expect(responses.map((res) => res.statusCode)).toEqual(Array.from({ length: 20 }, () => 200));

    const total = pack.amountCoin * 20n;
    expect(await balanceOf(user.id)).toMatchObject({ availableCoin: total });

    const deposits = (await ledgerOf(user.id)).filter((entry) => entry.type === 'DEPOSIT');
    expect(deposits).toHaveLength(20);
    expect(deposits.reduce((sum, entry) => sum + entry.amountCoin, 0n)).toBe(pack.amountCoin * 20n);
    // Every snapshot is distinct and the last one equals the final balance: the updates were
    // serialised by Postgres rather than overwriting each other.
    const snapshots = deposits.map((entry) => entry.balanceAfterCoin).sort((a, b) => Number(a - b));
    expect(new Set(snapshots).size).toBe(20);
    expect(snapshots.at(-1)).toBe(total);
    // And `/me/ledger`'s (created_at, id) order is the order they committed in: 20 waiters on
    // one balance row is exactly where a transaction-start stamp puts the chain out of order.
    expectLedgerChain(await ledgerOf(user.id), total);
  });

  it('stamps the DEPOSIT after the balance lock, not at transaction start (A-M3-14)', async () => {
    // The credit transaction begins, then waits on the balance row this connection holds.
    // Anything that committed against this account meanwhile is already in its
    // total after, so its ledger row must sort after it — the column default `now()` is
    // the transaction start and sorted before it.
    const holder = await t.db.$client.connect();
    let pending: ReturnType<typeof charge> | undefined;
    let released = false;
    let releasedMs!: number;
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT user_id FROM balances WHERE user_id = '${user.id}' FOR UPDATE`);
      pending = charge(pack);
      await waitForLockWaiter(holder, 'the charge on the balance row');
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

    const ledger = await ledgerOf(user.id);
    const deposit = ledger.find((entry) => entry.type === 'DEPOSIT')!;
    expect(deposit.createdAt.getTime()).toBeGreaterThanOrEqual(releasedMs);
    expect((await balanceOf(user.id))!.updatedAt.getTime()).toBe(deposit.createdAt.getTime());
    expectLedgerChain(ledger, pack.amountCoin);
  });

  it('refuses an unknown, retired or malformed package', async () => {
    const retired = await createTestPackage(t.db, { isActive: false });
    const unknown = await charge({ ...pack, id: '3f1a5b6c-1111-4222-8333-444455556666' });
    expect(unknown.statusCode).toBe(404);
    // Names the field: the web refetches the catalogue for this 404 and not for the one a
    // broken account gets (next test), which is not about the catalogue.
    expect(unknown.json()).toMatchObject({
      error: { code: 'NOT_FOUND', details: [{ path: ['packageId'] }] },
    });

    const inactive = await charge(retired);
    expect(inactive.statusCode).toBe(400);
    expect(inactive.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const malformed = await t.app.inject({
      method: 'POST',
      url: '/api/v1/payments/charge',
      headers: chargeHeaders(user.cookie),
      payload: { amountCoin: '10000' },
    });
    expect(malformed.statusCode).toBe(400);

    expect(await balanceOf(user.id)).toMatchObject({ availableCoin: 0n });
  });

  it('refuses an account with no balance row before the provider runs (404, no field)', async () => {
    // The "user" trigger creates the row at sign-up, and since migration 0060 buddha_app may not
    // delete it (#116): only a broken database (an owner's hand, a restored dump) lacks it, and
    // ledger.audit reports such an account as `balanceMissing` — the test breaks it the one way
    // a test may (`withLedgerGuardsOff`). This 404 is not the catalogue's fault, so it must
    // not carry the `packageId` detail that makes the web refetch the cards and call the
    // package unavailable; the card the user clicked is still on sale. And it has to come
    // before the reservation and the provider: found out afterwards, the account would have
    // been charged with nothing credited, and the web — which spends its key on a 4xx — would
    // charge it again on every click.
    await deleteBalanceRow(user.id);
    const provider = t.app.get<PaymentProvider>(PAYMENT_PROVIDER);
    const spy = vi.spyOn(provider, 'charge');
    try {
      const res = await charge(pack);
      expect(res.statusCode).toBe(404);
      const body = res.json<{ error: { code: string; details?: unknown } }>();
      expect(body.error.code).toBe('NOT_FOUND');
      expect(body.error.details).toBeUndefined();
      expect(spy).not.toHaveBeenCalled();
      // Nothing of the attempt is left: no reservation, no credit, no ledger entry.
      expect(await t.db.select().from(schema.payments)).toHaveLength(0);
      expect(await ledgerOf(user.id)).toHaveLength(0); // signing up writes no entry (#70)
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses a purchase of terms the catalogue never showed (PRICE_MOVED)', async () => {
    // An admin may re-price a live package (ADR-0026) while a catalogue is still on screen,
    // and `useChargePackages` has no refetch interval — so the body echoes what the card said
    // and the server sells only that offer. Both halves are guarded: raising the price alone
    // is adverse to the user, raising the Coin alone is adverse to the house.
    for (const stale of [
      { ...chargeBody(pack, user.id), expectedPriceKrw: pack.priceKrw - 100 },
      { ...chargeBody(pack, user.id), expectedAmountCoin: (pack.amountCoin + 1n).toString() },
    ]) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/v1/payments/charge',
        headers: chargeHeaders(user.cookie),
        payload: stale,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: { code: 'PRICE_MOVED' } });
    }

    // Refused before the provider runs, so nothing is credited and no payment row is left.
    expect(await balanceOf(user.id)).toMatchObject({ availableCoin: 0n });
    expect(await t.db.select().from(schema.payments)).toHaveLength(0);
  });

  it('refuses a body that names another account than the cookie holds (FORBIDDEN)', async () => {
    // A tab whose session was switched in another tab keeps showing the old account until it
    // refetches (sign-ins are not broadcast), so its click would charge whoever the cookie now
    // belongs to and file the client's key under the account on screen. Refused before the
    // replay lookup and the reservation: nothing charged, nothing reserved.
    const other = await signUpTestUser(t);
    const provider = t.app.get<PaymentProvider>(PAYMENT_PROVIDER);
    const spy = vi.spyOn(provider, 'charge');
    try {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/v1/payments/charge',
        headers: chargeHeaders(user.cookie),
        payload: chargeBody(pack, other.id),
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({
        error: { code: 'FORBIDDEN', details: [{ path: ['expectedAccountId'] }] },
      });
      expect(spy).not.toHaveBeenCalled();
      expect(await t.db.select().from(schema.payments)).toHaveLength(0);
      expect(await balanceOf(user.id)).toMatchObject({ availableCoin: 0n });
      expect(await balanceOf(other.id)).toMatchObject({ availableCoin: 0n });
    } finally {
      spy.mockRestore();
    }
  });

  it('requires a session', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/payments/charge',
      headers: { ...jsonHeaders, 'idempotency-key': randomUUID() },
      payload: chargeBody(pack, user.id),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'UNAUTHENTICATED' } });
  });

  it('replays a charge whose answer was lost instead of selling it twice (PLAN 5.4)', async () => {
    // The client re-sends the same Idempotency-Key when a request never came back. Before the
    // key existed every request minted its own payment id, so the "retry" was a second
    // purchase: two payments, two DEPOSIT entries, Coin credited twice.
    const key = randomUUID();
    const first = await charge(pack, user, key);
    expect(first.statusCode).toBe(200);
    const again = await charge(pack, user, key);
    expect(again.statusCode).toBe(200);

    const a = first.json<{ data: ChargeResult }>().data;
    const b = again.json<{ data: ChargeResult }>().data;
    expect(b.payment.id).toBe(a.payment.id);
    expect(b.ledgerEntry.id).toBe(a.ledgerEntry.id);
    expect(b.balance).toEqual(a.balance);

    const expected = pack.amountCoin;
    expect(await balanceOf(user.id)).toMatchObject({ availableCoin: expected });
    expect(await paymentsOf(user.id)).toHaveLength(1);
    expect((await ledgerOf(user.id)).filter((entry) => entry.type === 'DEPOSIT')).toHaveLength(1);
  });

  it('replays a charge sent with an upper-case package id (the row keeps it lower-case)', async () => {
    // z.uuid() takes either case; the replay compares the body's id with the payment row's,
    // which Postgres returns lower-case — kept as sent, the same purchase would be a 409.
    const key = randomUUID();
    const shouted = { ...pack, id: pack.id.toUpperCase() };
    const first = await charge(shouted, user, key);
    expect(first.statusCode).toBe(200);
    const a = first.json<{ data: ChargeResult }>().data;
    expect(a.payment.packageId).toBe(pack.id);

    const again = await charge(shouted, user, key);
    expect(again.statusCode).toBe(200);
    expect(again.json<{ data: ChargeResult }>().data.payment.id).toBe(a.payment.id);
    expect(await paymentsOf(user.id)).toHaveLength(1);
  });

  it('replays the terms actually bought after an admin re-priced the package', async () => {
    // The answer is rebuilt from the payment row, never from the catalogue: an admin may edit
    // a live package between the lost answer and the retry (ADR-0026), and a client that still
    // holds the old card sends the old terms, which are exactly what it paid.
    const key = randomUUID();
    const first = await charge(pack, user, key);
    expect(first.statusCode).toBe(200);
    await t.db
      .update(schema.chargePackages)
      .set({ amountCoin: 12_000n, priceKrw: 9_900 })
      .where(eq(schema.chargePackages.id, pack.id));

    const again = await charge(pack, user, key);
    expect(again.statusCode).toBe(200);
    const a = first.json<{ data: ChargeResult }>().data;
    const b = again.json<{ data: ChargeResult }>().data;
    expect(b.payment).toEqual(a.payment);
    expect(b.payment).toMatchObject({ amountCoin: '10000', priceKrw: 9700, packageId: pack.id });
    expect(b.ledgerEntry).toEqual(a.ledgerEntry);
    expect(await paymentsOf(user.id)).toHaveLength(1);

    // The refreshed card carries the new terms: a different purchase, not a lost answer.
    const fresh = await charge({ ...pack, amountCoin: 12_000n, priceKrw: 9_900 }, user, key);
    expect(fresh.statusCode).toBe(409);
    expect(fresh.json()).toMatchObject({ error: { code: 'DUPLICATE_REQUEST' } });
    expect(await paymentsOf(user.id)).toHaveLength(1);
  });

  it('refuses a re-used Idempotency-Key that carries different terms (DUPLICATE_REQUEST)', async () => {
    // A key is a name for one purchase. The same key with another package is a client bug or
    // a replayed request, never a lost answer, so it must neither sell nor replay (PLAN 7.4).
    const other = await createTestPackage(t.db, { amountCoin: 30_000n, priceKrw: 28_500 });
    const key = randomUUID();
    expect((await charge(pack, user, key)).statusCode).toBe(200);

    const res = await charge(other, user, key);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: { code: 'DUPLICATE_REQUEST' } });
    // No field named: unlike the in-progress 409 below, this one tells the client the key is
    // spent, so its next click is a new purchase rather than a wait.
    expect(res.json<{ error: { details?: unknown } }>().error.details).toBeUndefined();

    expect(await balanceOf(user.id)).toMatchObject({
      availableCoin: pack.amountCoin,
    });
    expect(await paymentsOf(user.id)).toHaveLength(1);
  });

  it('scopes keys to the account: another user may use the same value', async () => {
    const key = randomUUID();
    const other = await signUpTestUser(t);
    expect((await charge(pack, user, key)).statusCode).toBe(200);
    expect((await charge(pack, other, key)).statusCode).toBe(200);
    expect(await balanceOf(other.id)).toMatchObject({
      availableCoin: pack.amountCoin,
    });
    expect(await paymentsOf(other.id)).toHaveLength(1);
  });

  it('requires a well-formed Idempotency-Key header', async () => {
    for (const headers of [
      { ...jsonHeaders, cookie: user.cookie },
      chargeHeaders(user.cookie, 'short'),
      chargeHeaders(user.cookie, 'has space in it'),
    ]) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/v1/payments/charge',
        headers,
        payload: chargeBody(pack, user.id),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: { code: 'VALIDATION_ERROR', details: [{ path: ['Idempotency-Key'] }] },
      });
    }
    // Refused before the provider runs: nothing reserved, nothing credited.
    expect(await paymentsOf(user.id)).toHaveLength(0);
    expect(await balanceOf(user.id)).toMatchObject({ availableCoin: 0n });
  });

  it('lets 20 concurrent requests with one key reach the provider once', async () => {
    // The key is reserved on a `pending` row before the provider is asked, so the losers of
    // the race hit the unique index and never charge; they answer 409 while the winner is
    // still running, or replay its 200 once it has committed. Either way: one payment.
    const key = randomUUID();
    const responses = await Promise.all(Array.from({ length: 20 }, () => charge(pack, user, key)));
    const statuses = responses.map((res) => res.statusCode);
    expect(statuses.every((status) => status === 200 || status === 409)).toBe(true);
    expect(statuses.filter((status) => status === 200).length).toBeGreaterThanOrEqual(1);
    for (const res of responses) {
      if (res.statusCode === 409) {
        expect(res.json()).toMatchObject({
          error: { code: 'DUPLICATE_REQUEST', details: [{ path: ['Idempotency-Key'] }] },
        });
      }
    }

    expect(await balanceOf(user.id)).toMatchObject({
      availableCoin: pack.amountCoin,
    });
    expect(await paymentsOf(user.id)).toHaveLength(1);
    expect((await ledgerOf(user.id)).filter((entry) => entry.type === 'DEPOSIT')).toHaveLength(1);
  });

  it('tells an in-progress key apart, keeps one payment, then replays it', async () => {
    // The first request is parked inside the provider; a retry with the same key (a click after
    // the first answer was lost) must neither charge again nor look final. Its 409 names the
    // header — the signal that makes the web keep the key — and once the first request has
    // committed, the same key collects that purchase.
    const provider = t.app.get<PaymentProvider>(PAYMENT_PROVIDER);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi.spyOn(provider, 'charge').mockImplementationOnce(async (request) => {
      await gate;
      return { status: 'succeeded', providerRef: `mock_${request.paymentId}` };
    });
    try {
      const key = randomUUID();
      // light-my-request dispatches lazily: `.then` is what sends the request.
      const first = charge(pack, user, key).then((res) => res);
      await vi.waitFor(async () => {
        expect((await paymentsOf(user.id)).map((row) => row.status)).toEqual(['pending']);
      });

      const retry = await charge(pack, user, key);
      expect(retry.statusCode).toBe(409);
      expect(retry.json()).toMatchObject({
        error: { code: 'DUPLICATE_REQUEST', details: [{ path: ['Idempotency-Key'] }] },
      });
      expect(spy).toHaveBeenCalledTimes(1);

      release();
      const res = await first;
      expect(res.statusCode).toBe(200);
      const replayed = await charge(pack, user, key);
      expect(replayed.statusCode).toBe(200);
      expect(replayed.json<{ data: ChargeResult }>().data.payment.id).toBe(
        res.json<{ data: ChargeResult }>().data.payment.id,
      );
      expect(await paymentsOf(user.id)).toHaveLength(1);
      expect(await balanceOf(user.id)).toMatchObject({
        availableCoin: pack.amountCoin,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('answers 500 and keeps the reservation when the balance row vanishes mid-charge', async () => {
    // The row was checked before the provider ran, so losing it between the check and the
    // credit (a broken database since migration 0060, as in the previous case) is not a client
    // error. A 500 is what makes the web keep its
    // key (a 4xx would spend it and the next click would charge again), and the `pending`
    // reservation is the only record that the provider accepted. The same key then answers
    // "in progress", never a second purchase.
    const provider = t.app.get<PaymentProvider>(PAYMENT_PROVIDER);
    const spy = vi.spyOn(provider, 'charge').mockImplementationOnce(async (request) => {
      await deleteBalanceRow(user.id);
      return { status: 'succeeded', providerRef: `mock_${request.paymentId}` };
    });
    try {
      const key = randomUUID();
      const res = await charge(pack, user, key);
      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ error: { code: 'INTERNAL' } });
      expect((await paymentsOf(user.id)).map((row) => row.status)).toEqual(['pending']);
      expect(await ledgerOf(user.id)).toHaveLength(0); // signing up writes no entry (#70)

      const retry = await charge(pack, user, key);
      expect(retry.statusCode).toBe(409);
      expect(retry.json()).toMatchObject({
        error: { code: 'DUPLICATE_REQUEST', details: [{ path: ['Idempotency-Key'] }] },
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(await paymentsOf(user.id)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('GET /me/ledger pages newest first and only shows the caller entries', async () => {
    const oldest = await charge(pack);
    await charge(pack);
    await charge(pack);
    const other = await signUpTestUser(t);
    await charge(pack, other);

    const first = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me/ledger?limit=2',
      headers: { cookie: user.cookie },
    });
    expect(first.statusCode).toBe(200);
    const firstPage = first.json<{ data: LedgerEntry[]; meta: { nextCursor: string | null } }>();
    expect(firstPage.data.map((entry) => entry.kind)).toEqual(['DEPOSIT', 'DEPOSIT']);
    expect(firstPage.meta.nextCursor).toBeTypeOf('string');

    const second = await t.app.inject({
      method: 'GET',
      url: `/api/v1/me/ledger?limit=2&cursor=${encodeURIComponent(firstPage.meta.nextCursor!)}`,
      headers: { cookie: user.cookie },
    });
    const secondPage = second.json<{ data: LedgerEntry[]; meta: { nextCursor: string | null } }>();
    // The oldest charge; signing up wrote no entry (#70).
    expect(secondPage.data.map((entry) => entry.id)).toEqual([
      oldest.json<{ data: ChargeResult }>().data.ledgerEntry.id,
    ]);
    expect(secondPage.meta.nextCursor).toBeNull();
  });

  it('GET /me/ledger lists both sides of the caller own account, each signed from it (#116)', async () => {
    // The ledger records moves between accounts, the sign is worked out at read time: an event
    // paid out of the caller's account (a fill to another person) is listed with a negative
    // amount and the payer's total after it, the payee's with a positive one and its own total.
    await charge(pack);
    const other = await signUpTestUser(t);
    const market = await createMarket(t.db);
    // The fill it pays for (#119: a TRADE_FILL names its fill row, migration 0062): the caller's
    // buy of 617 YES at 2 from the other's resting sell.
    const { fill: trade } = await createFillRecord(t.db, {
      marketId: market.id,
      incomingOwnerId: user.id,
      restingOwnerId: other.id,
      side: 'buy',
      kind: 'trade',
      priceCoin: 2,
      qty: 617,
    });
    const fill = await t.db.transaction((tx) =>
      recordLedgerEntry(tx, {
        type: 'TRADE_FILL',
        amountCoin: 1_234n,
        from: { kind: 'user', userId: user.id },
        to: { kind: 'user', userId: other.id },
        marketId: market.id,
        refType: 'fill',
        refId: String(trade.id),
        idempotencyKey: ledgerKeys.fill(String(trade.id)),
      }),
    );
    const ledgerFor = async (as: TestUser) => {
      const res = await t.app.inject({
        method: 'GET',
        url: '/api/v1/me/ledger',
        headers: { cookie: as.cookie },
      });
      expect(res.statusCode).toBe(200);
      return res.json<{ data: LedgerEntry[] }>().data;
    };

    const payer = await ledgerFor(user);
    // The payer's side of a fill is 매수 체결, the payee's 매도 체결 (#69): the stored type is the
    // same, the kind is the side's.
    expect(payer.map((entry) => [entry.kind, entry.amountCoin, entry.balanceAfterCoin])).toEqual([
      ['BUY_FILL', '-1234', (pack.amountCoin - 1_234n).toString()],
      ['DEPOSIT', pack.amountCoin.toString(), pack.amountCoin.toString()],
    ]);
    const payee = await ledgerFor(other);
    expect(payee).toEqual([
      expect.objectContaining({ kind: 'SELL_FILL', amountCoin: '1234', balanceAfterCoin: '1234' }),
    ]);
    // Each one's own order of the fill, never the other's.
    expect(payer[0]!.orderId).toBe(trade.incomingOrderId);
    expect(payee[0]!.orderId).toBe(trade.restingOrderId);
    // The same event on both pages, never naming the other side's account.
    expect(payee[0]!.id).toBe(fill.entry.id.toString());
    expect(payer[0]!.id).toBe(fill.entry.id.toString());
    for (const entry of [...payer, ...payee]) {
      expect(Object.keys(entry).sort()).toEqual(LEDGER_ENTRY_FIELDS);
    }
  });

  it('serves the first page for a malformed cursor instead of a 500', async () => {
    // Same class as the admin lists, but these two are reachable by any signed-in user:
    // /me/ledger compares a bigserial id and /me/payments a uuid (see @buddha/shared
    // decodeKeyset, which now takes the shape the column expects).
    await charge(pack);
    for (const route of ['/api/v1/me/ledger', '/api/v1/me/payments']) {
      for (const cursor of ['0_not-a-uuid', '0_not-a-number', '8640000000000001_x']) {
        const res = await t.app.inject({
          method: 'GET',
          url: `${route}?cursor=${encodeURIComponent(cursor)}`,
          headers: { cookie: user.cookie },
        });
        expect({ route, cursor, status: res.statusCode }).toEqual({ route, cursor, status: 200 });
        // Falling back to the first page, not an empty one.
        expect(res.json<{ data: unknown[] }>().data.length).toBeGreaterThan(0);
      }
    }
  });

  it('GET /me/payments lists the caller charges with the price paid', async () => {
    await charge(pack);
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me/payments',
      headers: { cookie: user.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      data: [{ amountCoin: '10000', priceKrw: 9700, provider: 'mock', status: 'succeeded' }],
      meta: { nextCursor: null },
    });
  });

  it('GET /me/payments/:id answers the caller own payment only', async () => {
    const charged = (await charge(pack)).json<{ data: ChargeResult }>().data.payment;
    const own = await t.app.inject({
      method: 'GET',
      url: `/api/v1/me/payments/${charged.id}`,
      headers: { cookie: user.cookie },
    });
    expect(own.statusCode).toBe(200);
    expect(own.json<{ data: Payment }>().data).toEqual(charged);

    // Someone else's payment is indistinguishable from none at all.
    const other = await signUpTestUser(t);
    for (const [cookie, id] of [
      [other.cookie, charged.id],
      [user.cookie, '3f1a5b6c-1111-4222-8333-444455556666'],
    ] as const) {
      const res = await t.app.inject({
        method: 'GET',
        url: `/api/v1/me/payments/${id}`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
    const malformed = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me/payments/not-a-uuid',
      headers: { cookie: user.cookie },
    });
    expect(malformed.statusCode).toBe(400);
    const anonymous = await t.app.inject({
      method: 'GET',
      url: `/api/v1/me/payments/${charged.id}`,
    });
    expect(anonymous.statusCode).toBe(401);
  });

  it('offers the immediate mock charge, and no SmartroPay window any more', async () => {
    // GET /payments/provider is public: the web picks the flow before anyone signs in.
    const info = await t.app.inject({ method: 'GET', url: '/api/v1/payments/provider' });
    expect(info.statusCode).toBe(200);
    expect(info.json()).toEqual({ data: { provider: 'mock' } });

    // The SmartroPay integration is gone (ADR-0049): its routes are no routes at all.
    for (const [method, url] of [
      ['POST', '/api/v1/payments/smartro/prepare'],
      ['POST', '/api/v1/payments/smartro/return?m=0'],
      ['POST', '/api/v1/payments/smartro/notify'],
    ] as const) {
      const res = await t.app.inject({
        method,
        url,
        headers: chargeHeaders(user.cookie),
        payload: chargeBody(pack, user.id),
      });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 404 });
    }
    expect(await paymentsOf(user.id)).toHaveLength(0);
  });

  it('publishes the new balance after a charge commits (PLAN 8)', async () => {
    const subscriber = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    const received: string[] = [];
    subscriber.on('message', (_channel: string, message: string) => received.push(message));
    await subscriber.subscribe(userChannel(user.id));
    try {
      const { data } = (await charge(pack)).json<{ data: ChargeResult }>();
      await waitForMessages(received, 1, 'user:balance after a charge');
      expect(received.map((message) => JSON.parse(message) as unknown)).toEqual([
        {
          type: 'user:balance',
          availableCoin: data.balance.availableCoin,
          lockedCoin: '0',
          ledgerEntryId: data.ledgerEntry.id,
          ts: data.ledgerEntry.createdAt,
        },
      ]);
    } finally {
      await subscriber.quit();
    }
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

  describe('GET /me/ledger as the wallet reads it (#69, ADR-0144)', () => {
    type LedgerPage = { data: LedgerEntry[]; meta: { nextCursor: string | null } };
    const read = (as: TestUser, query = '') =>
      t.app.inject({
        method: 'GET',
        url: `/api/v1/me/ledger${query}`,
        headers: { cookie: as.cookie },
      });
    /** One page, every entry the schema's and no other field. */
    const pageOf = async (as: TestUser, query = ''): Promise<LedgerPage> => {
      const res = await read(as, query);
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json<LedgerPage>();
      for (const entry of page.data) {
        expect(ledgerEntrySchema.parse(entry)).toEqual(entry);
        expect(Object.keys(entry).sort()).toEqual(LEDGER_ENTRY_FIELDS);
      }
      return page;
    };
    const entriesOf = async (as: TestUser, query = '') =>
      (await pageOf(as, `?limit=100${query}`)).data;
    /** Every page of a list, `limit` at a time, following the cursor until it ends. */
    async function walk(as: TestUser, limit: number, filter = '') {
      const walked: LedgerEntry[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const after = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
        const page: LedgerPage = await pageOf(as, `?limit=${String(limit)}${filter}${after}`);
        walked.push(...page.data);
        cursor = page.meta.nextCursor;
        pages += 1;
        expect(pages).toBeLessThan(20);
      } while (cursor !== null);
      return walked;
    }
    const expectRefused = async (as: TestUser, query: string) => {
      const res = await read(as, query);
      expect({ query, status: res.statusCode }).toEqual({ query, status: 400 });
      expect(res.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    };
    /** A member whose Coin is its start grant. */
    async function member() {
      const made = await signUpTestUser(t);
      const grant = await createStartGrant(t.db, { userId: made.id, amountCoin: 10_000n });
      return { ...made, grantId: grant.id };
    }
    const fillOf = async (fillId: string) =>
      (
        await t.db
          .select()
          .from(schema.fills)
          .where(eq(schema.fills.id, Number(fillId)))
      )[0]!;
    /** A kept DEPOSIT into `userId`'s account (no payment row: nothing reads it back). */
    const deposit = (userId: string, amountCoin: bigint, at?: Date) =>
      t.db.transaction(async (tx) => {
        const ref = randomUUID();
        const done = await recordLedgerEntry(tx, {
          type: 'DEPOSIT',
          amountCoin,
          from: null,
          to: { kind: 'user', userId },
          refType: 'payment',
          refId: ref,
          idempotencyKey: ledgerKeys.deposit(ref),
          ...(at === undefined ? {} : { at }),
        });
        return done.entry;
      });

    it('names each row by its kind from the caller’s side, links its market and own order, names no other side, and filters by kind without a gap or an overlap', async () => {
      const a = await member();
      const b = await member();
      await deposit(a.id, 500n);
      // A's YES against B's NO: one pair-mint fill, A's order incoming, B's resting.
      const traded = await createMarket(t.db);
      const pair = await fillOf(
        await mintTestPairs(t.db, {
          marketId: traded.id,
          yesHolderId: a.id,
          noHolderId: b.id,
          qty: 2,
          yesPriceCoin: 60,
        }),
      );
      // A buys one YES at 30 from B: the one move between two people (TRADE_FILL).
      const { fill: trade } = await createFillRecord(t.db, {
        marketId: traded.id,
        incomingOwnerId: a.id,
        restingOwnerId: b.id,
        side: 'buy',
        kind: 'trade',
        priceCoin: 30,
        qty: 1,
      });
      await t.db.transaction((tx) =>
        recordLedgerEntry(tx, {
          type: 'TRADE_FILL',
          amountCoin: 30n,
          from: { kind: 'user', userId: a.id },
          to: { kind: 'user', userId: b.id },
          marketId: traded.id,
          refType: 'fill',
          refId: String(trade.id),
          idempotencyKey: ledgerKeys.fill(String(trade.id)),
        }),
      );
      // A's YES against the 운영 마켓메이커's NO, then the real payout of that market.
      const settled = await createMarket(t.db);
      const bot = await fundMarketMakerFunds(t.db, settled.id, 1_000n);
      const botFill = await fillOf(
        await mintTestPairs(t.db, {
          marketId: settled.id,
          yesHolderId: a.id,
          noHolderId: bot,
          qty: 1,
          yesPriceCoin: 40,
        }),
      );
      await t.db
        .update(schema.markets)
        .set({ status: 'settling', resolvedResult: 'YES' })
        .where(eq(schema.markets.id, settled.id));
      await t.db.transaction((tx) => settleMarketPositions(tx, settled.id));

      // Read with no filter: one row per ledger row, without a 500 though the references are
      // of every shape (a grant's, a payment's and a market's uuid, a fill's id).
      const res = await read(a, '?limit=100');
      expect(res.statusCode, res.body).toBe(200);
      const all = await entriesOf(a);
      expect(
        all.map((entry) => [entry.kind, entry.amountCoin, entry.marketId, entry.orderId]),
      ).toEqual([
        ['SETTLEMENT_PAYOUT', '100', settled.id, null],
        // A's own order of the fill against the 운영 마켓메이커, never the bot's.
        ['BUY_FILL', '-40', settled.id, botFill.incomingOrderId],
        // A trade's payment and a pair mint's collateral: one kind, both A's orders (결과 4).
        ['BUY_FILL', '-30', traded.id, trade.incomingOrderId],
        ['BUY_FILL', '-120', traded.id, pair.incomingOrderId],
        ['DEPOSIT', '500', null, null],
        ['START_GRANT', '10000', null, null],
      ]);
      for (const entry of all.slice(0, 4)) {
        const market = entry.marketId === settled.id ? settled : traded;
        expect(entry).toMatchObject({
          marketSlug: market.slug,
          marketTitle: market.title,
          refType: entry.kind === 'SETTLEMENT_PAYOUT' ? 'market' : 'fill',
          // A market's row has no memo: the settlement's names the title (ADR-0144).
          memo: null,
          correctionEffect: null,
        });
      }
      expect(all.at(-1)).toMatchObject({
        refType: 'start_grant',
        refId: a.grantId,
        marketSlug: null,
        marketTitle: null,
      });
      // The stored types and the other side are nowhere in the answer.
      for (const secret of [
        'PAIR_MINT',
        'TRADE_FILL',
        b.id,
        bot,
        pair.restingOrderId,
        trade.restingOrderId,
        botFill.restingOrderId,
      ]) {
        expect(res.body, secret).not.toContain(secret);
      }
      expect(res.body).not.toMatch(/"type"\s*:/);

      // B's side of the same fills: its own kind, its own orders, nothing of A's.
      const bRes = await read(b, '?limit=100');
      expect(bRes.statusCode, bRes.body).toBe(200);
      expect(
        (await entriesOf(b)).map((entry) => [entry.kind, entry.amountCoin, entry.orderId]),
      ).toEqual([
        ['SELL_FILL', '30', trade.restingOrderId],
        ['BUY_FILL', '-80', pair.restingOrderId],
        ['START_GRANT', '10000', null],
      ]);
      for (const secret of [
        'PAIR_MINT',
        'TRADE_FILL',
        a.id,
        a.grantId,
        pair.incomingOrderId,
        trade.incomingOrderId,
      ]) {
        expect(bRes.body, secret).not.toContain(secret);
      }

      // Each kind of the filter: exactly that kind's rows, in order; together every row but the
      // kinds no filter offers, none twice.
      const byKind = new Map<LedgerEntryKind, LedgerEntry[]>();
      for (const kind of LEDGER_FILTER_KINDS) {
        const rows = await entriesOf(a, `&kind=${kind}`);
        expect(rows, kind).toEqual(all.filter((entry) => entry.kind === kind));
        byKind.set(kind, rows);
      }
      const filtered = [...byKind.values()].flat().map((entry) => entry.id);
      expect(new Set(filtered).size).toBe(filtered.length);
      const excluded: readonly string[] = LEDGER_FILTER_EXCLUDED;
      expect([...filtered].sort()).toEqual(
        all
          .filter((entry) => !excluded.includes(entry.kind))
          .map((entry) => entry.id)
          .sort(),
      );
      expect(all.filter((entry) => excluded.includes(entry.kind))).toHaveLength(1);
      expect(byKind.get('BUY_FILL')).toHaveLength(3);
      // A kind no filter offers, a stored type and an empty value are refused.
      for (const kind of ['DEPOSIT', 'BONUS', 'TRADE_FILL', 'PAIR_MINT_COLLATERAL', 'ALL', '']) {
        await expectRefused(a, `?kind=${kind}`);
      }

      // B naming A's markets, A's kinds or a cursor cut from A's rows reads B's own rows, or none.
      expect(await entriesOf(b, `&marketId=${settled.id}`)).toEqual([]);
      expect(await entriesOf(b, `&marketId=${settled.id}&kind=START_GRANT`)).toEqual([]);
      expect(await entriesOf(b, '&kind=SETTLEMENT_PAYOUT')).toEqual([]);
      expect(
        (await entriesOf(b, '&kind=START_GRANT')).map((entry) => [entry.refId, entry.amountCoin]),
      ).toEqual([[b.grantId, '10000']]);
      expect(
        (await entriesOf(b, `&marketId=${traded.id}&kind=BUY_FILL`)).map((entry) => entry.orderId),
      ).toEqual([pair.restingOrderId]);
      const aCursor = (await pageOf(a, '?limit=1')).meta.nextCursor!;
      const bIds = (await entriesOf(b)).map((entry) => entry.id);
      // A's newest row (the payout) came after every row of B's, so the cursor keeps all of B's.
      const fromA = await entriesOf(b, `&cursor=${encodeURIComponent(aCursor)}`);
      expect(bIds).toHaveLength(3);
      expect(fromA.map((entry) => entry.id)).toEqual(bIds);

      // An account with no ledger row reads an empty list, whatever it filters by.
      expect(await entriesOf(user)).toEqual([]);
      expect(await entriesOf(user, `&kind=BUY_FILL&period=7d&marketId=${traded.id}`)).toEqual([]);
    });

    it('filters by the event’s time and by market, and pages through same-instant rows of both sides without a gap or an overlap', async () => {
      const DAY_MS = 24 * 60 * 60 * 1_000;
      const now = Date.now();
      const other = await member();
      // Oldest first, as the account's chain is written: 31 and 8 days old, then a pair mint
      // (from the account), then two more at the pair mint's very instant (to it).
      const month = await deposit(user.id, 1_000n, new Date(now - 31 * DAY_MS));
      const week = await deposit(user.id, 1_000n, new Date(now - 8 * DAY_MS));
      const market = await createMarket(t.db);
      await mintTestPairs(t.db, {
        marketId: market.id,
        yesHolderId: user.id,
        noHolderId: other.id,
        qty: 1,
        yesPriceCoin: 50,
      });
      const [mint] = await entriesOf(user);
      expect(mint).toMatchObject({ kind: 'BUY_FILL', amountCoin: '-50', marketId: market.id });
      const same = new Date(mint!.createdAt);
      const first = await deposit(user.id, 7n, same);
      const second = await deposit(user.id, 9n, same);
      const ids = async (filter: string) =>
        (await entriesOf(user, filter)).map((entry) => entry.id);
      // Newest first: the same instant by id, the account's two sides interleaved.
      const all = [second.id, first.id, Number(mint!.id), week.id, month.id].map(String);
      expect(await ids('')).toEqual(all);

      // The last N × 24 hours of the read, by the time the list is ordered by.
      expect(await ids('&period=7d')).toEqual(all.slice(0, 3));
      expect(await ids('&period=30d')).toEqual(all.slice(0, 4));
      expect(await ids('&period=90d')).toEqual(all);
      for (const period of ['all', '1d', '7', '']) await expectRefused(user, `?period=${period}`);

      // One market: its rows alone — no DEPOSIT, no grant — and nothing for an unknown market.
      expect(await ids(`&marketId=${market.id}`)).toEqual([mint!.id]);
      expect(await ids(`&marketId=${market.id}&kind=BUY_FILL&period=7d`)).toEqual([mint!.id]);
      expect(await ids(`&marketId=${randomUUID()}`)).toEqual([]);
      await expectRefused(user, '?marketId=not-a-uuid');

      // One a page, both walks put together: every row once, in order, through the instant
      // three rows share across the two sides — and the same within a period and a kind.
      expect((await walk(user, 1)).map((entry) => entry.id)).toEqual(all);
      expect((await walk(user, 2)).map((entry) => entry.id)).toEqual(all);
      expect((await walk(user, 1, '&period=30d')).map((entry) => entry.id)).toEqual(
        all.slice(0, 4),
      );
      expect((await walk(user, 1, '&kind=BUY_FILL')).map((entry) => entry.id)).toEqual([mint!.id]);
      // The cursor carries no filter: one cut without a period goes on in a read with one.
      const plain = await pageOf(user, '?limit=1');
      const from = `&cursor=${encodeURIComponent(plain.meta.nextCursor!)}`;
      expect(await ids(`&period=7d${from}`)).toEqual(all.slice(1, 3));
      expect(await ids(from)).toEqual(all.slice(1));
    });
  });
});
