import { MAX_COIN_AMOUNT } from '@buddha/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { findLedgerAccount, ledgerKeys, lockLedgerAccounts, recordLedgerEntry } from './ledger.js';
import {
  approvalRequests,
  balances,
  ledgerEntries,
  profiles,
  treasuryIssuances,
} from './schema/index.js';
import { clockTimestamp, lockAdminRoles } from './tx-helpers.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type TreasuryIssuanceRow = typeof treasuryIssuances.$inferSelect;
export class MintTreasuryError extends Error {
  readonly code: 'not_found' | 'approval' | 'treasury_inconsistent' | 'amount';
  constructor(code: MintTreasuryError['code']) {
    super(`Treasury mint: ${code}`);
    this.name = 'MintTreasuryError';
    this.code = code;
  }
}

/** Caller approves under roles → treasury assets → approval row, in this same transaction.
 * The stored payload is the only amount. The deferred DB binding independently rejects a raw
 * unapproved/mismatched mint. No limit setting, automatic refill or direct bucket adjustment.
 */
export async function mintTreasury(tx: Tx, input: { approvalId: string }) {
  await lockAdminRoles(tx, 'shared');
  await lockLedgerAccounts(tx, [{ kind: 'treasury' }]);
  const [approval] = await tx
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, input.approvalId))
    .for('update');
  if (!approval) throw new MintTreasuryError('not_found');
  if (
    approval.kind !== 'treasury_issue' ||
    approval.targetType !== 'treasury' ||
    approval.targetId !== 'treasury' ||
    approval.status !== 'approved' ||
    !approval.decidedBy ||
    approval.requestedBy === approval.decidedBy
  )
    throw new MintTreasuryError('approval');
  const admins = await tx
    .select({ id: profiles.userId })
    .from(profiles)
    .where(
      and(
        inArray(profiles.userId, [approval.requestedBy, approval.decidedBy]),
        eq(profiles.role, 'admin'),
        isNull(profiles.closedAt),
      ),
    );
  if (admins.length !== 2) throw new MintTreasuryError('approval');
  const raw = approval.payload?.['amountCoin'];
  if (typeof raw !== 'string' || !/^[1-9]\d{0,15}$/.test(raw))
    throw new MintTreasuryError('amount');
  const amountCoin = BigInt(raw);
  if (amountCoin > MAX_COIN_AMOUNT) throw new MintTreasuryError('amount');
  const account = await findLedgerAccount(tx, { kind: 'treasury' });
  if (!account) throw new Error('Locked treasury disappeared');
  const [balance] = await tx.select().from(balances).where(eq(balances.accountId, account.id));
  if (!balance) throw new Error('Locked treasury balance disappeared');
  const [prior] = await tx
    .select()
    .from(treasuryIssuances)
    .where(eq(treasuryIssuances.approvalId, input.approvalId));
  if (prior) {
    const [entry] = await tx
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.id, prior.ledgerEntryId));
    if (!entry) throw new Error('Treasury issuance ledger disappeared');
    return { outcome: 'duplicate' as const, issuance: prior, entry, balance };
  }
  const { rows } = await tx.execute<{ actual: string; sum: string }>(
    sql`SELECT public.ledger_account_last_after(${account.id})::text AS actual,
      (SELECT coalesce(sum(CASE WHEN to_account_id=${account.id} THEN amount_coin ELSE -amount_coin END),0)::text
       FROM ledger_entries WHERE from_account_id=${account.id} OR to_account_id=${account.id}) AS sum`,
  );
  if (
    balance.lockedCoin !== 0n ||
    balance.availableCoin !== balance.ledgerCoin ||
    balance.ledgerCoin !== BigInt(rows[0]!.actual) ||
    balance.ledgerCoin !== BigInt(rows[0]!.sum)
  )
    throw new MintTreasuryError('treasury_inconsistent');
  const at = await clockTimestamp(tx);
  const result = await recordLedgerEntry(tx, {
    type: 'TREASURY_MINT',
    amountCoin,
    from: null,
    to: { kind: 'treasury' },
    refType: 'approval_request',
    refId: approval.id,
    idempotencyKey: ledgerKeys.approvalRequest(approval.id),
    at,
  });
  if (result.outcome !== 'recorded') throw new Error('An unbound treasury mint already exists');
  const [issuance] = await tx
    .insert(treasuryIssuances)
    .values({
      approvalId: approval.id,
      amountCoin,
      ledgerEntryId: result.entry.id,
      requestedBy: approval.requestedBy,
      approvedBy: approval.decidedBy,
      appliedTxid: sql`pg_current_xact_id()::text`,
      createdAt: at,
    })
    .returning();
  return {
    outcome: 'recorded' as const,
    issuance: issuance!,
    entry: result.entry,
    balance: result.to!,
  };
}
