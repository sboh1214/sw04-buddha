/**
 * ledger.audit integration test (PLAN M2 AC 5, PLAN 5.6; #116's ledger accounts) against the
 * docker `test` profile. Skips when TEST_* are unset, exactly like the packages/db suite it
 * borrows the harness from. Since migration 0060 the database refuses a balance total that moves
 * apart from its ledger total, and at COMMIT a ledger total that is not its ledger's, so every
 * mismatch here is made the one way a test may break the books on purpose: `withLedgerGuardsOff`
 * (the migrate role, the guards switched off inside one transaction).
 */
import {
  applyTradeFill,
  burnMarketMakerPairs,
  findLedgerAccount,
  lockForOrder,
  lockOrderHolders,
  schema,
  type LedgerAccountRef,
} from '@buddha/db';
import {
  closeAccount,
  connectTestDb,
  createFillRecord,
  createMarket,
  createMarketMakerAccount,
  createStartGrant,
  createUser,
  fundMarketMakerFunds,
  hasTestDb,
  ledgerAccountBalance,
  ledgerSupply,
  mintTestPairs,
  spendCoin,
  withLedgerGuardsOff,
  type TestDb,
} from '@buddha/db/test';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LEDGER_AUDIT_FAILURE_KIND, runLedgerAudit } from './ledger-audit.js';

