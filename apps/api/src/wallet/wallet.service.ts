import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { schema, type Db } from '@buddha/db';
import {
  decodeKeyset,
  encodeKeyset,
  serializePAmount,
  type Balance,
  type ChargeBody,
  type ChargeResult,
  type LedgerEntry,
  type Payment,
} from '@buddha/shared';
import { ChargePackageService } from './charge-package.service.js';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { PG_UNIQUE_VIOLATION, isPgError } from '../common/errors/pg-error.js';
import { DB } from '../infra/db/db.provider.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from '../payments/payment-provider.js';

type LedgerRow = typeof schema.ledgerEntries.$inferSelect;
type PaymentRow = typeof schema.payments.$inferSelect;

/** UNIQUE (user_id, idempotency_key) on payments (migration 0008). */
export const PAYMENT_IDEMPOTENCY_UNIQUE = 'payments_user_id_idempotency_key_unique';

/** The provider said no: recorded on the payment row, nothing credited (A-M2-2). */
function paymentRefused(reason?: string): AppError {
  return new AppError('VALIDATION_ERROR', {
    message: reason ?? 'The payment was refused',
    details: [{ path: ['amountP'], message: 'payment refused' }],
  });
}
/** The handle `db.transaction` hands its callback; @buddha/db exports no alias for it. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export function toLedgerEntry(row: LedgerRow): LedgerEntry {
  return {
    id: row.id.toString(),
    type: row.type,
    amountP: serializePAmount(row.amountP),
    balanceAfterP: serializePAmount(row.balanceAfterP),
    // The column is a plain varchar; the DTO narrows it to the known ref types.
    refType: (row.refType ?? null) as LedgerEntry['refType'],
    refId: row.refId,
    memo: row.memo,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    amountP: serializePAmount(row.amountP),
    priceKrw: row.priceKrw,
    packageId: row.packageId,
    provider: row.provider,
    providerRef: row.providerRef,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * Charging and reading the wallet (PLAN 5.1, 5.6, M2).
 *
 * Every balance change happens in the same transaction as its `ledger_entries` INSERT
 * (PLAN 0.2), and the balance moves with a conditional UPDATE rather than read-modify-write,
 * so concurrent charges add up instead of overwriting each other.
 */
