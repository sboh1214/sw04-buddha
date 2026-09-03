import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { schema, type Db } from '@buddha/db';
import {
  decodeKeyset,
  encodeKeyset,
  serializePAmount,
  type Balance,
  type ChargeResult,
  type LedgerEntry,
  type Payment,
} from '@buddha/shared';
import { ChargePackageService } from './charge-package.service.js';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { DB } from '../infra/db/db.provider.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from '../payments/payment-provider.js';

type LedgerRow = typeof schema.ledgerEntries.$inferSelect;
type PaymentRow = typeof schema.payments.$inferSelect;

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
   */
  async charge(userId: string, packageId: string): Promise<ChargeResult> {
    const chargePackage = await this.packages.get(packageId);
    if (!chargePackage.isActive) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'This charge package is no longer available',
        details: [{ path: ['packageId'], message: 'inactive' }],
      });
    }
    const amountP = BigInt(chargePackage.amountP);
    const priceKrw = chargePackage.priceKrw;
    const paymentId = randomUUID();
    const outcome = await this.provider.charge({ paymentId, userId, amountP, priceKrw });

    if (outcome.status === 'failed') {
      // Record the attempt (no ledger entry, no balance change) so support can see it.
      await this.db.insert(schema.payments).values({
        id: paymentId,
        userId,
        amountP,
        priceKrw,
        packageId,
        provider: this.provider.name,
        providerRef: outcome.providerRef,
        status: 'failed',
      });
      this.logger.warn(`charge ${paymentId} refused by ${this.provider.name}`);
      throw new AppError('VALIDATION_ERROR', {
        message: outcome.failureReason ?? 'The payment was refused',
        details: [{ path: ['amountP'], message: 'payment refused' }],
      });
    }

    return this.db.transaction(async (tx) => {
      const [payment] = await tx
        .insert(schema.payments)
        .values({
          id: paymentId,
          userId,
          amountP,
          priceKrw,
          packageId,
          provider: this.provider.name,
          providerRef: outcome.providerRef,
          status: 'succeeded',
        })
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

  async getBalance(userId: string): Promise<Balance> {
    const [row] = await this.db
      .select()
      .from(schema.balances)
      .where(eq(schema.balances.userId, userId))
      .limit(1);
    if (!row) throw new AppError('NOT_FOUND', { message: 'Balance not found' });
    return toBalance(row);
  }

  /** Newest first, keyset-paginated over (created_at, id) — see @buddha/shared pagination. */
  async listLedger(
    userId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<Page<LedgerEntry>> {
    const keyset = decodeKeyset(cursor);
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
    const keyset = decodeKeyset(cursor);
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