describe.skipIf(!hasTestDb())('ledger.audit (integration)', () => {
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

  async function failures() {
    return t.db.select().from(schema.auditFailures);
  }

  /** The id of the ledger account `ref` names (it must exist). */
  async function accountId(ref: LedgerAccountRef): Promise<number> {
    const account = await findLedgerAccount(t.db, ref);
    if (!account) throw new Error(`no ledger account ${JSON.stringify(ref)}`);
    return account.id;
  }

  /** Adds `deltaCoin` to a ledger account's available Coin with no event (the guard off). */
  async function tamper(ref: LedgerAccountRef, deltaCoin: bigint) {
    const id = await accountId(ref);
    await withLedgerGuardsOff((client) =>
      client.query(
        'update balances set available_coin = available_coin + $1 where account_id = $2',
        [deltaCoin.toString(), id],
      ),
    );
  }

  it('reports no mismatch while every balance matches its ledger', async () => {
    // A START_GRANT for the first; the second has a zero account and no event.
    await createUser(t.db, { balanceCoin: 10_000n });
    await createUser(t.db);

    const result = await runLedgerAudit(t.db);
    expect(result.checked).toBe(2);
    expect(result.mismatches).toEqual([]);
    expect(result.recorded).toBe(0);
    expect(await failures()).toHaveLength(0);
  });

  it('finds a closed account balanced: its forfeiture took the balance to 0 by an entry (#140)', async () => {
    // ADR-0069 decision 1 #57-16: the Coin left is forfeited as '탈퇴 소멸', never overwritten, so
    // the account's ledger still sums to its balance — now 0 — and the audit has nothing to say.
    const { user } = await createUser(t.db);
    await createStartGrant(t.db, { userId: user.id, amountCoin: 3_000n });
    await closeAccount(t.db, user.id);
    const [balance] = await t.db
      .select()
      .from(schema.balances)
      .where(eq(schema.balances.userId, user.id));
    expect(balance).toMatchObject({ availableCoin: 0n, lockedCoin: 0n });

    const result = await runLedgerAudit(t.db);
    expect(result.checked).toBe(1);
    expect(result.mismatches).toEqual([]);
    expect(await failures()).toHaveLength(0);
  });

  it('records one audit_failures row per account whose balance was changed behind the ledger', async () => {
    const { user } = await createUser(t.db, { balanceCoin: 10_000n });
    const untouched = await createUser(t.db, { balanceCoin: 5_000n });
    const id = await accountId({ kind: 'user', userId: user.id });

    // Exactly what the AC asks for: move the balance without a ledger entry. The database
    // refuses that at COMMIT since 0060 (and buddha_app may change only the amounts), so this
    // takes an owner-level change — what the job is the backstop for.
    await tamper({ kind: 'user', userId: user.id }, 1_500n);

    const result = await runLedgerAudit(t.db);
    expect(result.checked).toBe(2);
    expect(result.mismatches).toEqual([
      {
        ledgerAccountId: id,
        kind: 'user',
        userId: user.id,
        marketId: null,
        accountMissing: false,
        balanceMissing: false,
        availableCoin: 11_500n,
        lockedCoin: 0n,
        ledgerCoin: 10_000n,
        ledgerSumCoin: 10_000n,
        differenceCoin: 1_500n,
        ledgerCoinMismatch: false,
      },
    ]);

    const rows = await failures();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: LEDGER_AUDIT_FAILURE_KIND,
      payload: {
        ledgerAccountId: id,
        kind: 'user',
        userId: user.id,
        marketId: null,
        accountMissing: false,
        balanceMissing: false,
        availableCoin: '11500',
        lockedCoin: '0',
        ledgerCoin: '10000',
        ledgerSumCoin: '10000',
        differenceCoin: '1500',
        ledgerCoinMismatch: false,
      },
    });

    // Re-running is safe and keeps reporting the same account until it is fixed.
    const again = await runLedgerAudit(t.db);
    expect(again.mismatches.map((m) => m.userId)).toEqual([user.id]);
    expect(await failures()).toHaveLength(2);

    // The other account was never touched, and the audit never moves money itself.
    const [row] = await t.db
      .select()
      .from(schema.balances)
      .where(eq(schema.balances.userId, untouched.user.id));
    expect(row?.availableCoin).toBe(5_000n);
  });

  it("checks the system accounts too: the treasury, a market's collateral and its 마켓메이커 자금 (#116)", async () => {
    const market = await createMarket(t.db, { status: 'open' });
    // The treasury mints 1,000 and allocates all of it to the market's 마켓메이커 자금; a person
    // puts 300 into the market's collateral.
    await fundMarketMakerFunds(t.db, market.id, 1_000n);
    const { user } = await createUser(t.db, { balanceCoin: 2_000n });
    await spendCoin(t.db, user.id, 300n, { marketId: market.id });
    const treasury: LedgerAccountRef = { kind: 'treasury' };
    const collateral: LedgerAccountRef = { kind: 'market_collateral', marketId: market.id };
    const funds: LedgerAccountRef = { kind: 'market_maker_funds', marketId: market.id };
    expect((await runLedgerAudit(t.db)).mismatches).toEqual([]);

    await tamper(treasury, 5n);
    await tamper(collateral, -100n);
    await tamper(funds, 7n);

    const result = await runLedgerAudit(t.db);
    // The person, the market's creator and the three system accounts; the 운영 마켓메이커 has no
    // ledger account.
    expect(result.checked).toBe(5);
    const expected = [
      {
        ledgerAccountId: await accountId(treasury),
        kind: 'treasury',
        userId: null,
        marketId: null,
        availableCoin: 5n,
        ledgerCoin: 0n,
        ledgerSumCoin: 0n,
        differenceCoin: 5n,
      },
      {
        ledgerAccountId: await accountId(funds),
        kind: 'market_maker_funds',
        userId: null,
        marketId: market.id,
        availableCoin: 1_007n,
        ledgerCoin: 1_000n,
        ledgerSumCoin: 1_000n,
        differenceCoin: 7n,
      },
      {
        ledgerAccountId: await accountId(collateral),
        kind: 'market_collateral',
        userId: null,
        marketId: market.id,
        availableCoin: 200n,
        ledgerCoin: 300n,
        ledgerSumCoin: 300n,
        differenceCoin: -100n,
      },
    ].map((mismatch) => ({
      ...mismatch,
      accountMissing: false,
      balanceMissing: false,
      lockedCoin: 0n,
      ledgerCoinMismatch: false,
    }));
    expect(result.mismatches).toEqual(
      expected.sort((a, b) => a.ledgerAccountId - b.ledgerAccountId),
    );
    expect(result.recorded).toBe(3);
    // The 마켓메이커 자금's owner is the 운영 마켓메이커, but the record names no owner of it.
    expect((await failures()).map((row) => row.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'market_maker_funds', userId: null, marketId: market.id }),
      ]),
    );
  });

  it('keeps reporting an account whose total left its ledger while it takes its events (10항)', async () => {
    // ADR-0107 결정 2 #73 10항: an account mismatch refuses that account's new orders only (#93)
    // — its payouts, grants and fills still land, moving its buckets and its ledger total
    // together (`recordLedgerEntry`), so its difference stays and the audit names it again.
    const { user } = await createUser(t.db);
    await tamper({ kind: 'user', userId: user.id }, 40n);
    await createStartGrant(t.db, { userId: user.id, amountCoin: 1_000n });
    await spendCoin(t.db, user.id, 100n);
    const result = await runLedgerAudit(t.db);
    expect(result.mismatches).toEqual([
      expect.objectContaining({
        userId: user.id,
        availableCoin: 940n,
        ledgerCoin: 900n,
        ledgerSumCoin: 900n,
        differenceCoin: 40n,
        ledgerCoinMismatch: false,
      }),
    ]);
  });

  it('counts locked Coin in an account’s total: a lock is no mismatch, a lock changed alone is', async () => {
    // An order's lock (#118) moves Coin from available to locked with no event, the total kept
    // (migration 0060 lets buddha_app do it): the account's total is available + locked, and the
    // difference the audit records counts both buckets.
    const { user } = await createUser(t.db, { balanceCoin: 1_000n });
    const id = await accountId({ kind: 'user', userId: user.id });
    await t.db
      .update(schema.balances)
      .set({ availableCoin: 940n, lockedCoin: 60n })
      .where(eq(schema.balances.accountId, id));
    expect((await runLedgerAudit(t.db)).mismatches).toEqual([]);
    await withLedgerGuardsOff((client) =>
      client.query('update balances set locked_coin = locked_coin + 7 where account_id = $1', [id]),
    );
    const result = await runLedgerAudit(t.db);
    expect(result.mismatches).toEqual([
      expect.objectContaining({
        ledgerAccountId: id,
        availableCoin: 940n,
        lockedCoin: 67n,
        ledgerCoin: 1_000n,
        ledgerSumCoin: 1_000n,
        differenceCoin: 7n,
        ledgerCoinMismatch: false,
      }),
    ]);
    expect((await failures())[0]).toMatchObject({
      payload: { lockedCoin: '67', differenceCoin: '7' },
    });
  });

  it("reports a balance row's ledger total that left the ledger, apart from its buckets", async () => {
    // `ledger_coin` is the copy every event moves and the database checks at COMMIT; changed
    // around both (the migrate role, the guards off) it no longer says what the ledger does,
    // even while the buckets still do.
    const { user } = await createUser(t.db, { balanceCoin: 1_000n });
    const id = await accountId({ kind: 'user', userId: user.id });
    await withLedgerGuardsOff((client) =>
      client.query('update balances set ledger_coin = ledger_coin + 3 where account_id = $1', [id]),
    );
    const result = await runLedgerAudit(t.db);
    expect(result.mismatches).toEqual([
      {
        ledgerAccountId: id,
        kind: 'user',
        userId: user.id,
        marketId: null,
        accountMissing: false,
        balanceMissing: false,
        availableCoin: 1_000n,
        lockedCoin: 0n,
        ledgerCoin: 1_003n,
        ledgerSumCoin: 1_000n,
        differenceCoin: 0n,
        ledgerCoinMismatch: true,
      },
    ]);
    expect((await failures())[0]).toMatchObject({
      payload: { ledgerCoin: '1003', ledgerSumCoin: '1000', ledgerCoinMismatch: true },
    });
  });

  it('reports an account whose balance row is gone instead of losing it', async () => {
    // Driven from `ledger_accounts`, not from `balances`: an account with no balance row would
    // otherwise simply vanish — no mismatch AND `checked` one short, while the job logged
    // "clean". buddha_app holds no DELETE of balances since 0060; the migrate role still can.
    const { user } = await createUser(t.db, { balanceCoin: 10_000n });
    const untouched = await createUser(t.db, { balanceCoin: 5_000n });
    const id = await accountId({ kind: 'user', userId: user.id });
    await withLedgerGuardsOff((client) =>
      client.query('delete from balances where account_id = $1', [id]),
    );

    const result = await runLedgerAudit(t.db);
    expect(result.checked).toBe(2); // driven from ledger_accounts, so the orphan is still counted
    expect(result.mismatches).toEqual([
      {
        ledgerAccountId: id,
        kind: 'user',
        userId: user.id,
        marketId: null,
        accountMissing: false,
        balanceMissing: true,
        availableCoin: 0n,
        lockedCoin: 0n,
        ledgerCoin: 0n,
        ledgerSumCoin: 10_000n,
        differenceCoin: -10_000n,
        ledgerCoinMismatch: true,
      },
    ]);

    const [row] = await failures();
    expect(row).toMatchObject({
      kind: LEDGER_AUDIT_FAILURE_KIND,
      payload: { userId: user.id, balanceMissing: true, ledgerSumCoin: '10000' },
    });

    // The healthy account is untouched and not flagged.
    const [ok] = await t.db
      .select()
      .from(schema.balances)
      .where(eq(schema.balances.userId, untouched.user.id));
    expect(ok?.availableCoin).toBe(5_000n);
  });

  it("reports a person's account that has no user ledger account at all (#116)", async () => {
    // The "user" trigger makes one with every person's account (0060); one that lost it can be
    // credited nothing. The ledger account is a permanent record, so only an owner-level change
    // with its trigger off takes it away.
    const { user } = await createUser(t.db);
    await createUser(t.db);
    await withLedgerGuardsOff(async (client) => {
      await client.query('alter table ledger_accounts disable trigger ledger_accounts_check');
      await client.query('delete from balances where user_id = $1', [user.id]);
      await client.query("delete from ledger_accounts where kind = 'user' and owner_id = $1", [
        user.id,
      ]);
      await client.query('alter table ledger_accounts enable trigger ledger_accounts_check');
    });

    const result = await runLedgerAudit(t.db);
    expect(result.checked).toBe(2); // the other's ledger account and this missing one
    expect(result.mismatches).toEqual([
      {
        ledgerAccountId: null,
        kind: 'user',
        userId: user.id,
        marketId: null,
        accountMissing: true,
        balanceMissing: true,
        availableCoin: 0n,
        lockedCoin: 0n,
        ledgerCoin: 0n,
        ledgerSumCoin: 0n,
        differenceCoin: 0n,
        ledgerCoinMismatch: false,
      },
    ]);
    expect((await failures())[0]).toMatchObject({
      payload: { ledgerAccountId: null, userId: user.id, accountMissing: true },
    });
  });

  it('counts an account with no ledger entries and a zero balance as consistent', async () => {
    // Every new account until its start grant is paid (#70).
    await createUser(t.db);
    // And the 운영 마켓메이커 account (#115): no ledger account of its own (#116), so nothing to
    // check, and not reported as missing one — it is not a person's.
    await createMarketMakerAccount(t.db);
    const result = await runLedgerAudit(t.db);
    expect(result).toMatchObject({ checked: 1, recorded: 0 });
  });

  it('reports such an account once its balance row is gone: 0 against 0 is not enough', async () => {
    const { user } = await createUser(t.db);
    const id = await accountId({ kind: 'user', userId: user.id });
    await withLedgerGuardsOff((client) =>
      client.query('delete from balances where account_id = $1', [id]),
    );
    const result = await runLedgerAudit(t.db);
    expect(result.mismatches).toEqual([
      {
        ledgerAccountId: id,
        kind: 'user',
        userId: user.id,
        marketId: null,
        accountMissing: false,
        balanceMissing: true,
        availableCoin: 0n,
        lockedCoin: 0n,
        ledgerCoin: 0n,
        ledgerSumCoin: 0n,
        differenceCoin: 0n,
        ledgerCoinMismatch: false,
      },
    ]);
  });

  it('balances a start grant like any other entry (#70)', async () => {
    const { user } = await createUser(t.db);
    await createStartGrant(t.db, { userId: user.id, amountCoin: 10_000n });
    const result = await runLedgerAudit(t.db);
    expect(result).toMatchObject({ checked: 1, recorded: 0 });
  });

  it('finds a clean mixed ledger clean: grants, a treasury, pairs, a fill, a burn, live locks (#116, #118)', async () => {
    const market = await createMarket(t.db, { status: 'open' });
    const maker = await fundMarketMakerFunds(t.db, market.id, 5_000n);
    const alice = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    const bob = (await createUser(t.db, { balanceCoin: 10_000n })).user.id;
    // Two people pair up, and each pairs with the 운영 마켓메이커 (its 마켓메이커 자금 pays).
    await mintTestPairs(t.db, { marketId: market.id, yesHolderId: alice, noHolderId: bob, qty: 3 });
    await mintTestPairs(t.db, {
      marketId: market.id,
      yesHolderId: maker,
      noHolderId: alice,
      qty: 2,
      yesPriceCoin: 40,
    });
    await mintTestPairs(t.db, {
      marketId: market.id,
      yesHolderId: bob,
      noHolderId: maker,
      qty: 1,
      yesPriceCoin: 70,
    });
    const collateral: LedgerAccountRef = { kind: 'market_collateral', marketId: market.id };
    expect((await ledgerAccountBalance(t.db, collateral))?.availableCoin).toBe(600n); // 6 pairs

    // #118's other moves: alice sells bob a YES at 60 from her sell lock, bob's buy limit 65
    // giving 5 back (TRADE_FILL); the 운영 마켓메이커 burns its one pair back into its 마켓메이커
    // 자금 (PAIR_BURN_RETURN); and alice keeps a buy lock of 300 and a sell lock of one YES — no
    // event, so the audit counts both buckets and finds nothing.
    // The fill's record first (#119: migration 0062 binds its TRADE_FILL to it).
    const { fill } = await createFillRecord(t.db, {
      marketId: market.id,
      incomingOwnerId: bob,
      restingOwnerId: alice,
      kind: 'trade',
      priceCoin: 60,
    });
    await t.db.transaction(async (tx) => {
      // Every account the processing touches first, ascending (ADR-0110 결정 4).
      await lockOrderHolders(tx, market.id, [alice, bob, maker]);
      const lock = { marketId: market.id, ownerId: alice };
      await lockForOrder(tx, { ...lock, lock: { kind: 'contracts', outcome: 'YES', qty: 2 } });
      await lockForOrder(tx, { ...lock, ownerId: bob, lock: { kind: 'coin', amountCoin: 65n } });
      await applyTradeFill(tx, {
        marketId: market.id,
        fillId: String(fill.id),
        outcome: 'YES',
        qty: 1,
        priceCoin: 60,
        buyer: { ownerId: bob, limitPriceCoin: 65 },
        sellerId: alice,
      });
      await lockForOrder(tx, { ...lock, lock: { kind: 'coin', amountCoin: 300n } });
      const burned = await burnMarketMakerPairs(tx, {
        marketId: market.id,
        burnId: 'audit-burn',
        qty: 1,
      });
      expect(burned.outcome).toBe('burned');
    });
    expect((await ledgerAccountBalance(t.db, collateral))?.availableCoin).toBe(500n);
    expect(await ledgerAccountBalance(t.db, { kind: 'user', userId: alice })).toMatchObject({
      lockedCoin: 300n,
    });
    expect(await ledgerAccountBalance(t.db, { kind: 'user', userId: bob })).toMatchObject({
      lockedCoin: 0n,
    });

    const result = await runLedgerAudit(t.db);
    // alice, bob, the market's creator, the treasury, the collateral, the 마켓메이커 자금.
    expect(result).toMatchObject({ checked: 6, mismatches: [], recorded: 0 });
    const supply = await ledgerSupply(t.db);
    expect(supply.heldCoin).toBe(supply.mintedCoin - supply.burnedCoin);
  });

  it('records every mismatch when they span more than one INSERT chunk', async () => {
    // One multi-row INSERT of every mismatch dies at 32,768 rows (Postgres counts bind
    // parameters in an int16, and each row binds two). Driving the chunk size down to 2 runs
    // the same loop over five accounts instead of thirty-three thousand.
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const { user } = await createUser(t.db, { balanceCoin: 1_000n });
      ids.push(user.id);
    }
    await withLedgerGuardsOff((client) =>
      client.query('update balances set available_coin = available_coin + 1'),
    );

    const result = await runLedgerAudit(t.db, { insertChunkSize: 2 });
    expect(result.checked).toBe(5);
    expect(result.recorded).toBe(5);
    expect(result.mismatches.map((m) => m.userId).sort()).toEqual([...ids].sort());
    expect(result.mismatches.every((m) => m.differenceCoin === 1n)).toBe(true);

    const rows = await failures();
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => (row.payload as { userId: string }).userId).sort()).toEqual(
      [...ids].sort(),
    );
    // Three statements, one transaction: the rows of a run still share one `created_at`, the
    // property that tells this run's report from tomorrow's. Autocommitted chunks would not.
    expect(new Set(rows.map((row) => row.createdAt.getTime())).size).toBe(1);
  });

  it('refuses a chunk size that could not make progress', async () => {
    await expect(runLedgerAudit(t.db, { insertChunkSize: 0 })).rejects.toThrow(RangeError);
  });
});
