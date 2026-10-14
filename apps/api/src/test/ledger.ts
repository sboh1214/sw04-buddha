import type { schema } from '@buddha/db';
import { expect } from 'vitest';

type LedgerRow = typeof schema.ledgerEntries.$inferSelect;

/**
 * One account's ledger as the suites read it (id ascending). For one account the id is commit
 * order: it is drawn while the balance row is locked. Asserts what `/me/ledger` relies on —
 * listed by (created_at, id) the rows come out in that same order, every balance_after_coin is
 * the previous one plus its own amount, and the sum is the balance row. A row stamped before
 * the balance change it records (transaction-start `now()`, or a clock read before the balance
 * lock) breaks the first of these.
 */
export function expectLedgerChain(entries: LedgerRow[], finalBalanceCoin: bigint): void {
  const listed = [...entries].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id,
  );
  expect(
    listed.map((entry) => entry.id),
    '(created_at, id) order disagrees with commit order',
  ).toEqual(entries.map((entry) => entry.id));
  let running = 0n;
  for (const entry of entries) {
    running += entry.amountCoin;
    expect(entry.balanceAfterCoin, `${entry.type} #${String(entry.id)}`).toBe(running);
  }
  expect(running, 'ledger sum vs balance row').toBe(finalBalanceCoin);
}
