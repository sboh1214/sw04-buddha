import { randomUUID } from 'node:crypto';
import {
  APPROVAL_STATUSES,
  COUNTERPARTY_TYPES,
  LEDGER_ENTRY_TYPES,
  MARKET_STATUSES,
  PRICE_TICK_TRIGGERS,
  RELEASE_SETTING_STATUSES,
  SIGNUP_BONUS_COIN,
  nicknameSchema,
  releaseSettingChangeBodySchema,
  releaseSettingChangePayloadSchema,
} from '@buddha/shared';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  adminActions,
  approvalRequests,
  auditFailures,
  balances,
  fills,
  ledgerEntries,
  marketLinks,
  marketSearchTerms,
  marketSearches,
  marketSettlementSteps,
  marketWatchEvents,
  marketWatches,
  markets,
  orders,
  paymentEvents,
  payments,
  phoneVerificationCodes,
  phoneVerifications,
  positions,
  profiles,
  releaseSettings,
  user,
} from './schema/index.js';
import { storedReleaseSettingValue } from './release-settings.js';
import {
  createCategory,
  createMarket,
  createMarketLink,
  createPhoneVerification,
  createPosition,
  createSearch,
  createSettlementStep,
  createUser,
  createWatch,
} from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import { isPhoneVerified } from './phone-verification.js';
import { lockAdminRoles } from './tx-helpers.js';

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

