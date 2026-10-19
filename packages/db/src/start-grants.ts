import { and, asc, eq, exists, isNull, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import { isPhoneVerified } from './phone-verification.js';
import { balances } from './schema/balances.js';
import { ledgerEntries } from './schema/ledger.js';
import { phoneVerifications } from './schema/phone-verifications.js';
import { startGrantNumbers, startGrants } from './schema/start-grants.js';
import { clockTimestamp } from './tx-helpers.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export type StartGrantRow = typeof startGrants.$inferSelect;
export type StartGrantNumberRow = typeof startGrantNumbers.$inferSelect;
type LedgerRow = typeof ledgerEntries.$inferSelect;
type BalanceRow = typeof balances.$inferSelect;

/**
 * What a grant row stands for (#70, ADR-0071): paid (`granted_at`), cancelled when its account
 * withdrew while it waited (`cancelled_at`, owner decision 2026-10-18), or still waiting for its
 * amount. Migration 0031's CHECK keeps the two from being set together.
 */
export function startGrantStatus(
  row: Pick<StartGrantRow, 'grantedAt' | 'cancelledAt'>,
): 'pending' | 'granted' | 'cancelled' {
  if (row.grantedAt !== null) return 'granted';
  if (row.cancelledAt !== null) return 'cancelled';
  return 'pending';
}

/**
 * What recording an account's start grant did (#70, ADR-0071):
 * - `recorded`: this call recorded the grant, pending, and its number (`source` 'grant');
 * - `existing`: the account had its grant already — waiting, paid or cancelled — so nothing was
 *   written, whatever its number is now (one grant per account);
 * - `number_already_used`: the number counts for another account's grant, paid or waiting
 *   (typically an account that withdrew before this one verified the number), so nothing was
 *   written: this account gets no grant record (#57-1·#57-17).
 */
export type RecordStartGrantResult =
  | { outcome: 'recorded'; grantId: string }
  | { outcome: 'existing'; grantId: string }
  | { outcome: 'number_already_used' };

/** Thrown inside the savepoint to undo the grant row when its number is taken. */
class NumberAlreadyUsed extends Error {}

/**
 * Records the start grant of `userId`, pending, with the keyed hash of its verified number
 * (`phoneHash`, apps/api PhoneHasher) — unless the account has one already, or the number counts
 * for another account's grant. Call it on the transaction handle, holding the account's 본인확인
 * record (the API's grant reads it FOR SHARE first: the lock order of ADR-0071, 본인확인 기록 →
 * grant → balance).
 *
 * The constraints decide, not a read before the write: the grant goes in ON CONFLICT DO NOTHING on
 * the account (a concurrent call for the same account waits for the other's commit and then finds
 * its row), and its number ON CONFLICT DO NOTHING on the number's live record
 * (`start_grant_numbers_phone_hash_live_idx`); a number already held rolls the grant back to the
 * savepoint, so an account whose number is used keeps no row. A number held only by a cancelled
 * grant is free (its row is released) and is recorded again (owner decision 2026-10-18).
 */
export async function recordStartGrant(
  tx: Tx,
  userId: string,
  phoneHash: string,
): Promise<RecordStartGrantResult> {
  const own = async (executor: Tx) => {
    const [row] = await executor
      .select({ id: startGrants.id })
      .from(startGrants)
      .where(eq(startGrants.userId, userId))
      .limit(1);
    return row;
  };
  const existing = await own(tx);
  if (existing) return { outcome: 'existing', grantId: existing.id };
  try {
    return await tx.transaction(async (savepoint) => {
      const [grant] = await savepoint
        .insert(startGrants)
        .values({ userId })
        .onConflictDoNothing({ target: startGrants.userId })
        .returning({ id: startGrants.id });
      if (!grant) {
        // A concurrent call recorded it and committed while this insert waited.
        const raced = await own(savepoint);
        if (!raced) throw new Error(`start grant of ${userId} vanished after a conflict`);
        return { outcome: 'existing', grantId: raced.id } as const;
      }
      const [held] = await savepoint
        .insert(startGrantNumbers)
        .values({ phoneHash, grantId: grant.id, source: 'grant' })
        .onConflictDoNothing()
        .returning({ grantId: startGrantNumbers.grantId });
      if (!held) throw new NumberAlreadyUsed();
      return { outcome: 'recorded', grantId: grant.id } as const;
    });
  } catch (error) {
    if (error instanceof NumberAlreadyUsed) return { outcome: 'number_already_used' };
    throw error;
  }
}

/**
 * What paying one start grant did (#70, ADR-0071):
 * - `granted`: this call paid it — the balance, the START_GRANT entry and the row, together;
 * - `already_granted`: it was paid before (by an earlier call or by the worker), nothing written;
 * - `cancelled`: its account withdrew while it waited and the withdrawal cancelled it
 *   (`cancelStartGrant`), nothing written — never paid now;
 * - `unverified`: the account has no 본인확인 record, though the grant was not cancelled (an
 *   operator removed it by hand, or a withdrawal that does not cancel), nothing written: the grant
 *   stays pending, and its numbers stay held;
 * - `pending`: the amount is undecided (`readAmount` gave null), nothing written: it waits.
 */
export type PayStartGrantResult =
  | { outcome: 'granted'; grant: StartGrantRow; balance: BalanceRow; ledgerEntry: LedgerRow }
  | { outcome: 'already_granted'; grant: StartGrantRow }
  | { outcome: 'cancelled'; grant: StartGrantRow }
  | { outcome: 'unverified'; grant: StartGrantRow }
  | { outcome: 'pending'; grant: StartGrantRow };

/**
 * Pays the start grant `grantId` if it is still pending: the one place the start Coin is paid,
 * shared by the API (the grant #58 asks for after the onboarding) and the worker (the per-minute
 * payment of the grants that waited for an amount), which PLAN 4.1 keeps from importing each
 * other — like `lockMarket` and `clockTimestamp`.
 *
 * Call it on the transaction handle; the payment is that transaction's. Its locks come in the one
 * order every writer of a grant takes them (ADR-0071): the account's 본인확인 record, the grant,
 * the balance.
 * 1. The grant's account, read without a lock (it never changes, migration 0031's trigger), then
 *    its 본인확인 record (`isPhoneVerified`, FOR KEY SHARE): no Coin to an account that has none
 *    (#70's acceptance: the payment needs #183's record). The lock keeps a withdrawal from deleting
 *    the record — and from cancelling the grant, which takes the record first (`cancelStartGrant`)
 *    — until this commits, so a payment never lands beside one; KEY SHARE does not hold up the
 *    member's edit of the real name, nor the API's grant, which holds the record FOR SHARE.
 * 2. The grant row FOR UPDATE: of two payers of one grant (a repeated call, the worker's scan),
 *    the second waits here and then finds it paid — one ledger entry, whatever races. A paid or
 *    cancelled grant ends here, and so does a pending one whose account has no record (1).
 * 3. `readAmount(tx)` once, after those locks (ADR-0055: a value is read once when its work begins
 *    and kept): the release setting `grant.start_coin`, whatever its status (ADR-0069 decision 7),
 *    or null while it is undecided, which leaves the grant pending (decision 4 #70). A changed
 *    value therefore applies to the grants paid after the change only (#57-2).
 * 4. The account's balance row FOR UPDATE, then the clock (`clockTimestamp`, after the last lock:
 *    the entry sorts after whatever committed while this waited), the balance, the START_GRANT
 *    entry (ref `start_grant` → the grant) and the grant row, all at that instant. No other balance
 *    writer locks the record or a grant row, and a withdrawal takes the record before the balance
 *    too, so a payment cannot deadlock with another balance writer.
 *
 * Throws a plain Error when the grant or the balance row does not exist (a broken account).
 */
export async function payStartGrant(
  tx: Tx,
  grantId: string,
  readAmount: (tx: Tx) => Promise<bigint | null>,
): Promise<PayStartGrantResult> {
  const [owner] = await tx
    .select({ userId: startGrants.userId })
    .from(startGrants)
    .where(eq(startGrants.id, grantId))
    .limit(1);
  if (!owner) throw new Error(`start grant ${grantId} does not exist`);
  const verified = await isPhoneVerified(tx, owner.userId, 'key share');
  const [grant] = await tx
    .select()
    .from(startGrants)
    .where(eq(startGrants.id, grantId))
    .limit(1)
    .for('update');
  if (!grant) throw new Error(`start grant ${grantId} does not exist`);
  const status = startGrantStatus(grant);
  if (status === 'granted') return { outcome: 'already_granted', grant };
  if (status === 'cancelled') return { outcome: 'cancelled', grant };
  if (!verified) return { outcome: 'unverified', grant };

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
    .where(
      and(
        eq(startGrants.id, grant.id),
        isNull(startGrants.grantedAt),
        isNull(startGrants.cancelledAt),
      ),
    )
    .returning();
  if (!balance || !ledgerEntry || !paid) {
    throw new Error(`start grant ${grant.id} could not be paid`);
  }
  return { outcome: 'granted', grant: paid, balance, ledgerEntry };
}

/**
 * What cancelling an account's start grant did (owner decision 2026-10-18, ADR-0071):
 * - `cancelled`: it was waiting for its amount; it is cancelled now and every number it held is
 *   free again (`released`, at the cancellation's instant) — nothing was ever paid, so the
 *   number's once is unused and the next account that verifies it can get the start Coin;
 * - `granted`: it was paid before; nothing changes — its numbers stay used, and the Coin is in the
 *   balance like any other (the withdrawal's 탈퇴 소멸, #57-16, is #140's);
 * - `already_cancelled`: an earlier call cancelled it; nothing changes;
 * - `none`: the account has no grant record (it never finished the onboarding, or verified a
 *   number that was used already); nothing to cancel.
 */
export type CancelStartGrantResult =
  | { outcome: 'cancelled'; grant: StartGrantRow; released: StartGrantNumberRow[] }
  | { outcome: 'granted'; grant: StartGrantRow }
  | { outcome: 'already_cancelled'; grant: StartGrantRow }
  | { outcome: 'none' };

/**
 * Cancels the start grant of `userId` if it still waits for its amount: the step the withdrawal
 * (#140) takes for the start Coin, inside its own transaction (owner decision 2026-10-18 — a grant
 * pending when its account withdraws is cancelled, and its number is not counted as having
 * received). Internal like the grant: no route calls it; nothing in this build does yet.
 *
 * Call it on the withdrawal's transaction handle BEFORE the withdrawal writes the balance (탈퇴
 * 소멸): the order of ADR-0071 is 본인확인 기록 → grant → balance, which every payer keeps
 * (`payStartGrant`, the API's grant), so taking the balance first could deadlock with a payment.
 * In order:
 * 1. The account's 본인확인 record FOR UPDATE, if it is still there — the withdrawal deletes it
 *    (#57-18) before or after this call; either way a payment waiting on it (KEY SHARE) resumes
 *    only after the withdrawal commits, finds no record and pays nothing, and a payment that holds
 *    it already commits first, so this then finds the grant paid (`granted`).
 * 2. The grant row FOR UPDATE, then, if it is pending, `cancelled_at` at the database clock.
 *    Migration 0031's triggers do the rest in the same statement: the grant never changes again
 *    (never paid later, never back to pending) and its numbers are released, kept as history.
 */
export async function cancelStartGrant(tx: Tx, userId: string): Promise<CancelStartGrantResult> {
  await tx
    .select({ held: sql`1` })
    .from(phoneVerifications)
    .where(eq(phoneVerifications.userId, userId))
    .for('update');
  const [grant] = await tx
    .select()
    .from(startGrants)
    .where(eq(startGrants.userId, userId))
    .limit(1)
    .for('update');
  if (!grant) return { outcome: 'none' };
  const status = startGrantStatus(grant);
  if (status === 'granted') return { outcome: 'granted', grant };
  if (status === 'cancelled') return { outcome: 'already_cancelled', grant };

  const cancelledAt = await clockTimestamp(tx);
  const [cancelled] = await tx
    .update(startGrants)
    .set({ cancelledAt })
    .where(
      and(
        eq(startGrants.id, grant.id),
        isNull(startGrants.grantedAt),
        isNull(startGrants.cancelledAt),
      ),
    )
    .returning();
  if (!cancelled) throw new Error(`start grant ${grant.id} could not be cancelled`);
  const released = await tx
    .select()
    .from(startGrantNumbers)
    .where(eq(startGrantNumbers.grantId, grant.id))
    .orderBy(asc(startGrantNumbers.createdAt), asc(startGrantNumbers.phoneHash));
  return { outcome: 'cancelled', grant: cancelled, released };
}

/**
 * The grants still waiting for an amount, oldest first (the partial index of migration 0031),
 * at most `limit` of them: the worker's scan pays them one transaction each.
 *
 * Only grants whose account still has its 본인확인 record: `payStartGrant` pays no other. A grant
 * whose account withdrew is cancelled by the withdrawal and is not pending; one whose record went
 * some other way (by hand) stays pending — left in, those rows would sort first for good and, once
 * there were `limit` of them, every run would spend itself on them and never reach a grant it
 * could pay.
 */
export async function pendingStartGrantIds(executor: Db | Tx, limit: number): Promise<string[]> {
  const rows = await executor
    .select({ id: startGrants.id })
    .from(startGrants)
    .where(
      and(
        isNull(startGrants.grantedAt),
        isNull(startGrants.cancelledAt),
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
