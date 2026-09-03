/**
 * ledger.audit integration test (PLAN M2 AC 5, PLAN 5.6) against the docker `test` profile.
 * Skips when TEST_* are unset, exactly like the packages/db suite it borrows the harness from.
 */
import { schema } from '@buddha/db';
import { connectTestDb, createUser, hasTestDb, type TestDb } from '@buddha/db/test';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LEDGER_AUDIT_FAILURE_KIND, runLedgerAudit } from './ledger-audit.js';

describe.skipIf(!hasTestDb())('ledger.audit (integration)', () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await connectTestDb();
  });
  afterAll(async () => {
    await t.close();
  });
  beforeEach(async () => {
    await t.reset();
  });

  async function failures() {
    return t.db.select().from(schema.auditFailures);
  }

  it('reports no mismatch while every balance matches its ledger', async () => {
    // createUser writes a matching ADMIN_ADJUST entry for the starting balance.
    await createUser(t.db, { balanceP: 10_000n });
    await createUser(t.db);

    const result = await runLedgerAudit(t.db);
    expect(result.checked).toBe(2);
    expect(result.mismatches).toEqual([]);
    expect(result.recorded).toBe(0);
    expect(await failures()).toHaveLength(0);
  });

  it('records one audit_failures row per account whose balance was changed behind the ledger', async () => {
    const { user } = await createUser(t.db, { balanceP: 10_000n });
    const untouched = await createUser(t.db, { balanceP: 5_000n });

    // Exactly what the AC asks for: move the balance without a ledger entry. The app role
    // may UPDATE balances (only ledger_entries is append-only), so this is reachable in
    // production through a bug, which is why the job exists.
    await t.db
      .update(schema.balances)
      .set({ availableP: sql`${schema.balances.availableP} + 1500` })
      .where(eq(schema.balances.userId, user.id));

    const result = await runLedgerAudit(t.db);
    expect(result.checked).toBe(2);
    expect(result.mismatches).toEqual([
      {
        userId: user.id,
        availableP: 11_500n,
        lockedP: 0n,
        ledgerSumP: 10_000n,
        differenceP: 1_500n,
      },
    ]);

    const rows = await failures();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: LEDGER_AUDIT_FAILURE_KIND,
      payload: {
        userId: user.id,
        availableP: '11500',
        ledgerSumP: '10000',
        differenceP: '1500',
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
    expect(row?.availableP).toBe(5_000n);
  });

  it('counts an account with no ledger entries and a zero balance as consistent', async () => {
    await createUser(t.db);
    const result = await runLedgerAudit(t.db);
    expect(result).toMatchObject({ checked: 1, recorded: 0 });
  });
});
