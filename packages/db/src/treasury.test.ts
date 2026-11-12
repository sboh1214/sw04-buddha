import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findLedgerAccount, ledgerKeys, recordLedgerEntry } from './ledger.js';
import { mintTreasury } from './treasury.js';
import {
  approvalRequests,
  balances,
  ledgerEntries,
  profiles,
  treasuryIssuances,
} from './schema/index.js';
import { createApprovalRequest, createUser } from './test/factories.js';
import { connectTestDb, hasTestDb, type TestDb } from './test/harness.js';
import { damageActualCoinForTest, ledgerSupply } from './test/ledger.js';

describe.skipIf(!hasTestDb())('approved treasury issuance (#129)', () => {
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

  async function request(amountCoin = '1000', approved = true) {
    const requester = (await createUser(t.db, { role: 'admin' })).user.id;
    const approver = (await createUser(t.db, { role: 'admin' })).user.id;
    return createApprovalRequest(t.db, {
      kind: 'treasury_issue',
      targetType: 'treasury',
      targetId: 'treasury',
      payload: { amountCoin },
      requestedBy: requester,
      ...(approved ? { decision: { status: 'approved' as const, by: approver } } : {}),
    });
  }
  const mint = (approvalId: string) => t.db.transaction((tx) => mintTreasury(tx, { approvalId }));

  it('binds the approved amount once, keeps total supply and preserves permanent evidence', async () => {
    const approved = await request();
    const first = await mint(approved.id);
    const again = await mint(approved.id);
    expect(first.outcome).toBe('recorded');
    expect(again).toMatchObject({
      outcome: 'duplicate',
      issuance: first.issuance,
      entry: first.entry,
    });
    expect(first.issuance).toMatchObject({
      approvalId: approved.id,
      amountCoin: 1000n,
      requestedBy: approved.requestedBy,
      approvedBy: approved.decidedBy,
      ledgerEntryId: first.entry.id,
    });
    expect(first.balance).toMatchObject({
      availableCoin: 1000n,
      lockedCoin: 0n,
      ledgerCoin: 1000n,
    });
    expect(await ledgerSupply(t.db)).toEqual({
      mintedCoin: 1000n,
      burnedCoin: 0n,
      heldCoin: 1000n,
      carriedCoin: 1000n,
    });
    await expect(t.db.update(treasuryIssuances).set({ amountCoin: 2n })).rejects.toThrow();
    await expect(t.db.delete(treasuryIssuances)).rejects.toThrow();
    expect(await t.db.select().from(treasuryIssuances)).toEqual([first.issuance]);
  });

  it('serializes concurrent calls into one mint', async () => {
    const approved = await request();
    const results = await Promise.all([mint(approved.id), mint(approved.id)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['duplicate', 'recorded']);
    expect(await t.db.select().from(ledgerEntries)).toHaveLength(1);
    expect(await t.db.select().from(treasuryIssuances)).toHaveLength(1);
  });

  it('accepts a real savepoint transaction without losing the ledger insertion binding', async () => {
    const approved = await request();
    await t.db.transaction((tx) =>
      tx.transaction((inner) => mintTreasury(inner, { approvalId: approved.id })),
    );
    expect(await t.db.select().from(treasuryIssuances)).toHaveLength(1);
  });

  it('rolls approval and all money back when a later write fails', async () => {
    const pending = await request('400', false);
    const by = (await createUser(t.db, { role: 'admin' })).user.id;
    await expect(
      t.db.transaction(async (tx) => {
        await tx
          .update(approvalRequests)
          .set({
            status: 'approved',
            decidedBy: by,
            decisionReason: '승인',
            decidedAt: new Date(pending.requestedAt.getTime() + 1),
          })
          .where(eq(approvalRequests.id, pending.id));
        await mintTreasury(tx, { approvalId: pending.id });
        throw new Error('later write failed');
      }),
    ).rejects.toThrow('later write failed');
    expect(
      (await t.db.select().from(approvalRequests).where(eq(approvalRequests.id, pending.id)))[0]!
        .status,
    ).toBe('pending');
    expect(await t.db.select().from(treasuryIssuances)).toEqual([]);
    expect(await t.db.select().from(ledgerEntries)).toEqual([]);
    expect(await findLedgerAccount(t.db, { kind: 'treasury' })).toBeNull();
  });

  it.each(['0', '-1', '1.2', '01', '1000000000000001'])(
    'rejects invalid stored amount %s without a mint',
    async (raw) => {
      const approved = await request(raw);
      await expect(mint(approved.id)).rejects.toMatchObject({ code: 'amount' });
      expect(await t.db.select().from(ledgerEntries)).toEqual([]);
    },
  );

  it('requires approval and two currently active administrators', async () => {
    await expect(mint(randomUUID())).rejects.toMatchObject({ code: 'not_found' });
    const pending = await request('100', false);
    await expect(mint(pending.id)).rejects.toMatchObject({ code: 'approval' });
    const approved = await request();
    await t.db
      .update(profiles)
      .set({ role: 'user' })
      .where(eq(profiles.userId, approved.requestedBy));
    await expect(mint(approved.id)).rejects.toMatchObject({ code: 'approval' });
    expect(await t.db.select().from(ledgerEntries)).toEqual([]);
  });

  it('refuses a treasury whose actual buckets left the ledger instead of masking the gap', async () => {
    await mint((await request()).id);
    const treasury = await findLedgerAccount(t.db, { kind: 'treasury' });
    await damageActualCoinForTest(treasury!.id, -1n);
    const pendingMint = await request('10');
    const before = await t.db.select().from(balances);
    await expect(mint(pendingMint.id)).rejects.toMatchObject({
      code: 'treasury_inconsistent',
    });
    expect(await t.db.select().from(balances)).toEqual(before);
    expect(await t.db.select().from(ledgerEntries)).toHaveLength(1);
  });

  it('the application cannot commit an unbound raw mint even with an approved request id', async () => {
    const approved = await request();
    await expect(
      t.db.transaction((tx) =>
        recordLedgerEntry(tx, {
          type: 'TREASURY_MINT',
          amountCoin: 1000n,
          from: null,
          to: { kind: 'treasury' },
          refType: 'approval_request',
          refId: approved.id,
          idempotencyKey: ledgerKeys.approvalRequest(approved.id),
        }),
      ),
    ).rejects.toThrow();
    expect(await t.db.select().from(ledgerEntries)).toEqual([]);
  });

  it.each(['amount', 'requester_role'] as const)(
    'raw current-transaction binding refuses %s tampering',
    async (fault) => {
      const approved = await request();
      if (fault === 'requester_role')
        await t.db
          .update(profiles)
          .set({ role: 'user' })
          .where(eq(profiles.userId, approved.requestedBy));
      const amountCoin = fault === 'amount' ? 999n : 1000n;
      await expect(
        t.db.transaction(async (tx) => {
          const entry = await recordLedgerEntry(tx, {
            type: 'TREASURY_MINT',
            amountCoin,
            from: null,
            to: { kind: 'treasury' },
            refType: 'approval_request',
            refId: approved.id,
            idempotencyKey: approved.id,
          });
          if (entry.outcome !== 'recorded') throw new Error('expected fresh mint');
          // Deliberately bypass the production mint helper: the SQL binding itself must refuse it.
          await tx.insert(treasuryIssuances).values({
            approvalId: approved.id,
            ledgerEntryId: entry.entry.id,
            amountCoin,
            requestedBy: approved.requestedBy,
            approvedBy: approved.decidedBy!,
            appliedTxid: sql`pg_current_xact_id()::text`,
            createdAt: entry.entry.createdAt,
          });
        }),
      ).rejects.toThrow();
      expect(await t.db.select().from(ledgerEntries)).toEqual([]);
      expect(await t.db.select().from(treasuryIssuances)).toEqual([]);
      expect(await findLedgerAccount(t.db, { kind: 'treasury' })).toBeNull();
    },
  );

  it('refuses a fabricated binding to another request and a committed older ledger row', async () => {
    const first = await mint((await request()).id);
    const other = await request();
    await expect(
      t.db.insert(treasuryIssuances).values({
        ...first.issuance,
        approvalId: other.id,
        requestedBy: other.requestedBy,
        approvedBy: other.decidedBy!,
        appliedTxid: sql`pg_current_xact_id()::text`,
      }),
    ).rejects.toThrow();
    expect(await t.db.select().from(treasuryIssuances)).toHaveLength(1);
  });

  it('pins trigger search paths and removes public execution privileges', async () => {
    const result = await t.db.execute<{
      name: string;
      publicExecute: boolean;
      config: string[];
    }>(sql`
      SELECT p.proname AS name, coalesce(bool_or(a.grantee=0 AND a.privilege_type='EXECUTE'),false) AS "publicExecute",
        p.proconfig AS config FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      LEFT JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a ON true
      WHERE n.nspname='public' AND p.proname IN ('treasury_issuances_check_insert','ledger_entries_market_maker_binding')
      GROUP BY p.oid ORDER BY p.proname`);
    expect(result.rows).toHaveLength(2);
    for (const row of result.rows) {
      expect(row.publicExecute).toBe(false);
      expect(row.config).toContain('search_path=pg_catalog, public, pg_temp');
    }
  });
});
