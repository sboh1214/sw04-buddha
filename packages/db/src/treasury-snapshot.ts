import type { AdminTreasury } from '@buddha/shared';
import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

/** Read the existing treasury contract within the caller's snapshot; never creates an account. */
export async function readAdminTreasurySnapshot(
  executor: Pick<Db, 'execute'>,
): Promise<AdminTreasury> {
  // One statement snapshot even during a cleanup write: another market may allocate Coin,
  // but must not make two separately-read snapshots appear to be a bookkeeping mismatch.
  const { rows } = await executor.execute<{
    accountId: string | null;
    available: string | null;
    locked: string | null;
    ledger: string | null;
    latest: string | null;
    total: string | null;
    issued: string;
  }>(sql`SELECT a.id::text AS "accountId", b.available_coin::text AS available,
    b.locked_coin::text AS locked, b.ledger_coin::text AS ledger,
    CASE WHEN a.id IS NULL THEN NULL ELSE public.ledger_account_last_after(a.id)::text END AS latest,
    CASE WHEN a.id IS NULL THEN NULL ELSE
      (SELECT COALESCE(SUM(CASE WHEN e.to_account_id=a.id THEN e.amount_coin ELSE 0 END),0)
       - COALESCE(SUM(CASE WHEN e.from_account_id=a.id THEN e.amount_coin ELSE 0 END),0)
       FROM ledger_entries e WHERE e.to_account_id=a.id OR e.from_account_id=a.id)::text END AS total,
    (SELECT COALESCE(SUM(amount_coin),0)::text FROM ledger_entries WHERE type='TREASURY_MINT') AS issued
    FROM (SELECT 1) seed LEFT JOIN ledger_accounts a ON a.kind='treasury'
    LEFT JOIN balances b ON b.account_id=a.id`);
  const row = rows[0]!;
  const consistent =
    row.available !== null &&
    row.locked === '0' &&
    row.available === row.ledger &&
    row.ledger === row.latest &&
    row.latest === row.total;
  return {
    accountId: row.accountId,
    status: row.accountId === null ? 'uninitialized' : consistent ? 'ready' : 'inconsistent',
    availableCoin: row.available,
    lockedCoin: row.locked,
    ledgerCoin: row.ledger,
    issuedCoin: row.issued,
  };
}
