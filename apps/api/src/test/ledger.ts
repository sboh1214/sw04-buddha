import type { AccountLedgerRow } from '@buddha/db/test';
import { expect } from 'vitest';

/**
 * One person's ledger as the suites read it (`ledgerOf` of @buddha/db/test: each event signed
 * from the account's side, its total after it). For one account the id is commit order: it is
 * drawn while the balance row is locked. Asserts what `/me/ledger` relies on — listed by
 * (created_at, id) the rows come out in id order, every total after is the previous one plus its
 * own amount, and the sum is the balance row's total. A row stamped before the balance change it
 * records (transaction-start `now()`, or a clock read before the balance lock) breaks the first of
 * these.
 */
export function expectLedgerChain(entries: AccountLedgerRow[], finalBalanceCoin: bigint): void {
  const committed = [...entries].sort((a, b) => a.id - b.id);
  const listed = [...entries].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id,
  );
  expect(
    listed.map((entry) => entry.id),
    '(created_at, id) order disagrees with commit order',
  ).toEqual(committed.map((entry) => entry.id));
  let running = 0n;
  for (const entry of committed) {
    running += entry.amountCoin;
    expect(entry.balanceAfterCoin, `${entry.type} #${String(entry.id)}`).toBe(running);
  }
  expect(running, 'ledger sum vs balance row').toBe(finalBalanceCoin);
}