@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly packages: ChargePackageService,
  ) {}

  /**
   * Buys one charge package (ADR-0026): users cannot name their own amount, so the P granted
   * and the KRW charged both come from the row the admin configured, and both are snapshotted
   * onto the payment.
   *
   * Idempotent per `idempotencyKey` (PLAN 5.4). A charge whose answer never reached the client
   * — committed, then the connection died — used to be bought again on the retry, because
   * every request minted its own payment id. Now a key this account has used before answers
   * with what that request did (`replay`), and a new key is reserved on a `pending` payments
   * row BEFORE the provider is asked, so a request racing on the same key loses on the unique
   * index and never reaches the provider a second time.
   */
  async charge(userId: string, body: ChargeBody, idempotencyKey: string): Promise<ChargeResult> {
    const earlier = await this.paymentByKey(userId, idempotencyKey);
    if (earlier) return this.replay(earlier, body);

    const { packageId } = body;
    const chargePackage = await this.packages.get(packageId);
    if (!chargePackage.isActive) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'This charge package is no longer available',
        details: [{ path: ['packageId'], message: 'inactive' }],
      });
    }
    const amountP = BigInt(chargePackage.amountP);
    const priceKrw = chargePackage.priceKrw;
    // Retired and deleted packages are already refused above and in `packages.get`; amount and
    // price are the other two things an admin may change under a catalogue that is still on
    // screen (and `useChargePackages` has no refetch interval, so "still on screen" has no
    // bound). Sell only the offer the user actually read — PLAN 5.3 guards a trade the same way.
    if (amountP !== body.expectedAmountP || priceKrw !== body.expectedPriceKrw) {
      throw new AppError('PRICE_MOVED', {
        message: 'This charge package has changed; reload and try again',
      });
    }
    const paymentId = randomUUID();
    // Reserve the key before the provider runs. Reservation and credit are separate
    // transactions on purpose: no lock can span the provider call, which runs outside any
    // transaction (A-M2-2), so the row itself is what a concurrent duplicate collides with.
    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(schema.payments).values({
          id: paymentId,
          userId,
          amountP,
          priceKrw,
          packageId: await this.pinnedPackageId(tx, packageId),
          provider: this.provider.name,
          status: 'pending',
          idempotencyKey,
        });
      });
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION, PAYMENT_IDEMPOTENCY_UNIQUE)) {
        const raced = await this.paymentByKey(userId, idempotencyKey);
        if (raced) return this.replay(raced, body);
      }
      throw error;
    }

    const outcome = await this.provider.charge({ paymentId, userId, amountP, priceKrw });

    if (outcome.status === 'failed') {
      // The reservation becomes the record of the refusal (no ledger entry, no balance
      // change) so support can see the attempt.
      await this.db
        .update(schema.payments)
        .set({ status: 'failed', providerRef: outcome.providerRef, updatedAt: new Date() })
        .where(eq(schema.payments.id, paymentId));
      this.logger.warn(`charge ${paymentId} refused by ${this.provider.name}`);
      throw paymentRefused(outcome.failureReason);
    }

    return this.db.transaction(async (tx) => {
      const [payment] = await tx
        .update(schema.payments)
        .set({ status: 'succeeded', providerRef: outcome.providerRef, updatedAt: new Date() })
        .where(eq(schema.payments.id, paymentId))
        .returning();

      const [balance] = await tx
        .update(schema.balances)
        .set({
          availableP: sql`${schema.balances.availableP} + ${amountP}`,
          updatedAt: new Date(),
        })
        .where(eq(schema.balances.userId, userId))
        .returning();
      // The "user" trigger creates the row at sign-up (PLAN 10.4); missing means a broken account.
      // Deliberately names no field: the web refetches the catalogue only for the 404 that
      // `packages.get` marks with `packageId`, and this one is not about the catalogue. The
      // rollback leaves the reservation `pending`: the provider has accepted, so that row is
      // the only record that this account is owed P.
      if (!payment || !balance) throw new AppError('NOT_FOUND', { message: 'Balance not found' });

      const [entry] = await tx
        .insert(schema.ledgerEntries)
        .values({
          userId,
          type: 'DEPOSIT',
          amountP,
          balanceAfterP: balance.availableP,
          refType: 'payment',
          refId: payment.id,
        })
        .returning();
      if (!entry) throw new AppError('INTERNAL', { message: 'Ledger insert failed' });

      return {
        payment: toPayment(payment),
        package: chargePackage,
        balance: toBalance(balance),
        ledgerEntry: toLedgerEntry(entry),
      };
    });
  }

  private async paymentByKey(
    userId: string,
    idempotencyKey: string,
  ): Promise<PaymentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.payments)
      .where(
        and(eq(schema.payments.userId, userId), eq(schema.payments.idempotencyKey, idempotencyKey)),
      )
      .limit(1);
    return row;
  }

  /**
   * The answer for a key this account has used before (PLAN 5.4). The client re-sends a key
   * only when the first answer never arrived, so this is the same purchase, not a new one.
   */
  private async replay(earlier: PaymentRow, body: ChargeBody): Promise<ChargeResult> {
    // Same key, different terms: a client bug or a re-used key, never a lost answer (PLAN 7.4
    // DUPLICATE_REQUEST). `packageId` is compared only while the payment still has one — an
    // admin deleting the package sets it to NULL (ADR-0026).
    if (
      earlier.amountP !== body.expectedAmountP ||
      earlier.priceKrw !== body.expectedPriceKrw ||
      (earlier.packageId !== null && earlier.packageId !== body.packageId)
    ) {
      throw new AppError('DUPLICATE_REQUEST', {
        message: 'This Idempotency-Key was already used for a different charge',
      });
    }
    switch (earlier.status) {
      case 'pending':
        // The first request is still running, or died between the provider and the commit.
        // Its outcome is unknown, so neither a success nor a second purchase would be honest.
        // A real gateway is reconciled by payment id — the reason ChargeRequest passes ours
        // as the merchant order id.
        throw new AppError('DUPLICATE_REQUEST', {
          message: 'A charge with this Idempotency-Key is still in progress',
        });
      case 'failed':
        throw paymentRefused();
      case 'succeeded': {
        // Written in the same transaction as the `succeeded` status, so a miss is corruption,
        // not a race. Filtered by user first: that is the indexed half of the lookup.
        const [entry] = await this.db
          .select()
          .from(schema.ledgerEntries)
          .where(
            and(
              eq(schema.ledgerEntries.userId, earlier.userId),
              eq(schema.ledgerEntries.refType, 'payment'),
              eq(schema.ledgerEntries.refId, earlier.id),
            ),
          )
          .limit(1);
        if (!entry) throw new AppError('INTERNAL', { message: 'Ledger entry missing for payment' });
        return {
          payment: toPayment(earlier),
          // Null once an admin removed the package; the payment keeps its own snapshot.
          package: earlier.packageId ? await this.packages.find(earlier.packageId) : null,
          balance: await this.getBalance(earlier.userId),
          ledgerEntry: toLedgerEntry(entry),
        };
      }
    }
  }

  async getBalance(userId: string): Promise<Balance> {
    const [row] = await this.db
      .select()
      .from(schema.balances)
      .where(eq(schema.balances.userId, userId))
      .limit(1);
    if (!row) throw new AppError('NOT_FOUND', { message: 'Balance not found' });
    return toBalance(row);
  }

  /**
   * The package id to store on a payment, pinned for the rest of the transaction.
   *
   * An admin may delete a package (ChargePackageService.remove) between the read at the top of
   * `charge` and the reservation insert. `ON DELETE SET NULL` governs what happens to rows that
   * already exist, not an insert naming a parent that is already gone — that violates the FK,
   * and the exception filter has no SQLSTATE branch, so the caller would get a 500 for a race
   * that is nobody's fault. FOR KEY SHARE makes a concurrent DELETE wait for this transaction,
   * and a package that is gone already simply loses its reference, which is the state SET NULL
   * would have produced a moment later (and does produce, for a package deleted while the
   * provider runs). The payment keeps its own amount and price snapshot either way, so no
   * history is lost (ADR-0026).
   */
  private async pinnedPackageId(tx: Tx, packageId: string): Promise<string | null> {
    const [row] = await tx
      .select({ id: schema.chargePackages.id })
      .from(schema.chargePackages)
      .where(eq(schema.chargePackages.id, packageId))
      .limit(1)
      .for('key share');
    return row?.id ?? null;
  }

  /** Newest first, keyset-paginated over (created_at, id) — see @buddha/shared pagination. */
  async listLedger(
    userId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<Page<LedgerEntry>> {
    const keyset = decodeKeyset(cursor, 'int');
    const rows = await this.db
      .select()
      .from(schema.ledgerEntries)
      .where(
        and(
          eq(schema.ledgerEntries.userId, userId),
          keyset
            ? or(
                lt(schema.ledgerEntries.createdAt, keyset.createdAt),
                and(
                  eq(schema.ledgerEntries.createdAt, keyset.createdAt),
                  lt(schema.ledgerEntries.id, Number(keyset.id)),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.ledgerEntries.createdAt), desc(schema.ledgerEntries.id))
      .limit(limit + 1);
    return page(
      rows,
      limit,
      (row) => ({ createdAt: row.createdAt, id: row.id.toString() }),
      toLedgerEntry,
    );
  }

  async listPayments(
    userId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<Page<Payment>> {
    const keyset = decodeKeyset(cursor, 'uuid');
    const rows = await this.db
      .select()
      .from(schema.payments)
      .where(
        and(
          eq(schema.payments.userId, userId),
          keyset
            ? or(
                lt(schema.payments.createdAt, keyset.createdAt),
                and(
                  eq(schema.payments.createdAt, keyset.createdAt),
                  lt(schema.payments.id, keyset.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.payments.createdAt), desc(schema.payments.id))
      .limit(limit + 1);
    return page(rows, limit, (row) => ({ createdAt: row.createdAt, id: row.id }), toPayment);
  }
}

export function toBalance(row: { availableP: bigint; lockedP: bigint }): Balance {
  return { availableP: serializePAmount(row.availableP), lockedP: serializePAmount(row.lockedP) };
}

/** Trims the `limit + 1` probe row and turns the last kept row into the next cursor. */
function page<Row, Item>(
  rows: Row[],
  limit: number,
  keyOf: (row: Row) => { createdAt: Date; id: string },
  toItem: (row: Row) => Item,
): Page<Item> {
  const hasMore = rows.length > limit;
  const kept = hasMore ? rows.slice(0, limit) : rows;
  const last = kept.at(-1);
  return {
    items: kept.map(toItem),
    nextCursor: hasMore && last ? encodeKeyset(keyOf(last)) : null,
  };
}
