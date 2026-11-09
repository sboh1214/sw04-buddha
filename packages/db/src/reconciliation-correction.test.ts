import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyReconciliationCorrection,
  previewReconciliationCorrections,
} from './reconciliation-correction.js';
import {
  runAccountReconciliation,
  runMarketReconciliation,
  runSupplyReconciliation,
} from './reconciliation-audit.js';
import { findLedgerAccount, recordLedgerEntry } from './ledger.js';
import {
  approvalRequests,
  balances,
  ledgerEntries,
  positions,
  profiles,
  reconciliationCorrections,
  reconciliationHolds,
} from './schema/index.js';
import { closeAccount, createApprovalRequest, createMarket, createUser } from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import {
  damageActualCoinForTest,
  fundTestTreasury,
  ledgerSupply,
  mintTestPairs,
  recordLegacyCorrectionForTest,
  withLedgerGuardsOff,
} from './test/ledger.js';

describe.skipIf(!hasTestDb())('approved Coin correction (#93)', () => {
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
  async function incident(delta: bigint) {
    const member = await createUser(t.db, { balanceCoin: 100n });
    const requester = (await createUser(t.db, { role: 'admin' })).user.id;
    const approver = (await createUser(t.db, { role: 'admin' })).user.id;
    const account = (await findLedgerAccount(t.db, { kind: 'user', userId: member.user.id }))!;
    await damageActualCoinForTest(account.id, delta);
    const audit = await t.db.transaction((tx) =>
      runAccountReconciliation(tx, { userId: member.user.id }, { source: 'manual' }),
    );
    const [candidate] = await t.db.transaction((tx) =>
      previewReconciliationCorrections(tx, audit.result.id),
    );
    expect(candidate).toBeDefined();
    const request = await createApprovalRequest(t.db, {
      kind: 'reconciliation_correction',
      targetType: 'ledger_account',
      targetId: String(account.id),
      requestedBy: requester,
      payload: {
        failureResultId: String(audit.result.id),
        candidate: candidate!,
        userReason: '부족한 장부를 바로잡았습니다.',
      },
    });
    return { member, requester, approver, account, audit, candidate: candidate!, request };
  }
  async function approve(i: Awaited<ReturnType<typeof incident>>) {
    return t.db.transaction(async (tx) => {
      await tx
        .update(approvalRequests)
        .set({
          status: 'approved',
          decidedBy: i.approver,
          decisionReason: '검증 완료',
          decidedAt: new Date(),
        })
        .where(eq(approvalRequests.id, i.request.id));
      return applyReconciliationCorrection(tx, {
        approvalId: i.request.id,
        requestedBy: i.requester,
        approverId: i.approver,
      });
    });
  }
  it('restores actual 90 to ledger 100 without transfer or new minted supply and retains the hold', async () => {
    const i = await incident(-10n);
    const before = await ledgerSupply(t.db);
    const beforeEntries = await t.db.select().from(ledgerEntries);
    expect(i.candidate).toMatchObject({
      mode: 'restore_actual',
      amountCoin: '10',
      balanceDeltaCoin: '10',
    });
    const result = await approve(i);
    expect(result.balance).toMatchObject({ availableCoin: 100n, lockedCoin: 0n, ledgerCoin: 100n });
    expect(result.correction.ledgerEntryId).toBeNull();
    expect(await t.db.select().from(ledgerEntries)).toEqual(beforeEntries);
    const after = await ledgerSupply(t.db);
    expect(after).toEqual({ ...before, heldCoin: before.heldCoin + 10n });
    expect(after.heldCoin).toBe(after.mintedCoin - after.burnedCoin);
    const supply = await t.db.transaction((tx) =>
      runSupplyReconciliation(tx, { source: 'manual' }),
    );
    expect(supply.result.passed).toBe(true);
    expect((await t.db.select().from(reconciliationHolds))[0]!.recoveredAt).toBeNull();
    const again = await t.db.transaction((tx) =>
      applyReconciliationCorrection(tx, {
        approvalId: i.request.id,
        requestedBy: i.requester,
        approverId: i.approver,
      }),
    );
    expect(again.outcome).toBe('duplicate');
    expect(again.eventId).toBe(result.eventId);
    expect(await t.db.select().from(reconciliationCorrections)).toHaveLength(1);
  });
  it('keeps shortage pending, survives repeated identical audits and completes after treasury funding', async () => {
    const i = await incident(10n);
    expect(i.candidate).toMatchObject({
      mode: 'replenish_ledger',
      amountCoin: '10',
      balanceDeltaCoin: '0',
    });
    await expect(approve(i)).rejects.toMatchObject({ code: 'insufficient_treasury' });
    expect(
      (await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, i.request.id)))[0]!
        .status,
    ).toBe('pending');
    await t.db.transaction((tx) =>
      runAccountReconciliation(tx, { userId: i.member.user.id }, { source: 'scheduled' }),
    );
    await fundTestTreasury(t.db, 10n);
    const before = await ledgerSupply(t.db);
    const result = await approve(i);
    expect(result.balance).toMatchObject({ availableCoin: 110n, ledgerCoin: 110n });
    const after = await ledgerSupply(t.db);
    expect(after).toEqual({ ...before, heldCoin: before.heldCoin - 10n });
    expect(after.heldCoin).toBe(after.mintedCoin - after.burnedCoin);
    expect(after.carriedCoin).toBe(before.carriedCoin);
    expect(result.correction.ledgerEntryId).toBe(result.eventId);
  });
  it('refuses raw total updates, forged table records and correction transfers without approval', async () => {
    const i = await incident(-10n);
    await expect(
      t.db
        .update(balances)
        .set({ availableCoin: 100n })
        .where(eq(balances.accountId, i.account.id)),
    ).rejects.toThrow();
    await expect(
      t.db.execute(sql`INSERT INTO reconciliation_corrections(id) VALUES (${randomUUID()}::uuid)`),
    ).rejects.toThrow();
    await fundTestTreasury(t.db, 10n);
    await expect(
      t.db.transaction((tx) =>
        recordLedgerEntry(tx, {
          type: 'RECONCILIATION_CORRECTION',
          amountCoin: 10n,
          from: { kind: 'treasury' },
          to: { kind: 'user', userId: i.member.user.id },
          refType: 'audit_failure',
          refId: '1',
          idempotencyKey: randomUUID(),
        }),
      ),
    ).rejects.toThrow();
    await expect(
      t.db.transaction((tx) =>
        applyReconciliationCorrection(tx, {
          approvalId: i.request.id,
          requestedBy: i.requester,
          approverId: i.approver,
        }),
      ),
    ).rejects.toMatchObject({ code: 'approval' });
  });
  it('rolls back approved status and all records when the surrounding transaction fails', async () => {
    const i = await incident(-10n);
    await expect(
      t.db.transaction(async (tx) => {
        await tx
          .update(approvalRequests)
          .set({
            status: 'approved',
            decidedBy: i.approver,
            decisionReason: '검증',
            decidedAt: new Date(),
          })
          .where(eq(approvalRequests.id, i.request.id));
        await applyReconciliationCorrection(tx, {
          approvalId: i.request.id,
          requestedBy: i.requester,
          approverId: i.approver,
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await t.db.select().from(reconciliationCorrections)).toHaveLength(0);
    expect(
      (await t.db.select().from(balances).where(eq(balances.accountId, i.account.id)))[0]!
        .availableCoin,
    ).toBe(90n);
    await approve(i);
  });
  it.each(['amountCoin', 'mode', 'snapshotKey'] as const)(
    'refuses an approved payload with changed %s',
    async (field) => {
      const i = await incident(-10n);
      const candidate = {
        ...i.candidate,
        [field]:
          field === 'amountCoin' ? '11' : field === 'mode' ? 'replenish_ledger' : '0'.repeat(32),
      };
      const request = await createApprovalRequest(t.db, {
        kind: 'reconciliation_correction',
        targetType: 'ledger_account',
        targetId: String(i.account.id),
        requestedBy: i.requester,
        payload: { failureResultId: String(i.audit.result.id), candidate, userReason: '보정 안내' },
      });
      await expect(approve({ ...i, request })).rejects.toMatchObject({ code: 'stale' });
      expect(await t.db.select().from(reconciliationCorrections)).toHaveLength(0);
    },
  );
  it('requires current distinct administrators even when a request was approved earlier', async () => {
    const i = await incident(-10n);
    await t.db
      .update(approvalRequests)
      .set({
        status: 'approved',
        decidedBy: i.approver,
        decisionReason: '검증',
        decidedAt: new Date(),
      })
      .where(eq(approvalRequests.id, i.request.id));
    await expect(
      t.db.transaction((tx) =>
        applyReconciliationCorrection(tx, {
          approvalId: i.request.id,
          requestedBy: i.requester,
          approverId: i.requester,
        }),
      ),
    ).rejects.toMatchObject({ code: 'requester' });
    await t.db.update(profiles).set({ role: 'user' }).where(eq(profiles.userId, i.requester));
    await expect(
      t.db.transaction((tx) =>
        applyReconciliationCorrection(tx, {
          approvalId: i.request.id,
          requestedBy: i.requester,
          approverId: i.approver,
        }),
      ),
    ).rejects.toMatchObject({ code: 'approval' });
  });
  it('rejects a target changed since preview and cannot hide copy or order-lock corruption', async () => {
    const i = await incident(-10n);
    await damageActualCoinForTest(i.account.id, -1n);
    await expect(approve(i)).rejects.toMatchObject({ code: 'stale' });
    await withLedgerGuardsOff((c) =>
      c.query('UPDATE balances SET ledger_coin=99 WHERE account_id=$1', [i.account.id]),
    );
    expect(
      await t.db.transaction((tx) => previewReconciliationCorrections(tx, i.audit.result.id)),
    ).toEqual([]);
    await withLedgerGuardsOff((c) =>
      c.query(
        'UPDATE balances SET ledger_coin=100,available_coin=89,locked_coin=1 WHERE account_id=$1',
        [i.account.id],
      ),
    );
    expect(
      await t.db.transaction((tx) => previewReconciliationCorrections(tx, i.audit.result.id)),
    ).toEqual([]);
  });
  it('executes concurrent approvals only once, including its shared event cursor', async () => {
    const i = await incident(-10n);
    await t.db
      .update(approvalRequests)
      .set({
        status: 'approved',
        decidedBy: i.approver,
        decisionReason: '검증',
        decidedAt: new Date(),
      })
      .where(eq(approvalRequests.id, i.request.id));
    const results = await Promise.all(
      [0, 1].map(() =>
        t.db.transaction((tx) =>
          applyReconciliationCorrection(tx, {
            approvalId: i.request.id,
            requestedBy: i.requester,
            approverId: i.approver,
          }),
        ),
      ),
    );
    expect(results.map((r) => r.outcome).sort()).toEqual(['duplicate', 'recorded']);
    expect(results[0]!.eventId).toBe(results[1]!.eventId);
    expect(
      (await t.db.select().from(balances).where(eq(balances.accountId, i.account.id)))[0]!
        .availableCoin,
    ).toBe(100n);
  });
  it('keeps its privileged function private to app/owner and pins all definer name resolution', async () => {
    const { rows } = await t.db.execute<{
      definer: boolean;
      config: string[];
      public_execute: boolean;
      app_execute: boolean;
      app_insert: boolean;
    }>(sql`
      SELECT p.prosecdef AS definer,p.proconfig AS config,
        EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') AS public_execute,
        has_function_privilege('buddha_app',p.oid,'EXECUTE') AS app_execute,
        has_table_privilege('buddha_app','reconciliation_corrections','INSERT') AS app_insert
      FROM pg_proc p WHERE p.oid='public.apply_reconciliation_correction(uuid,text,text)'::regprocedure`);
    expect(rows[0]).toEqual({
      definer: true,
      config: ['search_path=pg_catalog, public, pg_temp'],
      public_execute: false,
      app_execute: true,
      app_insert: false,
    });
  });
  it('requires the next ledger event to follow a restoration cursor, even for a raw writer', async () => {
    const i = await incident(-10n);
    // Reserve a valid sequence value that precedes the restoration and is not a ledger row.
    const { rows } = await t.db.execute<{ id: string }>(
      sql`SELECT nextval('ledger_entries_id_seq')::text AS id`,
    );
    const staleId = Number(rows[0]!.id);
    const restored = await approve(i);
    expect(restored.eventId).toBeGreaterThan(staleId);
    await expect(
      t.db.transaction(async (tx) => {
        await tx.insert(ledgerEntries).values({
          id: staleId,
          type: 'DEPOSIT',
          amountCoin: 1n,
          toAccountId: i.account.id,
          toBalanceAfterCoin: 101n,
          refType: 'payment',
          refId: randomUUID(),
          idempotencyKey: randomUUID(),
        });
        await tx
          .update(balances)
          .set({ availableCoin: 101n, ledgerCoin: 101n })
          .where(eq(balances.accountId, i.account.id));
      }),
    ).rejects.toThrow();
    const next = await t.db.transaction((tx) =>
      recordLedgerEntry(tx, {
        type: 'DEPOSIT',
        amountCoin: 1n,
        from: null,
        to: { kind: 'user', userId: i.member.user.id },
        refType: 'payment',
        refId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    );
    expect(next.entry.id).toBeGreaterThan(restored.eventId);
  });
  it.each([-10n, 10n])(
    'corrects only an existing market collateral obligation (legacy transfer %s)',
    async (delta) => {
      const market = await createMarket(t.db);
      const yes = (await createUser(t.db, { balanceCoin: 1000n })).user.id;
      const no = (await createUser(t.db, { balanceCoin: 1000n })).user.id;
      const requester = (await createUser(t.db, { role: 'admin' })).user.id;
      const approver = (await createUser(t.db, { role: 'admin' })).user.id;
      await mintTestPairs(t.db, { marketId: market.id, yesHolderId: yes, noHolderId: no, qty: 1 });
      await fundTestTreasury(t.db, 20n);
      const collateral = { kind: 'market_collateral', marketId: market.id } as const;
      const treasury = { kind: 'treasury' } as const;
      await recordLegacyCorrectionForTest({
        amountCoin: 10n,
        from: delta < 0 ? collateral : treasury,
        to: delta < 0 ? treasury : collateral,
        refType: 'audit_failure',
        refId: randomUUID(),
        idempotencyKey: randomUUID(),
      });
      const audit = await t.db.transaction((tx) =>
        runMarketReconciliation(tx, market.id, { source: 'manual' }),
      );
      let [candidate] = await t.db.transaction((tx) =>
        previewReconciliationCorrections(tx, audit.result.id),
      );
      expect(candidate).toMatchObject({
        mode: delta < 0 ? 'fund_collateral' : 'return_collateral',
        amountCoin: '10',
        balanceAfterCoin: '100',
      });
      // Keep the monetary defect unchanged while introducing a separate structural defect.
      await t.db.update(positions).set({ qty: 2 }).where(eq(positions.userId, yes));
      expect(
        await t.db.transaction((tx) => previewReconciliationCorrections(tx, audit.result.id)),
      ).toEqual([]);
      await t.db.update(positions).set({ qty: 1 }).where(eq(positions.userId, yes));
      [candidate] = await t.db.transaction((tx) =>
        previewReconciliationCorrections(tx, audit.result.id),
      );
      const request = await createApprovalRequest(t.db, {
        kind: 'reconciliation_correction',
        targetType: 'ledger_account',
        targetId: candidate!.accountId,
        requestedBy: requester,
        payload: { failureResultId: String(audit.result.id), candidate, userReason: null },
      });
      const supply = await ledgerSupply(t.db);
      await t.db.transaction(async (tx) => {
        await tx
          .update(approvalRequests)
          .set({
            status: 'approved',
            decidedBy: approver,
            decisionReason: '검증',
            decidedAt: new Date(),
          })
          .where(eq(approvalRequests.id, request.id));
        await applyReconciliationCorrection(tx, {
          approvalId: request.id,
          requestedBy: requester,
          approverId: approver,
        });
      });
      expect(await ledgerSupply(t.db)).toEqual(supply);
      expect(
        (
          await t.db.transaction((tx) =>
            runMarketReconciliation(tx, market.id, { source: 'manual' }),
          )
        ).result.passed,
      ).toBe(true);
    },
  );
  it('refuses a Coin-only repair when a closed member still holds positive contracts', async () => {
    const market = await createMarket(t.db);
    const yes = (await createUser(t.db, { balanceCoin: 1000n })).user.id;
    const no = (await createUser(t.db, { balanceCoin: 1000n })).user.id;
    await mintTestPairs(t.db, { marketId: market.id, yesHolderId: yes, noHolderId: no, qty: 1 });
    const collateral = (await findLedgerAccount(t.db, {
      kind: 'market_collateral',
      marketId: market.id,
    }))!;
    await damageActualCoinForTest(collateral.id, -10n);
    const audit = await t.db.transaction((tx) =>
      runMarketReconciliation(tx, market.id, { source: 'manual' }),
    );
    expect(
      await t.db.transaction((tx) => previewReconciliationCorrections(tx, audit.result.id)),
    ).toHaveLength(1);
    await closeAccount(t.db, yes);
    expect(
      await t.db.transaction((tx) => previewReconciliationCorrections(tx, audit.result.id)),
    ).toEqual([]);
  });
  it('supports restoring treasury actual loss but never a treasury self-transfer for excess', async () => {
    await fundTestTreasury(t.db, 100n);
    const account = (await findLedgerAccount(t.db, { kind: 'treasury' }))!;
    await damageActualCoinForTest(account.id, -10n);
    const run = () =>
      t.db.transaction((tx) =>
        runAccountReconciliation(tx, { accountId: account.id }, { source: 'manual' }),
      );
    let audit = await run();
    expect(
      (await t.db.transaction((tx) => previewReconciliationCorrections(tx, audit.result.id)))[0],
    ).toMatchObject({
      accountKind: 'treasury',
      mode: 'restore_actual',
      userId: null,
      amountCoin: '10',
    });
    await damageActualCoinForTest(account.id, 20n);
    audit = await run();
    expect(
      await t.db.transaction((tx) => previewReconciliationCorrections(tx, audit.result.id)),
    ).toEqual([]);
  });
});
