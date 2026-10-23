/**
 * ledger.audit integration test (PLAN M2 AC 5, PLAN 5.6) against the docker `test` profile.
 * Skips when TEST_* are unset, exactly like the packages/db suite it borrows the harness from.
 */
import { schema } from '@buddha/db';
import {
  closeAccount,
  connectTestDb,
  createStartGrant,
  createUser,
  hasTestDb,
  type TestDb,
} from '@buddha/db/test';
import { eq, sql } from 'drizzle-orm';
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

  it('reports no mismatch while every balance matches its ledger', async () => {
    // createUser writes a matching ADMIN_ADJUST entry for the starting balance.
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
    const { user } = await createUser(t.db, { balanceCoin: 10_000n });
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

    // Exactly what the AC asks for: move the balance without a ledger entry. The app role
    // may UPDATE balances (only ledger_entries is append-only), so this is reachable in
    // production through a bug, which is why the job exists.
    await t.db
      .update(schema.balances)
      .set({ availableCoin: sql`${schema.balances.availableCoin} + 1500` })
      .where(eq(schema.balances.userId, user.id));

    const result = await runLedgerAudit(t.db);
    expect(result.checked).toBe(2);
    expect(result.mismatches).toEqual([
      {
        userId: user.id,
        balanceMissing: false,
        availableCoin: 11_500n,
        lockedCoin: 0n,
        ledgerSumCoin: 10_000n,
        differenceCoin: 1_500n,
      },
    ]);

    const rows = await failures();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: LEDGER_AUDIT_FAILURE_KIND,
      payload: {
        userId: user.id,
        availableCoin: '11500',
        ledgerSumCoin: '10000',
        differenceCoin: '1500',
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

  it('reports an account whose balance row is gone instead of losing it', async () => {
    // The audit used to be anchored on `balances`, so an account with no balance row simply
    // vanished: no mismatch AND `checked` one short, while the job logged "clean". buddha_app
    // keeps DELETE on balances, and such an account is broken in its own right — every wallet
    // call 404s — so it is exactly what this job exists to surface.
    const { user } = await createUser(t.db, { balanceCoin: 10_000n });
    const untouched = await createUser(t.db, { balanceCoin: 5_000n });
    await t.db.delete(schema.balances).where(eq(schema.balances.userId, user.id));

    const result = await runLedgerAudit(t.db);
    expect(result.checked).toBe(2); // driven from `user`, so the orphan is still counted
    expect(result.mismatches).toEqual([
      {
        userId: user.id,
        balanceMissing: true,
        availableCoin: 0n,
        lockedCoin: 0n,
        ledgerSumCoin: 10_000n,
        differenceCoin: -10_000n,
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

  it('counts an account with no ledger entries and a zero balance as consistent', async () => {
    // Every new account since migration 0031 (signing up grants nothing, #70).
    await createUser(t.db);
    const result = await runLedgerAudit(t.db);
    expect(result).toMatchObject({ checked: 1, recorded: 0 });
  });

  it('reports such an account once its balance row is gone: 0 against 0 is not enough', async () => {
    const { user } = await createUser(t.db);
    await t.db.delete(schema.balances).where(eq(schema.balances.userId, user.id));
    const result = await runLedgerAudit(t.db);
    expect(result.mismatches).toEqual([
      {
        userId: user.id,
        balanceMissing: true,
        availableCoin: 0n,
        lockedCoin: 0n,
        ledgerSumCoin: 0n,
        differenceCoin: 0n,
      },
    ]);
  });

  it('balances a start grant like any other entry (#70)', async () => {
    const { user } = await createUser(t.db);
    await createStartGrant(t.db, { userId: user.id, amountCoin: 10_000n });
    const result = await runLedgerAudit(t.db);
    expect(result).toMatchObject({ checked: 1, recorded: 0 });
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
    await t.db
      .update(schema.balances)
      .set({ availableCoin: sql`${schema.balances.availableCoin} + 1` });

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
