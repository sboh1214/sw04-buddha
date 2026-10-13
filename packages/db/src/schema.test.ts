import { randomUUID } from 'node:crypto';
import {
  COUNTERPARTY_TYPES,
  LEDGER_ENTRY_TYPES,
  MARKET_STATUSES,
  PRICE_TICK_TRIGGERS,
  RELEASE_SETTING_STATUSES,
  SIGNUP_BONUS_COIN,
  nicknameSchema,
} from '@buddha/shared';
import { and, eq, lt, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  adminActions,
  auditFailures,
  balances,
  fills,
  ledgerEntries,
  marketSettlementSteps,
  markets,
  orders,
  paymentEvents,
  payments,
  positions,
  profiles,
  releaseSettings,
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
    // The #14 prefix (ADR-0052); the whole nickname passes the rule users are held to.
    expect(profile?.nickname).toMatch(/^user_[23456789A-HJ-NP-Z]{4}$/);
    expect(nicknameSchema.safeParse(profile?.nickname).success).toBe(true);
    expect(profile?.role).toBe('user');
    // Migration 0004: the sign-up bonus lands in the same transaction, with its ledger entry.
    expect(balance?.availableCoin).toBe(SIGNUP_BONUS_COIN);
    expect(balance?.lockedCoin).toBe(0n);
    const bonus = await t.db.query.ledgerEntries.findFirst({
      where: eq(ledgerEntries.userId, 'u-trigger'),
    });
    expect(bonus).toMatchObject({
      type: 'BONUS',
      amountCoin: SIGNUP_BONUS_COIN,
      balanceAfterCoin: SIGNUP_BONUS_COIN,
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
      balanceCoin: 10_000n,
    });
    expect(profile.userId).toBe(u.id);
    expect(profile.nickname).toBe('팩토리유저');
    expect(profile.role).toBe('admin');
    expect(balance.availableCoin).toBe(10_000n);
    expect(balance.lockedCoin).toBe(0n);
    const [sum] = await t.db
      .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amountCoin}), 0)` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.userId, u.id));
    expect(BigInt(sum!.total)).toBe(10_000n);
  });

  it('round-trips bigint amounts beyond 2^53 exactly', async () => {
    const big = 2n ** 53n + 1n;
    const { user: u } = await createUser(t.db, { balanceCoin: big });
    const row = await t.db.query.balances.findFirst({ where: eq(balances.userId, u.id) });
    expect(row?.availableCoin).toBe(big);
  });

  it('rejects negative balances via CHECK', async () => {
    const { user: u } = await createUser(t.db);
    await expect(
      t.db.update(balances).set({ availableCoin: -1n }).where(eq(balances.userId, u.id)),
    ).rejects.toSatisfy((e) => sqlState(e) === '23514');
  });

  it('enforces unique nicknames', async () => {
    await createUser(t.db, { nickname: '중복닉' });
    await expect(createUser(t.db, { nickname: '중복닉' })).rejects.toSatisfy(
      (e) => sqlState(e) === '23505',
    );
  });

  it('createMarket writes a market with no price before its first fill, and relations resolve', async () => {
    const category = await createCategory(t.db, { slug: 'economy', nameKo: '경제' });
    const market = await createMarket(t.db, { categoryId: category.id });
    expect(market.status).toBe('open');
    // N02 §5: no fill, no price — the direct AMM's initial probability is gone (#125).
    expect(market.lastPrice).toBeNull();
    expect(market.volumeCoin).toBe(0n);
    expect(market.tradeCount).toBe(0);
    expect(market).not.toHaveProperty('qYes');
    expect(market).not.toHaveProperty('mechanism');
    const withCategory = await t.db.query.markets.findFirst({
      where: eq(markets.id, market.id),
      with: { category: true, creator: { with: { profile: true } } },
    });
    expect(withCategory?.category.slug).toBe('economy');
    expect(withCategory?.creator.profile?.role).toBe('admin');
  });

  describe('the direct AMM is gone (migration 0017, #125)', () => {
    it('has dropped its market columns, the slippage guards and market_mechanism', async () => {
      const { rows } = await t.db.execute<{ table: string; column: string }>(sql`
        SELECT table_name AS "table", column_name AS "column" FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (table_name, column_name) IN (('markets', 'liquidity_b'), ('markets', 'q_yes'),
            ('markets', 'q_no'), ('markets', 'initial_prob_bp'), ('markets', 'reserve_p'),
            ('markets', 'mechanism'), ('orders', 'max_cost_p'), ('orders', 'min_proceeds_p'))`);
      expect(rows).toEqual([]);
      const types = await t.db.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM pg_type WHERE typname = 'market_mechanism'`,
      );
      expect(types.rows[0]?.n).toBe(0);
    });

    it('labels the recreated enums exactly like their shared tuples', async () => {
      async function labels(type: string): Promise<string[]> {
        const { rows } = await t.db.execute<{ label: string }>(sql`
          SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type ty ON ty.oid = e.enumtypid
          WHERE ty.typname = ${type} ORDER BY e.enumsortorder`);
        return rows.map((r) => r.label);
      }
      expect(await labels('ledger_entry_type')).toEqual([...LEDGER_ENTRY_TYPES]);
      expect(await labels('price_tick_trigger')).toEqual([...PRICE_TICK_TRIGGERS]);
      expect(await labels('counterparty_type')).toEqual([...COUNTERPARTY_TYPES]);
    });

    it('requires a fill to name the order it matched', async () => {
      const { user: u } = await createUser(t.db);
      const market = await createMarket(t.db);
      const [taker, maker] = await t.db
        .insert(orders)
        .values(
          ['taker-key', 'maker-key'].map((idempotencyKey) => ({
            userId: u.id,
            marketId: market.id,
            outcome: 'YES' as const,
            side: 'buy' as const,
            type: 'market' as const,
            qty: 1,
            status: 'open' as const,
            idempotencyKey,
          })),
        )
        .returning();
      const fill = {
        marketId: market.id,
        orderId: taker!.id,
        counterpartyType: 'order' as const,
        outcome: 'YES' as const,
        side: 'buy' as const,
        qty: 1,
        amountCoin: 52n,
        priceAvgBp: 5200,
      };
      await expect(t.db.insert(fills).values(fill)).rejects.toSatisfy(
        (e) => sqlState(e) === '23514',
      );
      await t.db.insert(fills).values({ ...fill, counterpartyOrderId: maker!.id });
      expect(await t.db.select().from(fills)).toHaveLength(1);
    });
  });

  describe('Coin names (migration 0018, #192)', () => {
    /** Columns (`table.column`), constraints and indexes of schema `public`. */
    async function names(): Promise<string[]> {
      const { rows } = await t.db.execute<{ name: string }>(sql`
        SELECT table_name || '.' || column_name AS name FROM information_schema.columns
          WHERE table_schema = 'public'
        UNION ALL SELECT conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace
        UNION ALL SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`);
      return rows.map((r) => r.name);
    }

    it('leaves no column, constraint or index named after P', async () => {
      // `p_yes_bp` is a probability in basis points, not an amount, and keeps its name.
      const pNamed = (await names()).filter((name) =>
        /(^|[._])p(_|$)/.test(name.replaceAll('p_yes_bp', '')),
      );
      expect(pNamed).toEqual([]);
    });

    it('renamed every amount column with its CHECK constraints and index', async () => {
      const coinNamed = (await names()).filter((name) => /_coin(_|$)/.test(name)).sort();
      expect(coinNamed).toEqual(
        [
          'balances.available_coin',
          'balances.locked_coin',
          'balances_available_coin_check',
          'balances_locked_coin_check',
          'charge_packages.amount_coin',
          'charge_packages_amount_coin_check',
          'coupon_redemptions.amount_coin',
          'coupons.amount_coin',
          'coupons_amount_coin_check',
          'fills.amount_coin',
          'fills.fee_coin',
          'fills_amount_coin_check',
          'fills_fee_coin_check',
          'ledger_entries.amount_coin',
          'ledger_entries.balance_after_coin',
          'markets.volume_coin',
          'markets_status_volume_coin_id_idx',
          'markets_volume_coin_check',
          'payments.amount_coin',
          'payments_amount_coin_check',
          'positions.cost_basis_coin',
          'positions.realized_pnl_coin',
          'positions_cost_basis_coin_check',
        ].sort(),
      );
    });
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

  it('rejects out-of-range prices via CHECK but takes no price at all', async () => {
    const market = await createMarket(t.db);
    for (const lastPrice of [0, 100]) {
      await expect(
        t.db.update(markets).set({ lastPrice }).where(eq(markets.id, market.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '23514');
    }
    const [priced] = await t.db
      .update(markets)
      .set({ lastPrice: 52 })
      .where(eq(markets.id, market.id))
      .returning();
    expect(priced!.lastPrice).toBe(52);
    const [cleared] = await t.db
      .update(markets)
      .set({ lastPrice: null })
      .where(eq(markets.id, market.id))
      .returning();
    expect(cleared!.lastPrice).toBeNull();
  });

  it('createMarket accepts a last price and statistics overrides', async () => {
    const market = await createMarket(t.db, { lastPrice: 37, volumeCoin: 12_345n, tradeCount: 7 });
    expect(market.lastPrice).toBe(37);
    expect(market.volumeCoin).toBe(12_345n);
    expect(market.tradeCount).toBe(7);
    for (const lastPrice of [0, 100, 52.5]) {
      await expect(createMarket(t.db, { lastPrice }), String(lastPrice)).rejects.toThrow(
        RangeError,
      );
    }
  });

  it('createPosition inserts a holdings row and nothing else', async () => {
    const { user: u } = await createUser(t.db);
    const market = await createMarket(t.db);
    const row = await createPosition(t.db, {
      userId: u.id,
      marketId: market.id,
      outcome: 'YES',
      qty: 10,
      costBasisCoin: 550n,
    });
    expect(row).toMatchObject({
      qty: 10,
      costBasisCoin: 550n,
      realizedPnlCoin: 0n,
      settled: false,
    });
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
      costBasisCoin: 550n,
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

  describe('PG payment columns and events (migrations 0014, 0015)', () => {
    const payment = (userId: string, overrides: Partial<typeof payments.$inferInsert> = {}) => ({
      userId,
      amountCoin: 10_000n,
      priceKrw: 9_700,
      provider: 'mock',
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
      // The same id under another provider is another transaction.
      await t.db.insert(payments).values(payment(u.id, { provider: 'acme', providerRef: 'T0001' }));
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

  describe('release settings (migration 0020, #170)', () => {
    const key = 'test.period_hours';
    type State = { status: 'undecided' | 'proposal' | 'test' | 'approved'; value: unknown };

    /** Instants 1 ms apart at least, like the API's: an UPDATE must move `updated_at` forward. */
    let last = 0;
    function nextInstant(): Date {
      last = Math.max(Date.now(), last + 1);
      return new Date(last);
    }

    /**
     * The change the API makes: its admin_actions record and the row, in one transaction, at
     * `record.at` for the record and `rowAt` for the row (both a fresh instant by default).
     */
    async function change(
      adminId: string,
      after: State,
      record: { adminId?: string; after?: State; at?: Date } = {},
      rowAt?: Date,
    ) {
      const at = rowAt ?? nextInstant();
      await t.db.transaction(async (tx) => {
        await tx.insert(adminActions).values({
          adminId: record.adminId ?? adminId,
          type: 'release_setting_change',
          targetType: 'release_setting',
          targetId: key,
          payload: {
            key,
            before: { status: 'undecided', value: null },
            after: record.after ?? after,
            reason: '시험',
          },
          createdAt: record.at ?? at,
        });
        await tx
          .insert(releaseSettings)
          .values({ key, ...after, updatedAt: at, updatedBy: adminId })
          .onConflictDoUpdate({
            target: releaseSettings.key,
            set: { ...after, updatedAt: at, updatedBy: adminId },
          });
      });
    }

    it('labels release_setting_status like RELEASE_SETTING_STATUSES', async () => {
      const { rows } = await t.db.execute<{ label: string }>(sql`
        SELECT unnest(enum_range(NULL::release_setting_status))::text AS label`);
      expect(rows.map((row) => row.label)).toEqual([...RELEASE_SETTING_STATUSES]);
    });

    it('stores a change made with its record, and every later one', async () => {
      const { user: admin } = await createUser(t.db, { role: 'admin' });
      await change(admin.id, { status: 'test', value: 48 });
      await change(admin.id, { status: 'approved', value: { from: 1, to: 2 } });
      await change(admin.id, { status: 'undecided', value: null });
      const rows = await t.db.select().from(releaseSettings);
      expect(rows).toMatchObject([{ key, status: 'undecided', value: null, updatedBy: admin.id }]);
      expect(await t.db.select().from(adminActions)).toHaveLength(3);
    });

    it('refuses, at commit, a write whose record is missing or tells another story', async () => {
      const { user: admin } = await createUser(t.db, { role: 'admin' });
      const { user: other } = await createUser(t.db, { role: 'admin' });
      // No record at all: a bare INSERT, and a bare UPDATE (moving the instant on) of a row that
      // has one.
      await expect(
        t.db.insert(releaseSettings).values({
          key,
          status: 'test',
          value: 48,
          updatedAt: nextInstant(),
          updatedBy: admin.id,
        }),
      ).rejects.toSatisfy((e) => sqlState(e) === '23000');
      await change(admin.id, { status: 'test', value: 48 });
      await expect(
        t.db
          .update(releaseSettings)
          .set({ value: 72, updatedAt: nextInstant() })
          .where(eq(releaseSettings.key, key)),
      ).rejects.toSatisfy((e) => sqlState(e) === '23000');
      // A record of another value, another actor or another instant.
      for (const record of [
        { after: { status: 'test', value: 24 } as State },
        { after: { status: 'approved', value: 72 } as State },
        { adminId: other.id },
        { at: nextInstant() },
      ]) {
        await expect(change(admin.id, { status: 'test', value: 72 }, record)).rejects.toSatisfy(
          (e) => sqlState(e) === '23000',
        );
      }
      // Each refused transaction rolled back whole: the first change and its record only.
      expect(await t.db.select().from(releaseSettings)).toMatchObject([
        { status: 'test', value: 48 },
      ]);
      expect(await t.db.select().from(adminActions)).toHaveLength(1);
    });

    it('refuses an UPDATE that does not move the instant forward: no record is replayed', async () => {
      const { user: admin } = await createUser(t.db, { role: 'admin' });
      const first = nextInstant();
      await change(admin.id, { status: 'test', value: 48 }, {}, first);
      const second = nextInstant();
      await change(admin.id, { status: 'approved', value: 72 }, {}, second);
      // The first change's record still matches its old state, actor and instant; putting that
      // state back under it — or rewriting the current one at its own instant — is refused.
      for (const [state, at] of [
        [{ status: 'test', value: 48 }, first],
        [{ status: 'approved', value: 72 }, second],
      ] as const) {
        await expect(
          t.db
            .update(releaseSettings)
            .set({ ...state, updatedAt: at, updatedBy: admin.id })
            .where(eq(releaseSettings.key, key)),
        ).rejects.toSatisfy((e) => sqlState(e) === '23000');
      }
      // A fresh change with its own record, written at an earlier instant than the row's: refused.
      await expect(
        change(admin.id, { status: 'proposal', value: 24 }, {}, new Date(first.getTime() - 1)),
      ).rejects.toSatisfy((e) => sqlState(e) === '23000');
      expect(await t.db.select().from(releaseSettings)).toMatchObject([
        { status: 'approved', value: 72, updatedAt: second },
      ]);
      expect(await t.db.select().from(adminActions)).toHaveLength(2);
    });

    it('ties the value to the status: none while undecided, never JSON null', async () => {
      const { user: admin } = await createUser(t.db, { role: 'admin' });
      for (const state of [
        { status: 'undecided', value: 24 },
        { status: 'approved', value: null },
        { status: 'proposal', value: sql`'null'::jsonb` },
      ] as const) {
        await expect(
          t.db.insert(releaseSettings).values({
            key,
            status: state.status,
            value: state.value,
            updatedAt: new Date(),
            updatedBy: admin.id,
          }),
        ).rejects.toSatisfy(
          (e) =>
            sqlState(e) === '23514' && sqlConstraint(e) === 'release_settings_value_status_check',
        );
      }
    });

    it('cannot DELETE a setting', async () => {
      const { user: admin } = await createUser(t.db, { role: 'admin' });
      await change(admin.id, { status: 'test', value: 48 });
      await expect(
        t.db.delete(releaseSettings).where(eq(releaseSettings.key, key)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
    });
  });

  describe('buddha_app privileges (PLAN 6.4)', () => {
    it('can INSERT and SELECT ledger_entries but not UPDATE or DELETE', async () => {
      const { user: u } = await createUser(t.db, { balanceCoin: 500n });
      const rows = await t.db
        .select()
        .from(ledgerEntries)
        .where(eq(ledgerEntries.userId, u.id))
        .orderBy(ledgerEntries.id);
      // The trigger's sign-up BONUS, then the factory's correction down to 500 Coin.
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
            'balances', 'payments', 'user_contacts', 'market_settlement_steps', 'release_settings')
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
      // Migration 0020: a release setting is changed, never removed.
      expect(privs('release_settings')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    });

    it('cannot UPDATE or DELETE a payment event', async () => {
      const { user: u } = await createUser(t.db);
      const [row] = await t.db
        .insert(payments)
        .values({
          userId: u.id,
          amountCoin: 10_000n,
          priceKrw: 9_700,
          provider: 'mock',
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
