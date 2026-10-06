import { randomUUID } from 'node:crypto';
import {
  DEFAULT_LIQUIDITY_B,
  MARKET_STATUSES,
  SIGNUP_BONUS_P,
  initState,
  maxLossP,
  priceOf,
  serializeQuantity,
} from '@buddha/shared';
import { and, eq, lt, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  auditFailures,
  balances,
  ledgerEntries,
  marketSettlementSteps,
  markets,
  orders,
  paymentEvents,
  payments,
  positions,
  profiles,
  user,
  userContacts,
} from './schema/index.js';
import {
  createCategory,
  createMarket,
  createPosition,
  createSettlementStep,
  createUser,
} from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';

/**
 * Postgres SQLSTATE. drizzle-orm 0.45 wraps driver errors in DrizzleQueryError and keeps the
 * node-postgres error (with `.code`) in `cause`; `db.execute` throws it bare.
 */
function sqlState(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.cause?.code ?? e?.code;
}

/** The constraint or index a 23505 names (node-postgres `error.constraint`). */
function sqlConstraint(error: unknown): string | undefined {
  const e = error as { constraint?: string; cause?: { constraint?: string } } | null;
  return e?.cause?.constraint ?? e?.constraint;
}

describe.skipIf(!hasTestDb())('schema (integration, docker test profile)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
  });

  it('inserting a user row creates profile + balance through the trigger (PLAN 10.4)', async () => {
    await t.db.insert(user).values({ id: 'u-trigger', name: 'x', email: 'trigger@test.local' });
    const profile = await t.db.query.profiles.findFirst({
      where: eq(profiles.userId, 'u-trigger'),
    });
    const balance = await t.db.query.balances.findFirst({
      where: eq(balances.userId, 'u-trigger'),
    });
    expect(profile?.nickname).toMatch(/^예측가_[23456789A-HJ-NP-Z]{4}$/);
    expect(profile?.role).toBe('user');
    // Migration 0004: the sign-up bonus lands in the same transaction, with its ledger entry.
    expect(balance?.availableP).toBe(SIGNUP_BONUS_P);
    expect(balance?.lockedP).toBe(0n);
    const bonus = await t.db.query.ledgerEntries.findFirst({
      where: eq(ledgerEntries.userId, 'u-trigger'),
    });
    expect(bonus).toMatchObject({
      type: 'BONUS',
      amountP: SIGNUP_BONUS_P,
      balanceAfterP: SIGNUP_BONUS_P,
      memo: '가입 보너스',
    });
  });

  it('createUser applies nickname/role/balance and keeps the ledger invariant', async () => {
    const {
      user: u,
      profile,
      balance,
    } = await createUser(t.db, {
      nickname: '팩토리유저',
      role: 'admin',
      balanceP: 10_000n,
    });
    expect(profile.userId).toBe(u.id);
    expect(profile.nickname).toBe('팩토리유저');
    expect(profile.role).toBe('admin');
    expect(balance.availableP).toBe(10_000n);
    expect(balance.lockedP).toBe(0n);
    const [sum] = await t.db
      .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amountP}), 0)` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.userId, u.id));
    expect(BigInt(sum!.total)).toBe(10_000n);
  });

  it('round-trips bigint amounts beyond 2^53 exactly', async () => {
    const big = 2n ** 53n + 1n;
    const { user: u } = await createUser(t.db, { balanceP: big });
    const row = await t.db.query.balances.findFirst({ where: eq(balances.userId, u.id) });
    expect(row?.availableP).toBe(big);
  });

  it('rejects negative balances via CHECK', async () => {
    const { user: u } = await createUser(t.db);
    await expect(
      t.db.update(balances).set({ availableP: -1n }).where(eq(balances.userId, u.id)),
    ).rejects.toSatisfy((e) => sqlState(e) === '23514');
  });

  it('enforces unique nicknames', async () => {
    await createUser(t.db, { nickname: '중복닉' });
    await expect(createUser(t.db, { nickname: '중복닉' })).rejects.toSatisfy(
      (e) => sqlState(e) === '23505',
    );
  });

  it('createMarket initialises LMSR state and relations resolve', async () => {
    const category = await createCategory(t.db, { slug: 'economy', nameKo: '경제' });
    const market = await createMarket(t.db, { categoryId: category.id, initialProbBp: 7000 });
    expect(market.status).toBe('open');
    expect(market.lastPrice).toBe(70);
    expect(market.qNo).toBe('0.0000000000');
    expect(Number(market.qYes)).toBeCloseTo(1000 * Math.log(0.7 / 0.3), 6);
    // ADR-0027: the reserve is the true worst case, not PLAN 5.3's ln 2 figure (69,315P here).
    expect(market.reserveP).toBe(maxLossP(0.7, 1000));
    expect(market.reserveP).toBe(120_398n);
    const withCategory = await t.db.query.markets.findFirst({
      where: eq(markets.id, market.id),
      with: { category: true, creator: { with: { profile: true } } },
    });
    expect(withCategory?.category.slug).toBe('economy');
    expect(withCategory?.creator.profile?.role).toBe('admin');
  });

  describe('judgement and settlement steps (migration 0016, ADR-0046)', () => {
    it('labels market_status like MARKET_STATUSES, in order, with no dispute stage', async () => {
      const { rows } = await t.db.execute<{ label: string }>(sql`
        SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type ty ON ty.oid = e.enumtypid
        WHERE ty.typname = 'market_status' ORDER BY e.enumsortorder`);
      expect(rows.map((r) => r.label)).toEqual([...MARKET_STATUSES]);
    });

    it('has dropped disputes, its type and markets.dispute_until (O-8)', async () => {
      const { rows } = await t.db.execute<{
        disputes: string | null;
        disputeStatus: number;
        disputeUntil: number;
      }>(sql`
        SELECT to_regclass('public.disputes')::text AS "disputes",
          (SELECT count(*)::int FROM pg_type WHERE typname = 'dispute_status') AS "disputeStatus",
          (SELECT count(*)::int FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'markets'
              AND column_name = 'dispute_until') AS "disputeUntil"`);
      expect(rows[0]).toEqual({ disputes: null, disputeStatus: 0, disputeUntil: 0 });
    });

    it('createMarket writes the steps a judged or settled market has, and no others', async () => {
      const settledAt = new Date('2026-10-01T03:00:00.000Z');
      const resolved = await createMarket(t.db, { status: 'resolved', resolvedResult: 'YES' });
      const settled = await createMarket(t.db, {
        status: 'settled',
        resolvedResult: 'NO',
        settledAt,
      });
      const bare = await createMarket(t.db, { status: 'resolved', settlementSteps: false });
      const open = await createMarket(t.db);
      const rows = await t.db.select().from(marketSettlementSteps);
      const of = (marketId: string) => rows.filter((r) => r.marketId === marketId);
      expect(of(resolved.id)).toEqual([
        expect.objectContaining({
          step: 'coin',
          status: 'pending',
          attempts: 0,
          completedAt: null,
          lastError: null,
        }),
      ]);
      expect(of(settled.id)).toEqual([
        expect.objectContaining({
          step: 'coin',
          status: 'done',
          attempts: 1,
          completedAt: settledAt,
        }),
      ]);
      expect(of(bare.id)).toEqual([]);
      expect(of(open.id)).toEqual([]);
    });

    it('keeps one row per (market, step) and ties done to completed_at', async () => {
      const market = await createMarket(t.db, { status: 'resolved', settlementSteps: false });
      await createSettlementStep(t.db, { marketId: market.id });
      await expect(createSettlementStep(t.db, { marketId: market.id })).rejects.toSatisfy(
        (e) => sqlState(e) === '23505',
      );
      const other = await createMarket(t.db, { status: 'resolved', settlementSteps: false });
      // done without a completion instant, or a completion instant on a step not done: 23514.
      await expect(
        createSettlementStep(t.db, { marketId: other.id, status: 'done' }),
      ).rejects.toSatisfy((e) => sqlState(e) === '23514');
      await expect(
        createSettlementStep(t.db, {
          marketId: other.id,
          status: 'failed',
          completedAt: new Date(),
        }),
      ).rejects.toSatisfy((e) => sqlState(e) === '23514');
      await expect(
        createSettlementStep(t.db, { marketId: other.id, attempts: -1 }),
      ).rejects.toSatisfy((e) => sqlState(e) === '23514');
      // The worker updates the row in place: not append-only.
      await t.db
        .update(marketSettlementSteps)
        .set({ status: 'failed', attempts: 1, lastError: 'boom' })
        .where(eq(marketSettlementSteps.marketId, market.id));
      const [row] = await t.db
        .select()
        .from(marketSettlementSteps)
        .where(eq(marketSettlementSteps.marketId, market.id));
      expect(row).toMatchObject({ status: 'failed', attempts: 1, lastError: 'boom' });
    });
  });

  it('rejects out-of-range prices via CHECK', async () => {
    const market = await createMarket(t.db);
    await expect(
      t.db.update(markets).set({ lastPrice: 100 }).where(eq(markets.id, market.id)),
    ).rejects.toSatisfy((e) => sqlState(e) === '23514');
    await expect(
      t.db.update(markets).set({ initialProbBp: 10_000 }).where(eq(markets.id, market.id)),
    ).rejects.toSatisfy((e) => sqlState(e) === '23514');
  });

  it('createMarket factory rejects initialProbBp outside 1..9999 before writing', async () => {
    await expect(createMarket(t.db, { initialProbBp: 10_000 })).rejects.toThrow(RangeError);
  });

  it('createMarket stores maxLossP and the shared LMSR init for p0 != 0.5 (ADR-0027)', async () => {
    const b = DEFAULT_LIQUIDITY_B;
    const market = await createMarket(t.db, { initialProbBp: 1000 });
    const init = initState(0.1, b);
    expect(market.reserveP).toBe(maxLossP(0.1, b));
    expect(market.reserveP).toBe(230_259n);
    expect(market.reserveP).not.toBe(BigInt(Math.ceil(100 * b * Math.LN2)));
    // The numeric(24,10) columns round-trip the serialised quantities byte for byte.
    expect(market.qYes).toBe(serializeQuantity(init.qYes));
    expect(market.qNo).toBe(serializeQuantity(init.qNo));
    expect(market.liquidityB).toBe(b.toFixed(6));
    expect(market.lastPrice).toBe(priceOf(init));
    expect(market.lastPrice).toBe(10);
    expect(market.volumeP).toBe(0n);
    expect(market.tradeCount).toBe(0);
  });

  it('createMarket accepts an explicit LMSR state and statistics overrides', async () => {
    const state = { qYes: 1234.5, qNo: -50.25, b: 500 };
    const market = await createMarket(t.db, {
      liquidityB: state.b,
      initialProbBp: 5000,
      qYes: state.qYes,
      qNo: state.qNo,
      volumeP: 12_345n,
      tradeCount: 7,
    });
    expect(market.qYes).toBe(serializeQuantity(state.qYes));
    expect(market.qNo).toBe(serializeQuantity(state.qNo));
    expect(market.lastPrice).toBe(priceOf(state));
    // The reserve is a property of (p0, b), not of where the price curve currently sits.
    expect(market.reserveP).toBe(maxLossP(0.5, state.b));
    expect(market.volumeP).toBe(12_345n);
    expect(market.tradeCount).toBe(7);
    await expect(createMarket(t.db, { qYes: 1 })).rejects.toThrow(RangeError);
  });

  it('createPosition inserts a holdings row and nothing else', async () => {
    const { user: u } = await createUser(t.db);
    const market = await createMarket(t.db);
    const row = await createPosition(t.db, {
      userId: u.id,
      marketId: market.id,
      outcome: 'YES',
      qty: 10,
      costBasisP: 550n,
    });
    expect(row).toMatchObject({ qty: 10, costBasisP: 550n, realizedPnlP: 0n, settled: false });
    expect(await t.db.select().from(positions)).toHaveLength(1);
    const entries = await t.db.select().from(ledgerEntries).where(eq(ledgerEntries.userId, u.id));
    expect(entries.map((entry) => entry.type)).toEqual(['BONUS']);
  });

  it('positions.version starts at 1 and every ORM update bumps it (migration 0010)', async () => {
    // The ordering key of a user:position event: $onUpdate puts the bump into the SET list
    // of any db.update() that does not set it, so no writer can forget it.
    const { user: u } = await createUser(t.db);
    const market = await createMarket(t.db);
    const row = await createPosition(t.db, {
      userId: u.id,
      marketId: market.id,
      outcome: 'YES',
      qty: 10,
      costBasisP: 550n,
    });
    expect(row.version).toBe(1);
    const where = and(
      eq(positions.userId, u.id),
      eq(positions.marketId, market.id),
      eq(positions.outcome, 'YES'),
    );
    const [once] = await t.db.update(positions).set({ qty: 11 }).where(where).returning();
    expect(once!.version).toBe(2);
    const [twice] = await t.db.update(positions).set({ settled: true }).where(where).returning();
    expect(twice!.version).toBe(3);
  });

  it('orders: an idempotency key is unique per user, not across users (migration 0009)', async () => {
    const { user: a } = await createUser(t.db);
    const { user: b } = await createUser(t.db);
    const market = await createMarket(t.db);
    const order = (userId: string, idempotencyKey: string) => ({
      userId,
      marketId: market.id,
      outcome: 'YES' as const,
      side: 'buy' as const,
      type: 'market' as const,
      qty: 1,
      filledQty: 1,
      status: 'filled' as const,
      idempotencyKey,
    });
    await t.db.insert(orders).values(order(a.id, 'client-key'));
    // Client-minted keys collide across accounts; that must not block the second user.
    await t.db.insert(orders).values(order(b.id, 'client-key'));
    expect(await t.db.select().from(orders)).toHaveLength(2);
    await expect(t.db.insert(orders).values(order(a.id, 'client-key'))).rejects.toSatisfy(
      (e) =>
        sqlState(e) === '23505' && sqlConstraint(e) === 'orders_user_id_idempotency_key_unique',
    );
  });

  describe('SmartroPay (migrations 0014, 0015)', () => {
    const payment = (userId: string, overrides: Partial<typeof payments.$inferInsert> = {}) => ({
      userId,
      amountP: 10_000n,
      priceKrw: 9_700,
      provider: 'smartro',
      idempotencyKey: `key-${randomUUID()}`,
      ...overrides,
    });

    it('stores the new statuses and leaves the PG columns null until they are known', async () => {
      const { user: u } = await createUser(t.db);
      const [row] = await t.db.insert(payments).values(payment(u.id)).returning();
      expect(row).toMatchObject({
        status: 'pending',
        method: null,
        approvedAt: null,
        refundedAt: null,
        resultMessage: null,
      });
      // 0014's values are usable once the migration run has committed.
      for (const status of ['cancelled', 'refunding', 'refunded'] as const) {
        const [updated] = await t.db
          .update(payments)
          .set({ status })
          .where(eq(payments.id, row!.id))
          .returning();
        expect(updated!.status).toBe(status);
      }
    });

    it('lets a PG transaction id name one payment only, and any number have none', async () => {
      const { user: u } = await createUser(t.db);
      // Pending rows have no reference yet: the index is partial, so they never collide.
      await t.db.insert(payments).values([payment(u.id), payment(u.id)]);
      await t.db.insert(payments).values(payment(u.id, { providerRef: 'T0001' }));
      // The same Tid under another provider is another transaction.
      await t.db.insert(payments).values(payment(u.id, { provider: 'mock', providerRef: 'T0001' }));
      await expect(
        t.db.insert(payments).values(payment(u.id, { providerRef: 'T0001' })),
      ).rejects.toSatisfy(
        (e) =>
          sqlState(e) === '23505' && sqlConstraint(e) === 'payments_provider_provider_ref_unique',
      );
    });

    it('records payment events with an empty payload by default and keeps their payment', async () => {
      const { user: u } = await createUser(t.db);
      const [row] = await t.db.insert(payments).values(payment(u.id)).returning();
      const [event] = await t.db
        .insert(paymentEvents)
        .values({ paymentId: row!.id, type: 'return' })
        .returning();
      expect(event).toMatchObject({ type: 'return', resultCode: null, payload: {} });
      // ON DELETE RESTRICT: a payment with a PG history cannot disappear under it (23503).
      await expect(t.db.delete(payments).where(eq(payments.id, row!.id))).rejects.toSatisfy(
        (e) => sqlState(e) === '23503',
      );
    });

    it('keeps one contact per account', async () => {
      const { user: u } = await createUser(t.db);
      await t.db
        .insert(userContacts)
        .values({ userId: u.id, realName: '홍길동', phone: '01012345678' });
      await expect(
        t.db
          .insert(userContacts)
          .values({ userId: u.id, realName: '김철수', phone: '01099998888' }),
      ).rejects.toSatisfy((e) => sqlState(e) === '23505');
      const [upserted] = await t.db
        .insert(userContacts)
        .values({ userId: u.id, realName: '김철수', phone: '01099998888' })
        .onConflictDoUpdate({
          target: userContacts.userId,
          set: { realName: '김철수', phone: '01099998888' },
        })
        .returning();
      expect(upserted).toMatchObject({ realName: '김철수', phone: '01099998888' });
    });
  });

  it('$onUpdate refreshes updated_at through the ORM', async () => {
    const { profile } = await createUser(t.db);
    await new Promise((r) => setTimeout(r, 5));
    const [updated] = await t.db
      .update(profiles)
      .set({ nickname: '새닉네임' })
      .where(eq(profiles.userId, profile.userId))
      .returning();
    expect(updated!.updatedAt.getTime()).toBeGreaterThan(profile.updatedAt.getTime());
  });

  describe('timestamptz precision (migration 0005)', () => {
    it('round-trips a shared now() through a JS Date, which every keyset cursor relies on', async () => {
      // One statement, so all three rows carry a single transaction `now()`. While the columns
      // kept microseconds, the Date read back here was strictly older than the stored value,
      // and a cursor built from it skipped the whole group — page 2 of a listing came back
      // empty (@buddha/shared encodeKeyset compares `created_at < cursor OR = cursor AND ...`).
      await t.db
        .insert(auditFailures)
        .values([1, 2, 3].map((n) => ({ kind: 'ledger_balance_mismatch', payload: { n } })));

      const rows = await t.db.select().from(auditFailures);
      expect(rows).toHaveLength(3);
      const stamp = rows[0]!.createdAt;
      expect(rows.map((row) => row.createdAt.getTime())).toEqual([
        stamp.getTime(),
        stamp.getTime(),
        stamp.getTime(),
      ]);

      // The Date is an exact representation, so the rows still match the timestamp they
      // reported — and no row is stranded between `stamp` and its true stored value.
      const matched = await t.db
        .select()
        .from(auditFailures)
        .where(eq(auditFailures.createdAt, stamp));
      expect(matched).toHaveLength(3);
      const older = await t.db
        .select()
        .from(auditFailures)
        .where(lt(auditFailures.createdAt, stamp));
      expect(older).toHaveLength(0);
    });
  });

  describe('buddha_app privileges (PLAN 6.4)', () => {
    it('can INSERT and SELECT ledger_entries but not UPDATE or DELETE', async () => {
      const { user: u } = await createUser(t.db, { balanceP: 500n });
      const rows = await t.db
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.userId, u.id))
        .orderBy(ledgerEntries.id);
      // The trigger's sign-up BONUS, then the factory's correction down to 500P.
      expect(rows.map((row) => row.type)).toEqual(['BONUS', 'ADMIN_ADJUST']);
      await expect(
        t.db.update(ledgerEntries).set({ memo: 'x' }).where(eq(ledgerEntries.id, rows[0]!.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
      await expect(
        t.db.delete(ledgerEntries).where(eq(ledgerEntries.id, rows[0]!.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
    });

    it('cannot UPDATE/DELETE market_events, admin_actions or payment_events, can on other tables', async () => {
      const { rows } = await t.db.execute<{ table: string; privilege: string }>(sql`
        SELECT table_name AS "table", privilege_type AS privilege
        FROM information_schema.role_table_grants
        WHERE grantee = 'buddha_app' AND table_schema = 'public'
          AND table_name IN ('ledger_entries', 'market_events', 'admin_actions', 'payment_events',
            'balances', 'payments', 'user_contacts', 'market_settlement_steps')
        ORDER BY 1, 2`);
      const grants = Object.groupBy(rows, (r) => r.table);
      const privs = (table: string) => grants[table]?.map((r) => r.privilege).sort() ?? [];
      expect(privs('ledger_entries')).toEqual(['INSERT', 'SELECT']);
      expect(privs('market_events')).toEqual(['INSERT', 'SELECT']);
      expect(privs('admin_actions')).toEqual(['INSERT', 'SELECT']);
      // Migration 0015: the PG exchange log is append-only too.
      expect(privs('payment_events')).toEqual(['INSERT', 'SELECT']);
      expect(privs('balances')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      expect(privs('payments')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      expect(privs('user_contacts')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      // Migration 0016: the worker updates a step's row in place.
      expect(privs('market_settlement_steps')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    });

    it('cannot UPDATE or DELETE a payment event', async () => {
      const { user: u } = await createUser(t.db);
      const [row] = await t.db
        .insert(payments)
        .values({
          userId: u.id,
          amountP: 10_000n,
          priceKrw: 9_700,
          provider: 'smartro',
          idempotencyKey: 'append-only',
        })
        .returning();
      const [event] = await t.db
        .insert(paymentEvents)
        .values({ paymentId: row!.id, type: 'notify', resultCode: '3001' })
        .returning();
      await expect(
        t.db.update(paymentEvents).set({ resultCode: 'x' }).where(eq(paymentEvents.id, event!.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
      await expect(
        t.db.delete(paymentEvents).where(eq(paymentEvents.id, event!.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
    });

    it('cannot create tables', async () => {
      await expect(t.db.execute(sql`CREATE TABLE should_fail (id int)`)).rejects.toSatisfy(
        (e) => sqlState(e) === '42501',
      );
    });
  });
});
