import { randomUUID } from 'node:crypto';
import type { MarketResult } from '@buddha/shared';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  findLedgerAccount,
  ledgerKeys,
  lockCoin,
  lockLedgerAccounts,
  recordLedgerEntry,
  releaseCoin,
} from './ledger.js';
import { reconcileMarketSettlement, settleMarketPositions } from './market-settlement.js';
import { ledgerEntries, markets, positions, positionSettlements } from './schema/index.js';
import {
  closeAccount,
  createCorrectionRequest,
  createDispute,
  createMarket,
  createMarketPause,
  createModerationAction,
  createPosition,
  createProvisionalMarket,
  createUser,
  resolveMarketNow,
} from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import { closeTestMarket, createOrder, passMarketClose } from './test/orders.js';
import {
  balanceOf,
  fundMarketMakerFunds,
  ledgerAccountBalance,
  ledgerSupply,
  mintTestPairs,
  withLedgerGuardsOff,
} from './test/ledger.js';
import { clockTimestamp, lockMarket } from './tx-helpers.js';

describe.skipIf(!hasTestDb())('atomic market settlement (#126, integration)', () => {
  let t: TestDb;
  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  async function fixture(result: MarketResult = 'YES') {
    const market = await createMarket(t.db, {
      status: 'settling',
      resolvedResult: result,
      judgementVersion: null,
    });
    const yes = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
    const no = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
    await mintTestPairs(t.db, {
      marketId: market.id,
      yesHolderId: yes,
      noHolderId: no,
      qty: 3,
      yesPriceCoin: 60,
    });
    return { market, yes, no };
  }
  const run = (id: string) => t.db.transaction((tx) => settleMarketPositions(tx, id));
  const records = (id: string) =>
    t.db
      .select()
      .from(positionSettlements)
      .where(eq(positionSettlements.marketId, id))
      .orderBy(asc(positionSettlements.outcome));
  const payouts = (id: string) =>
    t.db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.marketId, id), eq(ledgerEntries.type, 'SETTLEMENT_PAYOUT')))
      .orderBy(asc(ledgerEntries.id));
  const holdings = (id: string) =>
    t.db
      .select()
      .from(positions)
      .where(eq(positions.marketId, id))
      .orderBy(asc(positions.userId), asc(positions.outcome));

  it.each(['YES', 'NO', 'VOID'] as const)(
    'settles legacy %s and preserves every positive claim',
    async (result) => {
      const { market, yes, no } = await fixture(result);
      const supply = await ledgerSupply(t.db);
      const done = await run(market.id);
      expect(done).toMatchObject({
        positions: 2,
        settledAccounts: 2,
        paidAccounts: result === 'VOID' ? 2 : 1,
        paidCoin: 300n,
      });
      const rows = await records(market.id);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        const expected = result === 'VOID' ? 150n : result === row.outcome ? 300n : 0n;
        expect(row).toMatchObject({
          judgementVersion: null,
          ruleVersion: null,
          result,
          qty: 3,
          payoutCoin: expected,
          settlementPnlCoin: expected - row.costBasisCoin,
          settledAt: done.at,
        });
        expect(row.ledgerEntryId === null).toBe(expected === 0n);
      }
      expect((await balanceOf(t.db, yes))!.availableCoin).toBe(
        820n + (result === 'VOID' ? 150n : result === 'YES' ? 300n : 0n),
      );
      expect((await balanceOf(t.db, no))!.availableCoin).toBe(
        880n + (result === 'VOID' ? 150n : result === 'NO' ? 300n : 0n),
      );
      for (const row of await holdings(market.id)) {
        expect(row).toMatchObject({ qty: 0, lockedQty: 0, costBasisCoin: 0n, settled: true });
      }
      for (const entry of await payouts(market.id))
        expect(entry.idempotencyKey).toContain(':legacy:');
      expect(
        (await ledgerAccountBalance(t.db, { kind: 'market_collateral', marketId: market.id }))!
          .availableCoin,
      ).toBe(0n);
      expect(await ledgerSupply(t.db)).toEqual(supply);
      expect((await run(market.id)).settlements).toEqual([]);
      expect(await records(market.id)).toEqual(rows);
      expect(
        await t.db.transaction((tx) => reconcileMarketSettlement(tx, market.id)),
      ).toMatchObject({ paidCoin: 300n, positions: 2 });
    },
  );

  it('closes zero holdings without recording them and keeps previous realized PnL', async () => {
    const { market } = await fixture('VOID');
    const empty = await createUser(t.db);
    await createPosition(t.db, {
      userId: empty.user.id,
      marketId: market.id,
      outcome: 'YES',
      qty: 0,
      costBasisCoin: 0n,
      realizedPnlCoin: 17n,
    });
    const done = await run(market.id);
    expect(done).toMatchObject({ positions: 3, settledAccounts: 3, paidAccounts: 2 });
    expect(await records(market.id)).toHaveLength(2);
    expect((await holdings(market.id)).find((row) => row.userId === empty.user.id)).toMatchObject({
      settled: true,
      qty: 0,
      realizedPnlCoin: 17n,
    });
  });

  it('pays the operating account into this market’s funds with no person event', async () => {
    const market = await createMarket(t.db, { status: 'settling', resolvedResult: 'VOID' });
    const person = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
    const bot = await fundMarketMakerFunds(t.db, market.id, 1_000n);
    await mintTestPairs(t.db, {
      marketId: market.id,
      yesHolderId: person,
      noHolderId: bot,
      qty: 2,
      yesPriceCoin: 70,
    });
    const done = await run(market.id);
    expect(done).toMatchObject({ paidAccounts: 2, paidCoin: 200n });
    expect(done.settlements.map((row) => row.position.userId)).toEqual([person]);
    expect(
      (await ledgerAccountBalance(t.db, { kind: 'market_maker_funds', marketId: market.id }))!
        .availableCoin,
    ).toBe(1_040n);
  });

  it('ignores a holder’s Coin locked for a different market', async () => {
    const { market, yes } = await fixture();
    await t.db.transaction((tx) => lockCoin(tx, { kind: 'user', userId: yes }, 100n));
    await run(market.id);
    expect((await balanceOf(t.db, yes))!.lockedCoin).toBe(100n);
  });

  it.each(['unheld', 'losing', 'done'] as const)(
    'refuses an orphan market maker Coin lock with %s contracts',
    async (phase) => {
      const market = await createMarket(t.db, { status: 'settling', resolvedResult: 'YES' });
      const person = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
      const bot = await fundMarketMakerFunds(t.db, market.id, 1_000n);
      const funds = { kind: 'market_maker_funds', marketId: market.id } as const;
      if (phase !== 'unheld') {
        await mintTestPairs(t.db, {
          marketId: market.id,
          yesHolderId: person,
          noHolderId: bot,
          qty: 2,
          yesPriceCoin: 70,
        });
      }
      if (phase === 'done') await run(market.id);
      await t.db.transaction((tx) => lockCoin(tx, funds, 1n));
      const before = {
        holdings: await holdings(market.id),
        payouts: await payouts(market.id),
        records: await records(market.id),
        person: await balanceOf(t.db, person),
        funds: await ledgerAccountBalance(t.db, funds),
      };
      const retry = () =>
        phase === 'done'
          ? t.db.transaction((tx) => reconcileMarketSettlement(tx, market.id))
          : run(market.id);
      await expect(retry()).rejects.toThrow('market maker Coin locks remain');
      expect(await holdings(market.id)).toEqual(before.holdings);
      expect(await payouts(market.id)).toEqual(before.payouts);
      expect(await records(market.id)).toEqual(before.records);
      expect(await balanceOf(t.db, person)).toEqual(before.person);
      expect(await ledgerAccountBalance(t.db, funds)).toEqual(before.funds);
      await t.db.transaction((tx) => releaseCoin(tx, funds, 1n));
      await expect(retry()).resolves.toMatchObject({ paidCoin: phase === 'unheld' ? 0n : 200n });
    },
  );

  it('pays a holder under an approved active account restriction', async () => {
    const { market, yes } = await fixture();
    const requester = (await createUser(t.db, { role: 'admin' })).user.id;
    const approver = (await createUser(t.db, { role: 'admin' })).user.id;
    const restriction = await createModerationAction(t.db, {
      userId: yes,
      createdBy: requester,
      approvedBy: approver,
      type: 'account_restriction',
      reason: 'multi_account',
      endsAt: new Date(Date.now() + 86_400_000),
    });
    expect(restriction).toMatchObject({ type: 'account_restriction', cancelledAt: null });
    const before = await balanceOf(t.db, yes);
    await expect(run(market.id)).resolves.toMatchObject({ paidAccounts: 1, paidCoin: 300n });
    expect((await balanceOf(t.db, yes))!.availableCoin).toBe(before!.availableCoin + 300n);
    expect((await records(market.id)).find((row) => row.userId === yes)).toMatchObject({
      qty: 3,
      payoutCoin: 300n,
      settlementPnlCoin: 120n,
    });
  });

  it.each(['YES', 'NO'] as const)(
    'refuses a closed positive %s holder, including a zero-payout loser',
    async (outcome) => {
      const { market, yes, no } = await fixture('YES');
      // The closure factory exercises the real forfeiture/anonymisation, but deliberately skips
      // the API's positive-contract refusal to represent an invalid legacy holding.
      const closed = outcome === 'YES' ? yes : no;
      await closeAccount(t.db, closed);
      const before = {
        holdings: await holdings(market.id),
        yes: await balanceOf(t.db, yes),
        no: await balanceOf(t.db, no),
      };
      await expect(run(market.id)).rejects.toThrow('a closed account still holds contracts');
      expect(await records(market.id)).toEqual([]);
      expect(await payouts(market.id)).toEqual([]);
      expect(await holdings(market.id)).toEqual(before.holdings);
      expect(await balanceOf(t.db, yes)).toEqual(before.yes);
      expect(await balanceOf(t.db, no)).toEqual(before.no);
    },
  );

  it('holds a market closed during a ledger failure even without a live order or position lock', async () => {
    const market = await createMarket(t.db);
    const yes = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
    const no = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
    await mintTestPairs(t.db, { marketId: market.id, yesHolderId: yes, noHolderId: no, qty: 2 });
    await createMarketPause(t.db, { marketId: market.id, reason: 'ledger_failure' });
    await passMarketClose(t.db, market.id);
    await closeTestMarket(t.db, market.id);
    await createProvisionalMarket(t.db, { marketId: market.id, result: 'YES' });
    await resolveMarketNow(t.db, market.id);
    await t.db.update(markets).set({ status: 'settling' }).where(eq(markets.id, market.id));
    const before = {
      holdings: await holdings(market.id),
      yes: await balanceOf(t.db, yes),
      no: await balanceOf(t.db, no),
    };
    expect(before.holdings.every((row) => row.lockedQty === 0)).toBe(true);
    await expect(run(market.id)).rejects.toThrow('ledger recovery approval is pending');
    expect(await holdings(market.id)).toEqual(before.holdings);
    expect(await balanceOf(t.db, yes)).toEqual(before.yes);
    expect(await balanceOf(t.db, no)).toEqual(before.no);
    expect(await payouts(market.id)).toEqual([]);
    expect(await records(market.id)).toEqual([]);
  });

  it.each(['pending', 'accepted', 'correction'] as const)(
    'reads the actual %s judgement hold even when the market mirrors are clear',
    async (hold) => {
      const { market } = await createProvisionalMarket(t.db, { result: 'YES' });
      const yes = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
      const no = (await createUser(t.db, { balanceCoin: 1_000n })).user.id;
      await mintTestPairs(t.db, { marketId: market.id, yesHolderId: yes, noHolderId: no, qty: 2 });
      if (hold === 'correction') {
        await createCorrectionRequest(t.db, { marketId: market.id, result: 'NO' });
      } else {
        await createDispute(t.db, { marketId: market.id, userId: yes, fill: false, status: hold });
      }
      // A broken transition skipped confirmationHold and cleared its display mirrors. The
      // settlement gate must consult the durable request/dispute, rather than trust those flags.
      await t.db
        .update(markets)
        .set({
          status: 'settling',
          resolvedAt: new Date(),
          disputeHoldCount: 0,
          correctionPending: false,
        })
        .where(eq(markets.id, market.id));
      const before = {
        holdings: await holdings(market.id),
        yes: await balanceOf(t.db, yes),
        no: await balanceOf(t.db, no),
      };
      await expect(run(market.id)).rejects.toThrow('judgement review is still held');
      expect(await holdings(market.id)).toEqual(before.holdings);
      expect(await balanceOf(t.db, yes)).toEqual(before.yes);
      expect(await balanceOf(t.db, no)).toEqual(before.no);
      expect(await payouts(market.id)).toEqual([]);
      expect(await records(market.id)).toEqual([]);
    },
  );

  it('refuses live orders and contract locks before making any payout', async () => {
    const first = await fixture();
    await createOrder(t.db, { marketId: first.market.id, userId: first.yes, status: 'open' });
    await expect(run(first.market.id)).rejects.toThrow('live orders remain');
    expect(await payouts(first.market.id)).toEqual([]);
    const second = await fixture();
    await t.db
      .update(positions)
      .set({ lockedQty: 1 })
      .where(and(eq(positions.marketId, second.market.id), eq(positions.userId, second.yes)));
    await expect(run(second.market.id)).rejects.toThrow('contract locks remain');
    expect(await records(second.market.id)).toEqual([]);
  });

  it('refuses supply missing either side, and excess or short collateral', async () => {
    const one = await fixture();
    await t.db
      .update(positions)
      .set({ qty: 2 })
      .where(and(eq(positions.marketId, one.market.id), eq(positions.userId, one.yes)));
    await expect(run(one.market.id)).rejects.toThrow('contract supply does not match');
    for (const extra of [-1n, 1n]) {
      const { market } = await fixture();
      const account = await findLedgerAccount(t.db, {
        kind: 'market_collateral',
        marketId: market.id,
      });
      await withLedgerGuardsOff(async (client) => {
        await client.query(
          'UPDATE balances SET available_coin = available_coin + $1 WHERE account_id = $2',
          [String(extra), account!.id],
        );
      });
      await expect(run(market.id)).rejects.toThrow('collateral does not match');
      expect(await payouts(market.id)).toEqual([]);
    }
  });

  it('rolls back every payout and record if a later recipient has a broken ledger copy', async () => {
    const { market } = await fixture('VOID');
    const before = await holdings(market.id);
    const last = before.at(-1)!;
    const account = await findLedgerAccount(t.db, { kind: 'user', userId: last.userId });
    await withLedgerGuardsOff(async (client) => {
      await client.query(
        'UPDATE balances SET ledger_coin = ledger_coin + 1 WHERE account_id = $1',
        [account!.id],
      );
    });
    await expect(run(market.id)).rejects.toThrow();
    expect(await holdings(market.id)).toEqual(before);
    expect(await records(market.id)).toEqual([]);
    expect(await payouts(market.id)).toEqual([]);
    await withLedgerGuardsOff(async (client) => {
      await client.query(
        'UPDATE balances SET ledger_coin = ledger_coin - 1 WHERE account_id = $1',
        [account!.id],
      );
    });
    expect(await run(market.id)).toMatchObject({ paidAccounts: 2, paidCoin: 300n });
    expect(await payouts(market.id)).toHaveLength(2);
  });

  it('reconciles even after a completed payout and rejects tampered retired holdings', async () => {
    const { market, yes } = await fixture();
    await run(market.id);
    await t.db
      .update(positions)
      .set({ realizedPnlCoin: 999n })
      .where(and(eq(positions.marketId, market.id), eq(positions.userId, yes)));
    await expect(
      t.db.transaction((tx) => reconcileMarketSettlement(tx, market.id)),
    ).rejects.toThrow('settlement record does not match');
    expect(await payouts(market.id)).toHaveLength(1);
  });

  it('reconciles the actual collateral ledger when a done retry has matching zero copies', async () => {
    const { market } = await fixture();
    await run(market.id);
    const before = { payouts: await payouts(market.id), records: await records(market.id) };
    const collateral = { kind: 'market_collateral', marketId: market.id } as const;
    const account = await findLedgerAccount(t.db, collateral);
    const requestId = randomUUID();
    await t.db.transaction(async (tx) => {
      await lockLedgerAccounts(tx, [{ kind: 'treasury' }, collateral]);
      await recordLedgerEntry(tx, {
        type: 'TREASURY_MINT',
        amountCoin: 1n,
        from: null,
        to: { kind: 'treasury' },
        refType: 'approval_request',
        refId: requestId,
        idempotencyKey: ledgerKeys.approvalRequest(requestId),
      });
      await recordLedgerEntry(tx, {
        type: 'RECONCILIATION_CORRECTION',
        amountCoin: 1n,
        from: { kind: 'treasury' },
        to: collateral,
        refType: 'audit_failure',
        refId: randomUUID(),
        idempotencyKey: ledgerKeys.approvalRequest(requestId),
      });
    });
    // An owner-level fault changes both copies back to the expected zero. No normal payout is
    // due, so no write/deferred ledger guard will run during the final reconciliation.
    await withLedgerGuardsOff(async (client) => {
      await client.query(
        'UPDATE balances SET available_coin = 0, ledger_coin = 0 WHERE account_id = $1',
        [account!.id],
      );
    });
    await expect(
      t.db.transaction((tx) => reconcileMarketSettlement(tx, market.id)),
    ).rejects.toThrow('collateral ledger does not match');
    expect(await payouts(market.id)).toEqual(before.payouts);
    expect(await records(market.id)).toEqual(before.records);
    await withLedgerGuardsOff(async (client) => {
      await client.query(
        'UPDATE balances SET available_coin = 1, ledger_coin = 1 WHERE account_id = $1',
        [account!.id],
      );
    });
    const correctionId = randomUUID();
    await t.db.transaction((tx) =>
      recordLedgerEntry(tx, {
        type: 'RECONCILIATION_CORRECTION',
        amountCoin: 1n,
        from: collateral,
        to: { kind: 'treasury' },
        refType: 'audit_failure',
        refId: randomUUID(),
        idempotencyKey: ledgerKeys.approvalRequest(correctionId),
      }),
    );
    await expect(
      t.db.transaction((tx) => reconcileMarketSettlement(tx, market.id)),
    ).resolves.toMatchObject({ paidCoin: 300n });
    expect(await payouts(market.id)).toEqual(before.payouts);
    expect(await records(market.id)).toEqual(before.records);
  });

  it('serializes concurrent runs and pays each claim once', async () => {
    const { market } = await fixture('VOID');
    const results = await Promise.all([run(market.id), run(market.id)]);
    expect(results.map((row) => row.settlements.length).sort()).toEqual([0, 2]);
    expect(await payouts(market.id)).toHaveLength(2);
    expect(await records(market.id)).toHaveLength(2);
  });

  it('preserves a completed claim and finishes only the remaining position', async () => {
    const { market, yes } = await fixture();
    // A durable partial run: one claim and its retirement committed together. The normal worker
    // commits the whole market, but recovery still recognizes a complete earlier claim.
    await t.db.transaction(async (tx) => {
      await lockMarket(tx, market.id);
      const [row] = await tx
        .select()
        .from(positions)
        .where(
          and(
            eq(positions.marketId, market.id),
            eq(positions.userId, yes),
            eq(positions.outcome, 'YES'),
          ),
        )
        .for('update');
      const at = await clockTimestamp(tx);
      const paid = await recordLedgerEntry(tx, {
        type: 'SETTLEMENT_PAYOUT',
        amountCoin: 300n,
        from: { kind: 'market_collateral', marketId: market.id },
        to: { kind: 'user', userId: yes },
        refType: 'market',
        refId: market.id,
        idempotencyKey: ledgerKeys.settlement(market.id, null, yes, 'YES'),
        at,
      });
      if (paid.outcome !== 'recorded') throw new Error('new payout');
      await tx.insert(positionSettlements).values({
        marketId: market.id,
        userId: yes,
        outcome: 'YES',
        judgementVersion: null,
        ruleVersion: null,
        result: 'YES',
        qty: 3,
        costBasisCoin: row!.costBasisCoin,
        realizedPnlBeforeCoin: row!.realizedPnlCoin,
        payoutPerContractCoin: 100,
        payoutCoin: 300n,
        settlementPnlCoin: 300n - row!.costBasisCoin,
        ledgerEntryId: paid.entry.id,
        settledAt: at,
      });
      await tx
        .update(positions)
        .set({
          qty: 0,
          costBasisCoin: 0n,
          settled: true,
          realizedPnlCoin: row!.realizedPnlCoin + 300n - row!.costBasisCoin,
          updatedAt: at,
        })
        .where(
          and(
            eq(positions.marketId, market.id),
            eq(positions.userId, yes),
            eq(positions.outcome, 'YES'),
          ),
        );
    });
    const before = await records(market.id);
    const paidBefore = await payouts(market.id);
    const done = await run(market.id);
    expect(done).toMatchObject({ positions: 2, paidAccounts: 1, paidCoin: 300n });
    expect(done.settlements).toHaveLength(1);
    expect(await payouts(market.id)).toEqual(paidBefore);
    expect(await records(market.id)).toEqual(expect.arrayContaining(before));
    expect(await records(market.id)).toHaveLength(2);
  });

  it('keeps versioned keys unchanged and reserves a separate legacy key', () => {
    expect(ledgerKeys.settlement('m', 2, 'u', 'YES')).toBe('m:2:u:YES');
    expect(ledgerKeys.settlement('m', null, 'u', 'YES')).toBe('m:legacy:u:YES');
  });

  it('refuses a missing final judgement, an absent result and a market outside SETTLING', async () => {
    const { market } = await fixture();
    await t.db.update(markets).set({ judgementVersion: 1 }).where(eq(markets.id, market.id));
    await expect(run(market.id)).rejects.toThrow('approved judgement does not match');
    await t.db
      .update(markets)
      .set({ judgementVersion: null, resolvedResult: null })
      .where(eq(markets.id, market.id));
    await expect(run(market.id)).rejects.toThrow('result is missing');
    await t.db.update(markets).set({ status: 'cancelled' }).where(eq(markets.id, market.id));
    await expect(run(market.id)).rejects.toThrow('market is not settling');
  });
});
