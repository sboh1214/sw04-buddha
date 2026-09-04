import { schema, type Db } from '@buddha/db';
import { sql } from 'drizzle-orm';

/** One account whose balance does not match the sum of its ledger entries (PLAN 5.6). */
export interface LedgerMismatch {
  userId: string;
  /** No `balances` row at all — an accounting failure of its own: every wallet call 404s. */
  balanceMissing: boolean;
  /** 0n when `balanceMissing`. */
  availableP: bigint;
  /** 0n when `balanceMissing`. */
  lockedP: bigint;
  ledgerSumP: bigint;
  /** balance − ledger sum, an absent balance read as 0: positive means the balance holds P
   *  the ledger never granted. */
  differenceP: bigint;
}

export interface LedgerAuditResult {
  /** Accounts examined (every row of `user`). */
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
 * Driven from `user`, not from `balances`. buddha_app keeps DELETE on `balances` (migration
 * 0001 revokes it only on the append-only tables), and an account that lost its balance row
 * is broken in its own right — every wallet call 404s. Anchored on `balances` such an account
 * simply vanished from the result: no mismatch, and `checked` quietly one short.
 *
 * Idempotent by design: re-running writes one more failure row per still-broken account and
 * changes nothing else, which is what a daily job needs (PLAN 9).
 */
export async function runLedgerAudit(db: Db): Promise<LedgerAuditResult> {
  const { rows } = await db.execute<{
    user_id: string;
    balance_missing: boolean;
    available_p: string;
    locked_p: string;
    ledger_sum_p: string;
    checked: string;
  }>(sql`
    with ledger as (
      select user_id, sum(amount_p) as ledger_sum_p
      from ledger_entries
      group by user_id
    ),
    accounts as (
      select
        u.id as user_id,
        (b.user_id is null) as balance_missing,
        coalesce(b.available_p, 0) as available_p,
        coalesce(b.locked_p, 0) as locked_p,
        coalesce(g.ledger_sum_p, 0) as ledger_sum_p
      from "user" u
      left join balances b on b.user_id = u.id
      left join ledger g on g.user_id = u.id
    )
    select
      user_id,
      balance_missing,
      available_p,
      locked_p,
      ledger_sum_p,
      (select count(*) from accounts) as checked
    from accounts
    -- balance_missing needs its own disjunct. With no balance row AND no ledger entries the
    -- arithmetic below is 0 <> 0, so the broken account would still pass. No test covers that
    -- shape because buddha_app cannot build it -- ledger_entries is append-only (migration
    -- 0001) and the trigger writes a BONUS entry with every account -- but accounts predating
    -- the 0004 bonus have no ledger rows at all, and one of those losing its balance is
    -- exactly the silent case this job exists to catch.
    where balance_missing or available_p + locked_p <> ledger_sum_p
    order by user_id
  `);

  // `checked` rides along on every row; with no mismatch the count needs its own query.
  const checked = rows[0]
    ? Number(rows[0].checked)
    : Number(
        (await db.execute<{ count: string }>(sql`select count(*) as count from "user"`)).rows[0]
          ?.count ?? '0',
      );

  const mismatches = rows.map((row) => {
    // `coalesce(..., 0)` above keeps these non-null: `BigInt(null)` throws, which would turn a
    // detected orphan into a crashed job.
    const availableP = BigInt(row.available_p);
    const lockedP = BigInt(row.locked_p);
    const ledgerSumP = BigInt(row.ledger_sum_p);
    return {
      userId: row.user_id,
      balanceMissing: row.balance_missing,
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
        // One kind, as AUDIT_FAILURE_KINDS declares; the two failures are told apart by
        // `balanceMissing` in the free-form jsonb payload.
        payload: {
          userId: mismatch.userId,
          balanceMissing: mismatch.balanceMissing,
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
