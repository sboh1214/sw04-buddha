import { schema, type Db } from '@buddha/db';
import { sql } from 'drizzle-orm';

/** One account whose balance does not match the sum of its ledger entries (PLAN 5.6). */
export interface LedgerMismatch {
  userId: string;
  availableP: bigint;
  lockedP: bigint;
  ledgerSumP: bigint;
  /** balance − ledger sum: positive means the balance holds P the ledger never granted. */
  differenceP: bigint;
}

export interface LedgerAuditResult {
  /** Accounts examined (every row of `balances`). */
  checked: number;
  mismatches: LedgerMismatch[];
  /** `audit_failures` rows written — one per mismatch. */
  recorded: number;
}

export const LEDGER_AUDIT_FAILURE_KIND = 'ledger_balance_mismatch';

/**
 * Verifies the PLAN 5.6 invariant for every account:
 *
 *   balances.available_p + balances.locked_p == SUM(ledger_entries.amount_p)
 *
 * The check runs entirely in Postgres (one grouped query), so it stays a single pass over
 * the ledger index no matter how many accounts exist, and it never mutates money — a
 * mismatch is only ever *recorded* in `audit_failures`, because the ledger is the source of
 * truth and silently "fixing" a balance would destroy the evidence.
 *
 * Idempotent by design: re-running writes one more failure row per still-broken account and
 * changes nothing else, which is what a daily job needs (PLAN 9).
 */
export async function runLedgerAudit(db: Db): Promise<LedgerAuditResult> {
  const { rows } = await db.execute<{
    user_id: string;
    available_p: string;
    locked_p: string;
    ledger_sum_p: string;
    checked: string;
  }>(sql`
    with sums as (
      select
        b.user_id,
        b.available_p,
        b.locked_p,
        coalesce(sum(l.amount_p), 0) as ledger_sum_p
      from balances b
      left join ledger_entries l on l.user_id = b.user_id
      group by b.user_id, b.available_p, b.locked_p
    )
    select
      user_id,
      available_p,
      locked_p,
      ledger_sum_p,
      (select count(*) from sums) as checked
    from sums
    where available_p + locked_p <> ledger_sum_p
    order by user_id
  `);

  // `checked` rides along on every row; with no mismatch the count needs its own query.
  const checked = rows[0]
    ? Number(rows[0].checked)
    : Number(
        (await db.execute<{ count: string }>(sql`select count(*) as count from balances`)).rows[0]
          ?.count ?? '0',
      );

  const mismatches = rows.map((row) => {
    const availableP = BigInt(row.available_p);
    const lockedP = BigInt(row.locked_p);
    const ledgerSumP = BigInt(row.ledger_sum_p);
    return {
      userId: row.user_id,
      availableP,
      lockedP,
      ledgerSumP,
      differenceP: availableP + lockedP - ledgerSumP,
    };
  });

  if (mismatches.length > 0) {
    await db.insert(schema.auditFailures).values(
      mismatches.map((mismatch) => ({
        kind: LEDGER_AUDIT_FAILURE_KIND,
        payload: {
          userId: mismatch.userId,
          availableP: mismatch.availableP.toString(),
          lockedP: mismatch.lockedP.toString(),
          ledgerSumP: mismatch.ledgerSumP.toString(),
          differenceP: mismatch.differenceP.toString(),
        },
      })),
    );
  }

  return { checked, mismatches, recorded: mismatches.length };
}