/** The Postgres message (a trigger's RAISE), wrapped or bare like `sqlState`. */
function errorMessage(error: unknown): string {
  const e = error as { message?: string; cause?: { message?: string } } | null;
  return e?.cause?.message ?? e?.message ?? '';
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

  it('a watch and its event resolve their account and market, and both resolve them back (#89)', async () => {
    const { user: u } = await createUser(t.db);
    const market = await createMarket(t.db);
    await createWatch(t.db, { userId: u.id, marketId: market.id });
    const watch = await t.db.query.marketWatches.findFirst({
      where: eq(marketWatches.userId, u.id),
      with: { user: true, market: true },
    });
    expect(watch).toMatchObject({ user: { id: u.id }, market: { id: market.id } });
    const event = await t.db.query.marketWatchEvents.findFirst({
      where: eq(marketWatchEvents.userId, u.id),
      with: { user: true, market: true },
    });
    expect(event).toMatchObject({ action: 'watch', user: { id: u.id }, market: { id: market.id } });
    // The alerts (#54) and the measures (#151) read them from the market and from the account.
    const watchedMarket = await t.db.query.markets.findFirst({
      where: eq(markets.id, market.id),
      with: { watches: true, watchEvents: true },
    });
    expect(watchedMarket?.watches.map((row) => row.userId)).toEqual([u.id]);
    expect(watchedMarket?.watchEvents.map((row) => row.action)).toEqual(['watch']);
    const watcher = await t.db.query.user.findFirst({
      where: eq(user.id, u.id),
      with: { watches: true, watchEvents: true },
    });
    expect(watcher?.watches.map((row) => row.marketId)).toEqual([market.id]);
    expect(watcher?.watchEvents.map((row) => row.marketId)).toEqual([market.id]);
  });

  it('keeps a link once per unordered pair, never a market with itself, and reads it from both ends (#65)', async () => {
    const admin = (await createUser(t.db, { role: 'admin' })).user.id;
    const [a, b] = [await createMarket(t.db), await createMarket(t.db)];
    const [low, high] = a.id < b.id ? [a, b] : [b, a];
    // Linked from the larger end, stored smaller first (`relatedMarketPair`): the CHECK and the
    // shared function agree on the order of two uuids.
    const link = await createMarketLink(t.db, {
      marketId: high.id,
      relatedMarketId: low.id,
      createdBy: admin,
    });
    expect(link).toMatchObject({ lowMarketId: low.id, highMarketId: high.id, createdBy: admin });
    // The same pair again — in either order — is the primary key's, and the reversed row is the
    // CHECK's: a pair cannot be written twice by spelling it the other way round.
    const insert = (lowMarketId: string, highMarketId: string) =>
      t.db.insert(marketLinks).values({ lowMarketId, highMarketId, createdBy: admin });
    const duplicate = await insert(low.id, high.id).catch((error: unknown) => error);
    expect(sqlState(duplicate)).toBe('23505');
    expect(sqlConstraint(duplicate)).toBe('market_links_low_market_id_high_market_id_pk');
    const reversed = await insert(high.id, low.id).catch((error: unknown) => error);
    expect(sqlState(reversed)).toBe('23514');
    expect(sqlConstraint(reversed)).toBe('market_links_order_check');
    const itself = await insert(a.id, a.id).catch((error: unknown) => error);
    expect(sqlConstraint(itself)).toBe('market_links_order_check');
    // A market's links are the rows where it is either end.
    const fromLow = await t.db.query.markets.findFirst({
      where: eq(markets.id, low.id),
      with: { linksAsLow: { with: { highMarket: true, creator: true } }, linksAsHigh: true },
    });
    expect(fromLow?.linksAsLow.map((row) => row.highMarket.id)).toEqual([high.id]);
    expect(fromLow?.linksAsLow[0]?.creator.id).toBe(admin);
    expect(fromLow?.linksAsHigh).toEqual([]);
    const fromHigh = await t.db.query.markets.findFirst({
      where: eq(markets.id, high.id),
      with: { linksAsHigh: { with: { lowMarket: true } } },
    });
    expect(fromHigh?.linksAsHigh.map((row) => row.lowMarket.id)).toEqual([low.id]);
    // Unlinking deletes the row: buddha_app keeps DELETE here (the history is admin_actions).
    const deleted = await t.db
      .delete(marketLinks)
      .where(eq(marketLinks.lowMarketId, low.id))
      .returning();
    expect(deleted).toHaveLength(1);
  });

  it('a recorded search resolves its account and back, and holds a term of 100 at most (#15)', async () => {
    const { user: u } = await createUser(t.db);
    const row = await createSearch(t.db, { userId: u.id, query: '금리' });
    const search = await t.db.query.marketSearches.findFirst({
      where: eq(marketSearches.id, row.id),
      with: { user: true },
    });
    expect(search).toMatchObject({ query: '금리', user: { id: u.id } });
    const searcher = await t.db.query.user.findFirst({
      where: eq(user.id, u.id),
      with: { searches: true },
    });
    expect(searcher?.searches.map((entry) => entry.query)).toEqual(['금리']);
    // The column is the API's bound (MARKET_SEARCH_TERM_MAX), in characters: a hundred Hangul
    // syllables fit, one more does not (22001).
    await createSearch(t.db, { userId: u.id, query: '가'.repeat(100) });
    await expect(createSearch(t.db, { userId: u.id, query: '가'.repeat(101) })).rejects.toSatisfy(
      (e) => sqlState(e) === '22001',
    );
  });

  it('keeps each term of an account at its newest search, through any insert or delete (#15, migration 0026)', async () => {
    const { user: u } = await createUser(t.db);
    const { user: other } = await createUser(t.db);
    const base = Date.now() - 60_000;
    const at = (seconds: number) => new Date(base + seconds * 1_000);
    type Term = { userId: string; query: string; searchId: string; searchedAt: Date };
    /** By account, then term, in JS: the expectations below are written in the same order. */
    const sorted = (rows: Term[]) =>
      rows.sort((a, b) => (`${a.userId}\u0000${a.query}` < `${b.userId}\u0000${b.query}` ? -1 : 1));
    const terms = async () =>
      sorted(
        await t.db
          .select({
            userId: marketSearchTerms.userId,
            query: marketSearchTerms.query,
            searchId: marketSearchTerms.searchId,
            searchedAt: marketSearchTerms.searchedAt,
          })
          .from(marketSearchTerms),
      );
    const term = (row: { userId: string; query: string; id: string; searchedAt: Date }): Term => ({
      userId: row.userId,
      query: row.query,
      searchId: row.id,
      searchedAt: row.searchedAt,
    });

    // Inserted out of order, as only a factory or a script would: the newest search wins, by its
    // time and then by its id within one millisecond, whichever was written last.
    const middle = await createSearch(t.db, { userId: u.id, query: '금리', searchedAt: at(2) });
    await createSearch(t.db, { userId: u.id, query: '금리', searchedAt: at(1) });
    expect(await terms()).toEqual([term(middle)]);
    // One millisecond, one term twice: the larger id wins. The ids are given, so one tie has its
    // larger id written first (환율) and the other second (물가) — 'the first write stays' and
    // 'the last write wins' each fail one of them, where random ids left it to a coin flip.
    const ids = () => [randomUUID(), randomUUID()].sort() as [string, string];
    const [fxLow, fxHigh] = ids();
    const fx = await createSearch(t.db, {
      id: fxHigh,
      userId: u.id,
      query: '환율',
      searchedAt: at(3),
    });
    await createSearch(t.db, { id: fxLow, userId: u.id, query: '환율', searchedAt: at(3) });
    const [cpiLow, cpiHigh] = ids();
    await createSearch(t.db, { id: cpiLow, userId: u.id, query: '물가', searchedAt: at(3) });
    const cpi = await createSearch(t.db, {
      id: cpiHigh,
      userId: u.id,
      query: '물가',
      searchedAt: at(3),
    });
    const newest = await createSearch(t.db, { userId: u.id, query: '금리', searchedAt: at(4) });
    const theirs = await createSearch(t.db, { userId: other.id, query: '금리', searchedAt: at(5) });
    expect(await terms()).toEqual(sorted([term(newest), term(fx), term(cpi), term(theirs)]));

    // Deleting a term's newest search alone (no route does) points the term at the newest left.
    await t.db.delete(marketSearches).where(eq(marketSearches.id, newest.id));
    expect(await terms()).toEqual(sorted([term(middle), term(fx), term(cpi), term(theirs)]));
    // And when the newest left share a millisecond, at the larger id of them: a newer search of
    // 환율 and of 물가, deleted in one statement, hands each term back to its tie's larger id —
    // written first for 환율 and second for 물가, so neither the smaller id nor the order the
    // rows were written in can pass.
    const later = [
      await createSearch(t.db, { userId: u.id, query: '환율', searchedAt: at(6) }),
      await createSearch(t.db, { userId: u.id, query: '물가', searchedAt: at(6) }),
    ];
    expect(await terms()).toEqual(sorted([term(middle), ...later.map(term), term(theirs)]));
    await t.db.delete(marketSearches).where(
      inArray(
        marketSearches.id,
        later.map((row) => row.id),
      ),
    );
    expect(await terms()).toEqual(sorted([term(middle), term(fx), term(cpi), term(theirs)]));
    // Deleting every search of a term, as the delete route does, takes the term away — and only
    // that account's: the other account's search of the same term stays, and so does its term.
    await t.db
      .delete(marketSearches)
      .where(and(eq(marketSearches.userId, u.id), eq(marketSearches.query, '금리')));
    expect(await terms()).toEqual(sorted([term(fx), term(cpi), term(theirs)]));
    // A recorded search is never changed in place (migration 0026 revoked UPDATE).
    await expect(
      t.db.update(marketSearches).set({ query: '유가' }).where(eq(marketSearches.id, fx.id)),
    ).rejects.toSatisfy((e) => sqlState(e) === '42501');
    // Clearing an account's searches, as the clear route does, takes all its terms away.
    await t.db.delete(marketSearches).where(eq(marketSearches.userId, u.id));
    expect(await terms()).toEqual([term(theirs)]);
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
          // `markets_status_volume_coin_id_idx` went with the volume order (migration 0024,
          // ADR-0065); #132 brings both back.
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

    it('keeps one verification per account and one account per number (#183, ADR-0070)', async () => {
      const { user: a } = await createUser(t.db);
      const { user: b } = await createUser(t.db);
      expect(await isPhoneVerified(t.db, a.id)).toBe(false);
      const row = await createPhoneVerification(t.db, { userId: a.id, phone: '01012345678' });
      expect(row).toMatchObject({ userId: a.id, phone: '01012345678', realName: '홍길동' });
      expect(await isPhoneVerified(t.db, a.id)).toBe(true);
      expect(await isPhoneVerified(t.db, b.id)).toBe(false);
      expect(await isPhoneVerified(t.db, 'no-such-account')).toBe(false);
      // A second row for the account, and the number for another account: both refused.
      await expect(
        t.db
          .insert(phoneVerifications)
          .values({ userId: a.id, phone: '01099998888', realName: '김철수' }),
      ).rejects.toSatisfy((e) => sqlState(e) === '23505');
      await expect(
        t.db
          .insert(phoneVerifications)
          .values({ userId: b.id, phone: '01012345678', realName: '김철수' }),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23505' && sqlConstraint(e) === 'phone_verifications_phone_unique',
      );
      // Only the digits phoneSchema yields: another spelling of the number is not another number.
      for (const phone of ['010-999-88', '0212345678', '01512345678', '0101234567x']) {
        await expect(
          t.db.insert(phoneVerifications).values({ userId: b.id, phone, realName: '김철수' }),
        ).rejects.toSatisfy(
          (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'phone_verifications_phone_check',
        );
      }
    });

    it('keeps the codes sent, their counts and their account (#183, ADR-0070)', async () => {
      const { user: u } = await createUser(t.db);
      const code = (values: Partial<typeof phoneVerificationCodes.$inferInsert> = {}) => ({
        id: randomUUID(),
        userId: u.id,
        phone: '01012345678',
        realName: '홍길동',
        codeHash: 'a'.repeat(64),
        expiresAt: new Date(Date.now() + 180_000),
        ...values,
      });
      const [row] = await t.db.insert(phoneVerificationCodes).values(code()).returning();
      expect(row).toMatchObject({ attempts: 0, consumedAt: null });
      expect(row!.sentAt.getTime()).toBeLessThan(row!.expiresAt.getTime());
      await expect(
        t.db.insert(phoneVerificationCodes).values(code({ attempts: -1 })),
      ).rejects.toSatisfy(
        (e) =>
          sqlState(e) === '23514' && sqlConstraint(e) === 'phone_verification_codes_attempts_check',
      );
      await expect(
        t.db
          .insert(phoneVerificationCodes)
          .values(code({ sentAt: new Date(), expiresAt: new Date(Date.now() - 1_000) })),
      ).rejects.toSatisfy(
        (e) =>
          sqlState(e) === '23514' && sqlConstraint(e) === 'phone_verification_codes_expiry_check',
      );
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
     * `record.at` for the record and `rowAt` for the row (both a fresh instant by default). The
     * record's `before` is the state the row holds when the change starts — undecided with no
     * value when there is no row — unless `record.before` replaces it; `record.payloadKey`
     * replaces the key the payload names (the one the change log shows), and `record.reason` the
     * reason (left out of the payload when undefined).
     */
    async function change(
      adminId: string,
      after: State,
      record: {
        adminId?: string;
        after?: State;
        before?: unknown;
        at?: Date;
        payloadKey?: string;
        reason?: unknown;
      } = {},
      rowAt?: Date,
    ) {
      const at = rowAt ?? nextInstant();
      await t.db.transaction(async (tx) => {
        const [current] = await tx
          .select({ status: releaseSettings.status, value: storedReleaseSettingValue })
          .from(releaseSettings)
          .where(eq(releaseSettings.key, key));
        const before: State = {
          status: current?.status ?? 'undecided',
          value: current?.value ?? null,
        };
        await tx.insert(adminActions).values({
          adminId: record.adminId ?? adminId,
          type: 'release_setting_change',
          targetType: 'release_setting',
          targetId: key,
          payload: {
            key: record.payloadKey ?? key,
            before: 'before' in record ? record.before : before,
            after: record.after ?? after,
            reason: 'reason' in record ? record.reason : '시험',
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
      // From a stored undecided row (its record's `before` is undecided with no value), and from
      // a string that is JSON text (the record keeps the string, not what it spells).
      await change(admin.id, { status: 'proposal', value: '"24"' });
      await change(admin.id, { status: 'test', value: 24 });
      const rows = await t.db.select().from(releaseSettings);
      expect(rows).toMatchObject([{ key, status: 'test', value: 24, updatedBy: admin.id }]);
      // Each record's `before` is the previous one's `after`.
      const records = await t.db
        .select({ payload: adminActions.payload })
        .from(adminActions)
        .orderBy(adminActions.createdAt);
      expect(records.map((r) => (r.payload as { before: unknown }).before)).toEqual([
        { status: 'undecided', value: null },
        { status: 'test', value: 48 },
        { status: 'approved', value: { from: 1, to: 2 } },
        { status: 'undecided', value: null },
        { status: 'proposal', value: '"24"' },
      ]);
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
      // A record of another value, another actor or another instant, or one that targets this
      // key but names another in its payload (the key the change log would show).
      for (const record of [
        { after: { status: 'test', value: 24 } as State },
        { after: { status: 'approved', value: 72 } as State },
        { adminId: other.id },
        { at: nextInstant() },
        { payloadKey: 'test.other_hours' },
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

    it('refuses, at commit, a record whose `before` is not the state the write replaced', async () => {
      const { user: admin } = await createUser(t.db, { role: 'admin' });
      // A first write (INSERT) replaces the implicit undecided state: any other `before` — a
      // decided one, undecided with a value, a value left out, no `before` at all — is refused.
      for (const before of [
        { status: 'test', value: 48 },
        { status: 'undecided', value: 48 },
        { status: 'undecided' },
        undefined,
      ]) {
        await expect(change(admin.id, { status: 'test', value: 48 }, { before })).rejects.toSatisfy(
          (e) => sqlState(e) === '23000',
        );
      }
      expect(await t.db.select().from(releaseSettings)).toEqual([]);
      expect(await t.db.select().from(adminActions)).toEqual([]);

      await change(admin.id, { status: 'test', value: 48 });
      // An UPDATE replaces the old row's status and value: the undecided state a first write
      // records, another status, another value or none are all refused.
      for (const before of [
        { status: 'undecided', value: null },
        { status: 'approved', value: 48 },
        { status: 'test', value: 24 },
        { status: 'test', value: '48' },
        { status: 'test' },
        undefined,
      ]) {
        await expect(
          change(admin.id, { status: 'approved', value: 72 }, { before }),
        ).rejects.toSatisfy((e) => sqlState(e) === '23000');
      }
      // Each refused transaction rolled back whole: the first change and its record only.
      expect(await t.db.select().from(releaseSettings)).toMatchObject([
        { status: 'test', value: 48 },
      ]);
      expect(await t.db.select().from(adminActions)).toHaveLength(1);

      // The true `before` passes, compared as JSON (key order aside).
      await change(admin.id, { status: 'approved', value: { from: 1, to: 2.5 } });
      await change(
        admin.id,
        { status: 'undecided', value: null },
        { before: { value: { to: 2.5, from: 1 }, status: 'approved' } },
      );
      expect(await t.db.select().from(releaseSettings)).toMatchObject([
        { status: 'undecided', value: null },
      ]);
      // From a stored undecided row too, only the undecided state with no value passes.
      await expect(
        change(admin.id, { status: 'test', value: 24 }, { before: { status: 'undecided' } }),
      ).rejects.toSatisfy((e) => sqlState(e) === '23000');
      await change(admin.id, { status: 'test', value: 24 });
      expect(await t.db.select().from(adminActions)).toHaveLength(4);
    });

    it('refuses, at commit, a record whose reason the API would not take', async () => {
      const { user: admin } = await createUser(t.db, { role: 'admin' });
      // The API's reason: a string of 1 to 500 characters once trimmed, trimmed as JavaScript
      // does and counted in code points as zod does. Left out, not a string, blank — in any white
      // space JavaScript trims — or longer is refused, at a first write and at an UPDATE alike.
      const refused: unknown[] = [
        undefined,
        null,
        42,
        true,
        ['시험'],
        { text: '시험' },
        '',
        '   ',
        '\t\n\u000b\f\r\u00a0\u1680\u2000\u200a\u2028\u2029\u202f\u205f\u3000\ufeff',
        'x'.repeat(501),
        ` ${'x'.repeat(501)} `,
        '😀'.repeat(501),
      ];
      for (const reason of refused) {
        expect(releaseSettingChangeBodySchema.shape.reason.safeParse(reason).success).toBe(false);
        await expect(change(admin.id, { status: 'test', value: 48 }, { reason })).rejects.toSatisfy(
          (e) => sqlState(e) === '23000',
        );
      }
      expect(await t.db.select().from(releaseSettings)).toEqual([]);
      expect(await t.db.select().from(adminActions)).toEqual([]);

      await change(admin.id, { status: 'test', value: 48 });
      for (const reason of refused) {
        await expect(change(admin.id, { status: 'test', value: 72 }, { reason })).rejects.toSatisfy(
          (e) => sqlState(e) === '23000',
        );
      }
      expect(await t.db.select().from(releaseSettings)).toMatchObject([
        { status: 'test', value: 48 },
      ]);
      expect(await t.db.select().from(adminActions)).toHaveLength(1);

      // What the API takes passes, white space around it aside, and every record reads as the
      // change log expects. A character past U+FFFF is one (two UTF-16 units, four bytes).
      const accepted = ['x', 'x'.repeat(500), `\u3000 ${'x'.repeat(500)}\n\t`, '😀'.repeat(500)];
      for (const [i, reason] of accepted.entries()) {
        expect(releaseSettingChangeBodySchema.shape.reason.safeParse(reason).success).toBe(true);
        await change(admin.id, { status: 'proposal', value: i }, { reason });
      }
      const records = await t.db
        .select({ payload: adminActions.payload })
        .from(adminActions)
        .orderBy(adminActions.createdAt);
      expect(records).toHaveLength(1 + accepted.length);
      for (const { payload } of records) {
        expect(releaseSettingChangePayloadSchema.safeParse(payload).success).toBe(true);
      }
    });

    it('refuses, at commit, a record whose payload key is not the key as a string', async () => {
      const { user: admin } = await createUser(t.db, { role: 'admin' });
      // A key that spells a JSON literal (the key pattern allows `true`) is met by its string
      // only: the change log reads the payload key as a string.
      const literal = 'true';
      const write = (payloadKey: unknown) =>
        t.db.transaction(async (tx) => {
          const at = nextInstant();
          const after: State = { status: 'test', value: 48 };
          await tx.insert(adminActions).values({
            adminId: admin.id,
            type: 'release_setting_change',
            targetType: 'release_setting',
            targetId: literal,
            payload: {
              key: payloadKey,
              before: { status: 'undecided', value: null },
              after,
              reason: '시험',
            },
            createdAt: at,
          });
          await tx
            .insert(releaseSettings)
            .values({ key: literal, ...after, updatedAt: at, updatedBy: admin.id });
        });
      await expect(write(true)).rejects.toSatisfy((e) => sqlState(e) === '23000');
      expect(await t.db.select().from(adminActions)).toEqual([]);
      await write(literal);
      expect(await t.db.select().from(releaseSettings)).toMatchObject([
        { key: literal, status: 'test', value: 48 },
      ]);
      expect(await t.db.select().from(adminActions)).toHaveLength(1);
    });

    it('refuses an UPDATE that does not move the instant forward: no record is replayed', async () => {
      const { user: admin } = await createUser(t.db, { role: 'admin' });
      const first = nextInstant();
      await change(admin.id, { status: 'test', value: 48 }, {}, first);
      const second = nextInstant();
      await change(admin.id, { status: 'undecided', value: null }, {}, second);
      // Back on an undecided row, the first change's record matches putting its state back in
      // all but the instant — the state it replaced, its new state, actor and key — and is
      // refused; so is rewriting the current state at its own instant.
      for (const [state, at] of [
        [{ status: 'test', value: 48 }, first],
        [{ status: 'undecided', value: null }, second],
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
        { status: 'undecided', value: null, updatedAt: second },
      ]);
      expect(await t.db.select().from(adminActions)).toHaveLength(2);
    });

    it('refuses an UPDATE that renames a key, even with the record of the new one', async () => {
      const { user: admin } = await createUser(t.db, { role: 'admin' });
      await change(admin.id, { status: 'test', value: 48 });
      // Everything the record check looks at matches the renamed row; only the key moved.
      const renamed = 'test.other_hours';
      const at = nextInstant();
      const after: State = { status: 'approved', value: 72 };
      await expect(
        t.db.transaction(async (tx) => {
          await tx.insert(adminActions).values({
            adminId: admin.id,
            type: 'release_setting_change',
            targetType: 'release_setting',
            targetId: renamed,
            payload: {
              key: renamed,
              before: { status: 'test', value: 48 },
              after,
              reason: '시험',
            },
            createdAt: at,
          });
          await tx
            .update(releaseSettings)
            .set({ key: renamed, ...after, updatedAt: at, updatedBy: admin.id })
            .where(eq(releaseSettings.key, key));
        }),
      ).rejects.toSatisfy((e) => sqlState(e) === '23000');
      // The key keeps its row (it does not fall back to undecided), and no record was added.
      expect(await t.db.select().from(releaseSettings)).toMatchObject([
        { key, status: 'test', value: 48 },
      ]);
      expect(await t.db.select().from(adminActions)).toHaveLength(1);
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

  describe('approval requests (migration 0021, #171)', () => {
    async function request(requestedBy: string) {
      const [row] = await t.db
        .insert(approvalRequests)
        .values({
          kind: 'test_kind',
          targetType: 'market',
          targetId: randomUUID(),
          payload: { note: '시험' },
          requestedBy,
          requestReason: '요청 사유',
          requestedAt: new Date(),
        })
        .returning();
      return row!;
    }
    const decision = (decidedBy: string, status: 'approved' | 'rejected' = 'approved') => ({
      status,
      decidedBy,
      decisionReason: '결정 사유',
      decidedAt: new Date(),
    });

    it('labels approval_status like APPROVAL_STATUSES', async () => {
      const { rows } = await t.db.execute<{ label: string }>(sql`
        SELECT unnest(enum_range(NULL::approval_status))::text AS label`);
      expect(rows.map((row) => row.label)).toEqual([...APPROVAL_STATUSES]);
    });

    it('takes one decision by another account, with its decider, reason and instant', async () => {
      const { user: requester } = await createUser(t.db, { role: 'admin' });
      const { user: decider } = await createUser(t.db, { role: 'admin' });
      const row = await request(requester.id);
      expect(row).toMatchObject({ status: 'pending', decidedBy: null, decidedAt: null });
      await t.db
        .update(approvalRequests)
        .set(decision(decider.id))
        .where(eq(approvalRequests.id, row.id));
      const [decided] = await t.db.select().from(approvalRequests);
      expect(decided).toMatchObject({ status: 'approved', decidedBy: decider.id });
    });

    it('refuses a decision by the requester, whoever writes it', async () => {
      const { user: requester } = await createUser(t.db, { role: 'admin' });
      const row = await request(requester.id);
      for (const status of ['approved', 'rejected'] as const) {
        await expect(
          t.db
            .update(approvalRequests)
            .set(decision(requester.id, status))
            .where(eq(approvalRequests.id, row.id)),
        ).rejects.toSatisfy(
          (e) =>
            sqlState(e) === '23514' &&
            sqlConstraint(e) === 'approval_requests_decider_not_requester_check',
        );
      }
      // Not even inserted decided (the INSERT trigger refuses any decided row first).
      await expect(
        t.db.insert(approvalRequests).values({
          kind: 'test_kind',
          requestedBy: requester.id,
          requestReason: '요청 사유',
          requestedAt: new Date(),
          ...decision(requester.id),
        }),
      ).rejects.toSatisfy((e) => sqlState(e) === '23000');
    });

    it('inserts a request pending with no decision only, whoever writes it', async () => {
      // A decided row by another account satisfies every CHECK: inserting one would skip the
      // pending phase, and with it ApprovalService's check that the decider is an admin now.
      const { user: requester } = await createUser(t.db, { role: 'admin' });
      const { user: decider } = await createUser(t.db, { role: 'admin' });
      const base = {
        kind: 'test_kind',
        requestedBy: requester.id,
        requestReason: '요청 사유',
        requestedAt: new Date(),
      };
      for (const values of [
        { ...base, ...decision(decider.id, 'approved') },
        { ...base, ...decision(decider.id, 'rejected') },
        // Pending with a decision column set: refused before the CHECK would be.
        { ...base, decidedBy: decider.id },
        { ...base, decisionReason: '결정 사유' },
        { ...base, decidedAt: new Date() },
      ]) {
        await expect(
          t.db.insert(approvalRequests).values(values),
          JSON.stringify(Object.keys(values)),
        ).rejects.toSatisfy(
          (e) =>
            sqlState(e) === '23000' &&
            errorMessage(e).includes('must be inserted pending, with no decision'),
        );
      }
      expect(await t.db.select().from(approvalRequests)).toEqual([]);
      // Pending, given explicitly or by the default, is a request.
      await t.db.insert(approvalRequests).values({ ...base, status: 'pending' });
      await t.db.insert(approvalRequests).values(base);
      expect(await t.db.select().from(approvalRequests)).toHaveLength(2);
    });

    it('ties the decision columns to the status and requires non-blank reasons', async () => {
      const { user: requester } = await createUser(t.db, { role: 'admin' });
      const { user: decider } = await createUser(t.db, { role: 'admin' });
      const row = await request(requester.id);
      for (const set of [
        { status: 'approved' as const },
        { decidedBy: decider.id },
        { ...decision(decider.id), decisionReason: null },
        { ...decision(decider.id), decidedAt: null },
        { ...decision(decider.id), status: 'pending' as const },
      ]) {
        await expect(
          t.db.update(approvalRequests).set(set).where(eq(approvalRequests.id, row.id)),
        ).rejects.toSatisfy(
          (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'approval_requests_decision_check',
        );
      }
      await expect(
        t.db
          .update(approvalRequests)
          .set({ ...decision(decider.id), decisionReason: '  ' })
          .where(eq(approvalRequests.id, row.id)),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'approval_requests_reasons_check',
      );
      await expect(
        t.db.insert(approvalRequests).values({
          kind: 'test_kind',
          requestedBy: requester.id,
          requestReason: ' ',
          requestedAt: new Date(),
        }),
      ).rejects.toSatisfy(
        (e) => sqlState(e) === '23514' && sqlConstraint(e) === 'approval_requests_reasons_check',
      );
    });

    it('never changes what was requested, nor a decided request', async () => {
      const { user: requester } = await createUser(t.db, { role: 'admin' });
      const { user: decider } = await createUser(t.db, { role: 'admin' });
      const { user: other } = await createUser(t.db, { role: 'admin' });
      const row = await request(requester.id);
      for (const set of [
        { kind: 'other_kind' },
        { targetId: randomUUID() },
        { payload: { note: '바꿈' } },
        { requestedBy: other.id },
        { requestReason: '다른 사유' },
        { requestedAt: new Date(0) },
      ]) {
        await expect(
          t.db.update(approvalRequests).set(set).where(eq(approvalRequests.id, row.id)),
        ).rejects.toSatisfy((e) => sqlState(e) === '23000');
      }
      await t.db
        .update(approvalRequests)
        .set(decision(decider.id, 'rejected'))
        .where(eq(approvalRequests.id, row.id));
      // Decided once: another decision, another decider or back to pending are all refused.
      for (const set of [
        decision(decider.id, 'approved'),
        decision(other.id, 'rejected'),
        { status: 'pending' as const, decidedBy: null, decisionReason: null, decidedAt: null },
      ]) {
        await expect(
          t.db.update(approvalRequests).set(set).where(eq(approvalRequests.id, row.id)),
        ).rejects.toSatisfy((e) => sqlState(e) === '23000');
      }
      expect(await t.db.select().from(approvalRequests)).toMatchObject([
        { status: 'rejected', decidedBy: decider.id, decisionReason: '결정 사유' },
      ]);
    });

    it('refuses a decision by an account that is not an admin as it decides, whoever writes it', async () => {
      // buddha_app keeps UPDATE: a write past ApprovalService must not make a member's (or a
      // revoked admin's) approval look like another admin's.
      const { user: requester } = await createUser(t.db, { role: 'admin' });
      const { user: member } = await createUser(t.db);
      const { user: revoked } = await createUser(t.db, { role: 'admin' });
      await t.db.update(profiles).set({ role: 'user' }).where(eq(profiles.userId, revoked.id));
      const row = await request(requester.id);
      for (const decider of [member.id, revoked.id]) {
        for (const status of ['approved', 'rejected'] as const) {
          await expect(
            t.db
              .update(approvalRequests)
              .set(decision(decider, status))
              .where(eq(approvalRequests.id, row.id)),
            `${decider} ${status}`,
          ).rejects.toSatisfy(
            (e) =>
              sqlState(e) === '23000' && errorMessage(e).includes('must be decided by an admin'),
          );
        }
      }
      expect(await t.db.select().from(approvalRequests)).toEqual([row]);
      // An admin's decision still goes through.
      const { user: decider } = await createUser(t.db, { role: 'admin' });
      await t.db
        .update(approvalRequests)
        .set(decision(decider.id))
        .where(eq(approvalRequests.id, row.id));
      expect(await t.db.select().from(approvalRequests)).toMatchObject([
        { status: 'approved', decidedBy: decider.id },
      ]);
    });

    it('reads the decider under the admin-roles lock, taken before the request row', async () => {
      const { user: requester } = await createUser(t.db, { role: 'admin' });
      const { user: decider } = await createUser(t.db, { role: 'admin' });
      const row = await request(requester.id);
      // A revoke of the decider in flight: it holds the admin-roles lock exclusively and has
      // written the role, not committed yet.
      let revoked!: () => void;
      const revoking = new Promise<void>((resolve) => (revoked = resolve));
      let commit!: () => void;
      const committing = new Promise<void>((resolve) => (commit = resolve));
      const revoke = t.db.transaction(async (tx) => {
        await lockAdminRoles(tx, 'exclusive');
        await tx.update(profiles).set({ role: 'user' }).where(eq(profiles.userId, decider.id));
        revoked();
        await committing;
      });
      await revoking;

      let settled = false;
      const deciding = t.db
        .update(approvalRequests)
        .set(decision(decider.id))
        .where(eq(approvalRequests.id, row.id))
        .then(
          () => undefined,
          (error: unknown) => error,
        )
        .finally(() => (settled = true));
      try {
        // The direct UPDATE waits on the role lock rather than reading the role the revoke has
        // not committed yet…
        let waiting = false;
        for (let attempt = 0; attempt < 250 && !waiting && !settled; attempt++) {
          const { rows } = await t.db.execute<{ waiting: number }>(sql`
            SELECT count(*)::int AS waiting FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid()
              AND wait_event_type = 'Lock' AND wait_event = 'advisory'
              AND query ILIKE '%approval_requests%'`);
          waiting = (rows[0]?.waiting ?? 0) > 0;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(waiting).toBe(true);
        // …and holds no lock on the request row meanwhile: the lock comes first, as in
        // ApprovalService, so a decision through the service is not blocked behind it.
        await t.db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT id FROM approval_requests WHERE id = ${row.id} FOR UPDATE NOWAIT`,
          );
        });
      } finally {
        commit();
        await revoke;
      }
      // Once the revoke commits, the decider is a member and the decision is refused.
      const error = await deciding;
      expect(sqlState(error)).toBe('23000');
      expect(errorMessage(error)).toContain('must be decided by an admin');
      expect(await t.db.select().from(approvalRequests)).toEqual([row]);
    });

    it('cannot DELETE a request', async () => {
      const { user: requester } = await createUser(t.db, { role: 'admin' });
      const row = await request(requester.id);
      await expect(
        t.db.delete(approvalRequests).where(eq(approvalRequests.id, row.id)),
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
            'balances', 'payments', 'phone_verifications', 'phone_verification_codes',
            'market_settlement_steps', 'release_settings',
            'approval_requests', 'market_watches', 'market_watch_events', 'market_searches',
            'market_search_terms', 'market_links')
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
      // Migration 0028 (#183): the real name changes in place and the row goes with the account;
      // a code's wrong entries and its use are counted in place, and old or unsent codes deleted.
      expect(privs('phone_verifications')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      expect(privs('phone_verification_codes')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      // Migration 0016: the worker updates a step's row in place.
      expect(privs('market_settlement_steps')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      // Migration 0020: a release setting is changed, never removed.
      expect(privs('release_settings')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
      // Migration 0021: a two-person request is decided in place, never removed.
      expect(privs('approval_requests')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
      // Migration 0023 (#89): an unwatch deletes the current row; the history is append-only.
      expect(privs('market_watches')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      expect(privs('market_watch_events')).toEqual(['INSERT', 'SELECT']);
      // Migration 0025 (#15): the member deletes a recorded search, one term or all of them; and
      // migration 0026 took UPDATE away — a recorded search is never changed in place, which is
      // what keeps market_search_terms exact. The term rows are written by the triggers, as
      // buddha_app, upsert included.
      expect(privs('market_searches')).toEqual(['DELETE', 'INSERT', 'SELECT']);
      expect(privs('market_search_terms')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
      // Migration 0027 (#65): an unlink deletes the pair's row; the history is admin_actions.
      expect(privs('market_links')).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
    });

    it('cannot UPDATE or DELETE a watch event, and refuses an action outside the list (#95)', async () => {
      const { user: u } = await createUser(t.db);
      const market = await createMarket(t.db);
      const { watch, event } = await createWatch(t.db, { userId: u.id, marketId: market.id });
      // The factory's pair shares one instant, as the API's transaction does.
      expect(event.createdAt.getTime()).toBe(watch.watchedAt.getTime());
      await expect(
        t.db
          .update(marketWatchEvents)
          .set({ action: 'unwatch' })
          .where(eq(marketWatchEvents.id, event.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
      await expect(
        t.db.delete(marketWatchEvents).where(eq(marketWatchEvents.id, event.id)),
      ).rejects.toSatisfy((e) => sqlState(e) === '42501');
      await expect(
        t.db
          .insert(marketWatchEvents)
          .values({ userId: u.id, marketId: market.id, action: 'favorite' }),
      ).rejects.toSatisfy((e) => sqlState(e) === '23514');
      // The current row goes with an unwatch, and a second row for one pair is refused.
      await expect(
        t.db.insert(marketWatches).values({ userId: u.id, marketId: market.id }),
      ).rejects.toSatisfy((e) => sqlState(e) === '23505');
      await t.db
        .delete(marketWatches)
        .where(and(eq(marketWatches.userId, u.id), eq(marketWatches.marketId, market.id)));
      expect(await t.db.select().from(marketWatches)).toEqual([]);
      expect(await t.db.select().from(marketWatchEvents)).toEqual([event]);
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
