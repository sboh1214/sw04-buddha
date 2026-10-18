import { and, asc, eq, exists, isNull, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { isPhoneVerified } from './phone-verification.js';
import { balances } from './schema/balances.js';
import { ledgerEntries } from './schema/ledger.js';
import { phoneVerifications } from './schema/phone-verifications.js';
import { startGrants } from './schema/start-grants.js';
import { clockTimestamp } from './tx-helpers.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type StartGrantRow = typeof startGrants.$inferSelect;
type LedgerRow = typeof ledgerEntries.$inferSelect;
type BalanceRow = typeof balances.$inferSelect;

/**
 * What paying one start grant did (#70, ADR-0071):
 * - `granted`: this call paid it — the balance, the START_GRANT entry and the row, together;
 * - `already_granted`: it was paid before (by an earlier call or by the worker), nothing written;
 * - `unverified`: the account has no 본인확인 record any more (a withdrawal deleted it, #140),
 *   nothing written: the grant stays pending, the record of its number (ADR-0071 7-11);
 * - `pending`: the amount is undecided (`readAmount` gave null), nothing written: it waits.
 */
export type PayStartGrantResult =
  | { outcome: 'granted'; grant: StartGrantRow; balance: BalanceRow; ledgerEntry: LedgerRow }
  | { outcome: 'already_granted'; grant: StartGrantRow }
  | { outcome: 'unverified'; grant: StartGrantRow }
  | { outcome: 'pending'; grant: StartGrantRow };

/**
 * Pays the start grant `grantId` if it is still pending: the one place the start Coin is paid,
 * shared by the API (the grant #58 asks for after the onboarding) and the worker (the per-minute
 * payment of the grants that waited for an amount), which PLAN 4.1 keeps from importing each
 * other — like `lockMarket` and `clockTimestamp`.
 *
 * Call it on the transaction handle; the payment is that transaction's. In order:
 * 1. The grant row FOR UPDATE: of two payers of one grant (a repeated call, the worker's scan),
 *    the second waits here and then finds it paid — one ledger entry, whatever races.
 * 2. The account's 본인확인 record (`isPhoneVerified`, FOR KEY SHARE): no Coin to an account that
 *    has none (#70's acceptance: the payment needs #183's record). A grant recorded while the
 *    account was verified can outlive the record — the account withdrew while it waited (#140) —
 *    and then nothing is paid and the row stays pending: of the answers ADR-0071 puts to the owner
 *    (결과 4), the one that writes nothing and leaves the others open. The lock keeps a withdrawal
 *    from deleting the record until this commits, so a payment never lands beside one; with the
 *    API's grant, which holds the record FOR SHARE already, the two share locks do not conflict.
 * 3. `readAmount(tx)` once, after those locks (ADR-0055: a value is read once when its work begins
 *    and kept): the release setting `grant.start_coin`, whatever its status (ADR-0069 decision 7),
 *    or null while it is undecided, which leaves the grant pending (decision 4 #70). A changed
 *    value therefore applies to the grants paid after the change only (#57-2).
 * 4. The account's balance row FOR UPDATE, then the clock (`clockTimestamp`, after the last lock:
 *    the entry sorts after whatever committed while this waited), the balance, the START_GRANT
 *    entry (ref `start_grant` → the grant) and the grant row, all at that instant. Every payer
 *    takes the 본인확인 record before the balance — the worker after the grant row, the API's
 *    grant before it too (FOR SHARE, which this KEY SHARE never waits on) — and no other balance
 *    writer locks the record or a grant row, so a payment cannot deadlock with another balance
 *    writer — as long as a withdrawal (#140), which deletes the record and writes the balance,
 *    takes the record first too (ADR-0071 결과 5).
 *
 * Throws a plain Error when the grant or the balance row does not exist (a broken account).
 */
export async function payStartGrant(
  tx: Tx,
  grantId: string,
  readAmount: (tx: Tx) => Promise<bigint | null>,
): Promise<PayStartGrantResult> {
  const [grant] = await tx
    .select()
    .from(startGrants)
    .where(eq(startGrants.id, grantId))
    .limit(1)
    .for('update');
  if (!grant) throw new Error(`start grant ${grantId} does not exist`);
  if (grant.grantedAt !== null) return { outcome: 'already_granted', grant };
  if (!(await isPhoneVerified(tx, grant.userId, 'key share'))) {
    return { outcome: 'unverified', grant };
  }

  const amountCoin = await readAmount(tx);
  if (amountCoin === null) return { outcome: 'pending', grant };
  if (amountCoin <= 0n) throw new Error(`start grant amount must be positive, got ${amountCoin}`);

  const [locked] = await tx
    .select({ userId: balances.userId })
    .from(balances)
    .where(eq(balances.userId, grant.userId))
    .limit(1)
    .for('update');
  if (!locked) throw new Error(`account ${grant.userId} has no balance row`);
  const grantedAt = await clockTimestamp(tx);

  const [balance] = await tx
    .update(balances)
    .set({
      availableCoin: sql`${balances.availableCoin} + ${amountCoin}`,
      // Explicit: the column's `$onUpdate` would write this host's clock, not the database's.
      updatedAt: grantedAt,
    })
    .where(eq(balances.userId, grant.userId))
    .returning();
  const [ledgerEntry] = await tx
    .insert(ledgerEntries)
    .values({
      userId: grant.userId,
      type: 'START_GRANT',
      amountCoin,
      balanceAfterCoin: balance!.availableCoin,
      refType: 'start_grant',
      refId: grant.id,
      // The type says what it is ('시작 지급' on the wallet); nothing else to note.
      memo: null,
      createdAt: grantedAt,
    })
    .returning();
  // Migration 0031's trigger refuses this unless the entry above is this grant's own.
  const [paid] = await tx
    .update(startGrants)
    .set({ amountCoin, ledgerEntryId: ledgerEntry!.id, grantedAt })
    .where(and(eq(startGrants.id, grant.id), isNull(startGrants.grantedAt)))
    .returning();
  if (!balance || !ledgerEntry || !paid) {
    throw new Error(`start grant ${grant.id} could not be paid`);
  }
  return { outcome: 'granted', grant: paid, balance, ledgerEntry };
}

/**
 * The grants still waiting for an amount, oldest first (the partial index of migration 0031),
 * at most `limit` of them: the worker's scan pays them one transaction each.
 *
 * Only grants whose account still has its 본인확인 record: `payStartGrant` pays no other, and a
 * grant whose account withdrew while it waited stays pending for good (ADR-0071 7-11) — left in,
 * those rows would sort first forever and, once there were `limit` of them, every run would spend
 * itself on them and never reach a grant it could pay.
 */
export async function pendingStartGrantIds(executor: Db | Tx, limit: number): Promise<string[]> {
  const rows = await executor
    .select({ id: startGrants.id })
    .from(startGrants)
    .where(
      and(
        isNull(startGrants.grantedAt),
        exists(
          executor
            .select({ verified: sql`1` })
            .from(phoneVerifications)
            .where(eq(phoneVerifications.userId, startGrants.userId)),
        ),
      ),
    )
    .orderBy(asc(startGrants.createdAt), asc(startGrants.id))
    .limit(limit);
  return rows.map((row) => row.id);
}
