import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  findLedgerAccount,
  ledgerEntryForAccount,
  ledgerKeys,
  lockLedgerAccounts,
  recordLedgerEntry,
  schema,
  type Db,
} from '@buddha/db';
import {
  decodeKeyset,
  encodeKeyset,
  memberLedgerEntryTypeSchema,
  serializeCoinAmount,
  type Balance,
  type ChargeBody,
  type ChargeResult,
  type LedgerEntry,
  type MemberReconciliationCorrection,
  type Payment,
  type PaymentStatus,
  type UserBalanceEvent,
} from '@buddha/shared';
import { ChargePackageService } from './charge-package.service.js';
import { and, desc, eq, getTableColumns, or, sql } from 'drizzle-orm';
import { assertExpectedAccount } from '../auth/expected-account.js';
import { AppError } from '../common/errors/app-error.js';
import { keysetPredicate } from '../common/keyset.js';
import { PG_UNIQUE_VIOLATION, isPgError } from '../common/errors/pg-error.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { netCancelConfirmed } from '../payments/payment-events.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from '../payments/payment-provider.js';
import { MarketPublisher } from '../realtime/market-publisher.js';

type LedgerRow = typeof schema.ledgerEntries.$inferSelect;
export type PaymentRow = typeof schema.payments.$inferSelect;

/** UNIQUE (user_id, idempotency_key) on payments (migration 0008). */
export const PAYMENT_IDEMPOTENCY_UNIQUE = 'payments_user_id_idempotency_key_unique';

/** The provider said no: recorded on the payment row, nothing credited (A-M2-2). */
function paymentRefused(reason?: string): AppError {
  return new AppError('VALIDATION_ERROR', {
    message: reason ?? 'The payment was refused',
    details: [{ path: ['amountCoin'], message: 'payment refused' }],
  });
}
/** The handle `db.transaction` hands its callback; @buddha/db exports no alias for it. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * One ledger event as the person whose user ledger account is `accountId` sees it (#116): signed
 * from that account's side, its total after it — never the other side of the move.
 */
export function toLedgerEntry(
  row: LedgerRow,
  accountId: number,
  correction: { id: string; userReason: string | null } | null = null,
): LedgerEntry {
  const seen = ledgerEntryForAccount(row, accountId);
  const corrected = row.type === 'RECONCILIATION_CORRECTION';
  return {
    id: row.id.toString(),
    // A person's account takes only these (MEMBER_LEDGER_ENTRY_TYPES; migration 0060's pairs).
    type: memberLedgerEntryTypeSchema.parse(row.type),
    amountCoin: serializeCoinAmount(seen.amountCoin),
    balanceAfterCoin: serializeCoinAmount(seen.balanceAfterCoin),
    // The column is a plain varchar; the DTO narrows it to the known ref types.
    // The stored event points at internal audit evidence. Members get only the public correction
    // record and its separately approved reason, never that failure id or an internal memo.
    // Pre-0065 entries have no correction record: keep their actual ledger history with an
    // explicit legacy reference, without inventing a completed approval or a public reason.
    refType: corrected ? 'reconciliation_correction' : (row.refType as LedgerEntry['refType']),
    refId: corrected ? (correction?.id ?? `legacy:${row.id}`) : row.refId,
    memo: corrected ? (correction?.userReason ?? null) : row.memo,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * `Payment.cancelConfirmed`, computed where the rows are: for a `cancelled` payment, whether the
 * card's cancel is confirmed (netCancelConfirmed); null for any other status. A net cancel that
 * got no clear answer — or is still waiting for one — leaves it false: the card may still be
 * charged. Only a PG with a payment window net-cancels; the mock never does.
 */
const cancelConfirmed = sql<
  boolean | null
>`case when ${schema.payments.status} = 'cancelled' then ${netCancelConfirmed} end`;

/** A payment row with what `Payment` adds to it, as `paymentColumns` selects it. */
export type PaymentView = PaymentRow & { cancelConfirmed: boolean | null };

/** Every column of `payments`, and `cancelConfirmed`: a select that toPayment can answer from. */
export const paymentColumns = { ...getTableColumns(schema.payments), cancelConfirmed };

export function toPayment(row: PaymentView): Payment {
  return {
    id: row.id,
    amountCoin: serializeCoinAmount(row.amountCoin),
    priceKrw: row.priceKrw,
    packageId: row.packageId,
    provider: row.provider,
    providerRef: row.providerRef,
    status: row.status,
    method: row.method,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    refundedAt: row.refundedAt?.toISOString() ?? null,
    resultMessage: row.resultMessage,
    cancelConfirmed: row.cancelConfirmed,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** The `user:balance` event of one balance change (PLAN 8), keyed by its ledger row. */
export function balanceEvent(
  balance: { availableCoin: bigint; lockedCoin: bigint },
  entry: LedgerRow,
): UserBalanceEvent {
  return {
    type: 'user:balance',
    availableCoin: serializeCoinAmount(balance.availableCoin),
    lockedCoin: serializeCoinAmount(balance.lockedCoin),
    ledgerEntryId: entry.id.toString(),
    ts: entry.createdAt.toISOString(),
  };
}

/** What a package sells for, read and checked against what the client showed (`quote`). */
export interface Quote {
  amountCoin: bigint;
  priceKrw: number;
}

export interface ReservationInput extends Quote {
  userId: string;
  packageId: string;
  /** `payments.provider` of the new row. */
  provider: string;
  idempotencyKey: string;
}

/** A new `pending` row, or the row an earlier request with the same key already holds. */
export type Reservation = { paymentId: string } | { earlier: PaymentRow };

export interface CreditInput {
  paymentId: string;
  userId: string;
  amountCoin: bigint;
  /** `payments.provider_ref`: the provider's transaction id. */
  providerRef: string;
  /** The PG's PayMethod of the approval (CARD, KAKAO, …); null for the mock. */
  method: string | null;
  /** The PG's result message; null for the mock. */
  resultMessage: string | null;
}

/**
 * `credited`: this call moved the payment to `succeeded` and credited the Coin. Otherwise the
 * payment was not `pending` any more — another request settled it first — and `status` is what
 * it is now (undefined: the row is gone).
 */
export type CreditOutcome =
  { credited: true; result: ChargeResult } | { credited: false; status: PaymentStatus | undefined };

/**
 * `creditWithin`'s answer inside the transaction: the credit and the `user:balance` event to
 * publish after COMMIT, or — nothing credited — the status the payment has now.
 */
export type CreditTxOutcome =
  { result: ChargeResult; event: UserBalanceEvent } | { status?: PaymentStatus };

/**
 * Charging and reading the wallet (PLAN 5.1, 5.6, M2).
 *
 * Every balance change is one ledger event in the same transaction (`recordLedgerEntry`, PLAN
 * 0.2, #116), which moves the balance under its row lock with an UPDATE relative to the row
 * rather than read-modify-write, so concurrent charges add up instead of overwriting each other.
 */
@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly packages: ChargePackageService,
    private readonly publisher: MarketPublisher,
  ) {}

  /**
   * Buys one charge package (ADR-0026): users cannot name their own amount, so the Coin granted
   * and the KRW charged both come from the row the admin configured, and both are snapshotted
   * onto the payment.
   *
   * Idempotent per `idempotencyKey` (PLAN 5.4). A charge whose answer never reached the client
   * — committed, then the connection died — used to be bought again on the retry, because
   * every request minted its own payment id. Now a key this account has used before answers
   * with what that request did (`replay`), and a new key is reserved on a `pending` payments
   * row BEFORE the provider is asked, so a request racing on the same key loses on the unique
   * index and never reaches the provider a second time.
   *
   * The immediate flow exists only while the configured provider can settle in one call (the
   * mock); under a provider with a payment window it is a 404 (ADR-0042). Paid Coin being off
   * closes it before this runs (PaidCoinSalesGuard, ADR-0049).
   */
  async charge(userId: string, body: ChargeBody, idempotencyKey: string): Promise<ChargeResult> {
    const provider = this.provider;
    if (!provider.charge) {
      throw new AppError('NOT_FOUND', {
        message: `Immediate charge is unavailable with the ${provider.name} provider`,
      });
    }
    // First of all (see assertExpectedAccount): credited to the cookie's account while the
    // screen shows another, the client's idempotency key would also sit under the wrong
    // account, and a lost answer would then turn into a second purchase.
    assertExpectedAccount(userId, body.expectedAccountId);
    const earlier = await this.paymentByKey(userId, idempotencyKey);
    if (earlier) return this.replay(earlier, body);

    const { amountCoin, priceKrw } = await this.quote(body);
    // The "user" trigger creates the balance row at sign-up (PLAN 10.4); missing means a broken
    // account. Checked before anything is reserved or charged: found out only after the
    // provider had accepted, the failed credit would leave a `pending` reservation the client
    // can retry into nothing but 404s — and, the key once spent, into further provider calls.
    // Names no field: the web refetches the catalogue only for the 404 that `packages.get`
    // marks with `packageId`, and this one is not about the catalogue.
    await this.getBalance(userId);

    const reservation = await this.reservePayment({
      userId,
      amountCoin,
      priceKrw,
      packageId: body.packageId,
      provider: provider.name,
      idempotencyKey,
    });
    if ('earlier' in reservation) return this.replay(reservation.earlier, body);
    const { paymentId } = reservation;

    const outcome = await provider.charge({ paymentId, userId, amountCoin, priceKrw });

    if (outcome.status === 'failed') {
      // The reservation becomes the record of the refusal (no ledger entry, no balance
      // change) so support can see the attempt.
      await this.db
        .update(schema.payments)
        .set({ status: 'failed', providerRef: outcome.providerRef, updatedAt: new Date() })
        .where(eq(schema.payments.id, paymentId));
      this.logger.warn(`charge ${paymentId} refused by ${provider.name}`);
      throw paymentRefused(outcome.failureReason);
    }

    const credit = await this.creditPayment({
      paymentId,
      userId,
      amountCoin,
      providerRef: outcome.providerRef,
      method: null,
      resultMessage: null,
    });
    if (!credit.credited) {
      // Nothing else settles a mock reservation, so a payment that left `pending` meanwhile was
      // changed by hand or deleted: a 500 that keeps the client's key, never a second charge.
      this.logger.error(
        `charge ${paymentId} accepted by ${provider.name} (${outcome.providerRef}) but not credited: the payment is ${credit.status ?? 'gone'}`,
      );
      throw new AppError('INTERNAL', { message: 'Payment left pending before its credit' });
    }
    return credit.result;
  }

  /**
   * The package checks the charge runs, in order: it exists (404 naming `packageId`), it is on
   * sale, and it still sells the terms the client showed (PRICE_MOVED).
   */
  async quote(body: ChargeBody): Promise<Quote> {
    const chargePackage = await this.packages.get(body.packageId);
    if (!chargePackage.isActive) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'This charge package is no longer available',
        details: [{ path: ['packageId'], message: 'inactive' }],
      });
    }
    const amountCoin = BigInt(chargePackage.amountCoin);
    const priceKrw = chargePackage.priceKrw;
    // Retired and deleted packages are already refused above and in `packages.get`; amount and
    // price are the other two things an admin may change under a catalogue that is still on
    // screen (and `useChargePackages` has no refetch interval, so "still on screen" has no
    // bound). Sell only the offer the user actually read.
    if (amountCoin !== body.expectedAmountCoin || priceKrw !== body.expectedPriceKrw) {
      throw new AppError('PRICE_MOVED', {
        message: 'This charge package has changed; reload and try again',
      });
    }
    return { amountCoin, priceKrw };
  }

  /**
   * Reserves the key on a new `pending` payment BEFORE any provider is asked. Reservation and
   * credit are separate transactions on purpose: no lock can span a provider call, which runs
   * outside any transaction (A-M2-2), so the row itself is what a concurrent duplicate collides
   * with — the loser of the unique index gets the winner's row back as `earlier`.
   */
  async reservePayment(input: ReservationInput): Promise<Reservation> {
    const paymentId = randomUUID();
    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(schema.payments).values({
          id: paymentId,
          userId: input.userId,
          amountCoin: input.amountCoin,
          priceKrw: input.priceKrw,
          packageId: await this.pinnedPackageId(tx, input.packageId),
          provider: input.provider,
          status: 'pending',
          idempotencyKey: input.idempotencyKey,
        });
      });
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION, PAYMENT_IDEMPOTENCY_UNIQUE)) {
        const raced = await this.paymentByKey(input.userId, input.idempotencyKey);
        if (raced) return { earlier: raced };
      }
      throw error;
    }
    return { paymentId };
  }

  /**
   * Credits a payment the provider has accepted, in ONE transaction: the payment moves to
   * `succeeded` (with the provider's reference, method and message, and `approved_at`), and a
   * DEPOSIT event — a mint into the account's user ledger account, kept as an inactive type (#116,
   * ADR-0107 결정 2 #73 2항), keyed by the payment — grows the balance by its Coin
   * (`recordLedgerEntry`): the one place that can credit a payment.
   *
   * NEVER TWICE: the payment UPDATE is guarded by `status = 'pending'`, so of two callers racing
   * on one payment exactly one matches the row; the other gets `credited: false` and the status
   * the winner left.
   *
   * LOCK ORDER — the balance row first, then the payment row, in every transaction that takes
   * both (this one, the admin refund's claw-back and its compensation): two orders would let a
   * credit and a refund of one account deadlock. The clock is read after the balance lock:
   * another writer of this account may have committed while this transaction waited, and the
   * ledger row written below must sort after it — `now()` is the transaction start and would
   * sort before work its own total after includes (clock.ts, A-M3-14).
   *
   * `user:balance` is published after COMMIT (PLAN 8), like every other balance change.
   */
  async creditPayment(input: CreditInput): Promise<CreditOutcome> {
    const outcome = await this.db.transaction((tx) => this.creditWithin(tx, input));
    if (!('result' in outcome)) return { credited: false, status: outcome.status };
    await this.publisher.publishUser(input.userId, outcome.event);
    return { credited: true, result: outcome.result };
  }

  /** creditPayment's transaction; the caller publishes the returned `event` after COMMIT. */
  private async creditWithin(tx: Tx, input: CreditInput): Promise<CreditTxOutcome> {
    // The lock `recordLedgerEntry` below takes again (a no-op then), held from here. The balance
    // row was seen before the reservation, so a miss here (no ledger account or balance row: a
    // broken database since migration 0060, which lets the app delete neither) is a 500, not a
    // client error, which the web answers by keeping its key, so the retry replays the
    // reservation as in progress instead of buying again. The rollback leaves the payment
    // pending; the provider has accepted, so that row is the only record that this account is
    // owed Coin.
    try {
      await lockLedgerAccounts(tx, [{ kind: 'user', userId: input.userId }]);
    } catch (error) {
      // Loud, with the provider's reference: the row that would carry it rolls back here.
      this.logger.error(
        `payment ${input.paymentId} accepted (${input.providerRef}) but not credited: ${error instanceof Error ? error.message : 'balance row not locked'}; payment left pending`,
      );
      throw new AppError('INTERNAL', {
        message: 'Balance row missing after the provider accepted',
        cause: error,
      });
    }
    const creditedAt = await clockTimestamp(tx);

    // Approved at the instant it is credited: the same clock as the ledger row, so the admin
    // refund window (PAYMENT_REFUND_WINDOW_DAYS) counts from the moment the Coin arrived.
    const [payment] = await tx
      .update(schema.payments)
      .set({
        status: 'succeeded',
        providerRef: input.providerRef,
        method: input.method,
        resultMessage: input.resultMessage,
        approvedAt: creditedAt,
        updatedAt: creditedAt,
      })
      .where(
        and(
          eq(schema.payments.id, input.paymentId),
          eq(schema.payments.userId, input.userId),
          eq(schema.payments.status, 'pending'),
        ),
      )
      .returning();
    if (!payment) {
      const [current] = await tx
        .select({ status: schema.payments.status })
        .from(schema.payments)
        .where(eq(schema.payments.id, input.paymentId))
        .limit(1);
      return { status: current?.status };
    }

    const recorded = await recordLedgerEntry(tx, {
      type: 'DEPOSIT',
      amountCoin: input.amountCoin,
      from: null,
      to: { kind: 'user', userId: input.userId },
      refType: 'payment',
      refId: payment.id,
      idempotencyKey: ledgerKeys.deposit(payment.id),
      at: creditedAt,
    });
    // The payment was pending under its own UPDATE above, so its key cannot have been recorded.
    if (recorded.outcome !== 'recorded' || !recorded.to) {
      throw new AppError('INTERNAL', { message: 'Ledger insert failed' });
    }
    const { entry, to: balance } = recorded;

    return {
      result: {
        // Just credited: `succeeded`, so there is no cancel to confirm.
        payment: toPayment({ ...payment, cancelConfirmed: null }),
        balance: toBalance(balance),
        ledgerEntry: toLedgerEntry(entry, balance.accountId),
      },
      event: balanceEvent(balance, entry),
    };
  }

  async paymentByKey(userId: string, idempotencyKey: string): Promise<PaymentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(schema.payments)
      .where(
        and(eq(schema.payments.userId, userId), eq(schema.payments.idempotencyKey, idempotencyKey)),
      )
      .limit(1);
    return row;
  }

  /** One of the caller's own payments (`GET /me/payments/:id`); anyone else's is a 404. */
  async getPayment(userId: string, paymentId: string): Promise<Payment> {
    const [row] = await this.db
      .select(paymentColumns)
      .from(schema.payments)
      .where(and(eq(schema.payments.id, paymentId), eq(schema.payments.userId, userId)))
      .limit(1);
    if (!row) throw new AppError('NOT_FOUND', { message: 'Payment not found' });
    return toPayment(row);
  }

  /**
   * The answer for a key this account has used before (PLAN 5.4). The client re-sends a key
   * only when the first answer never arrived, so this is the same purchase, not a new one.
   */
  private async replay(earlier: PaymentRow, body: ChargeBody): Promise<ChargeResult> {
    // Judged before the terms are compared: a client that re-sends its key while the first
    // request is still running may well hold a refreshed catalogue by now (a focus refetch),
    // and answering the terms mismatch would tell it the key is spent — so its next click
    // would open a second purchase while the first commits. Its outcome is unknown, so
    // neither a success nor a second purchase would be honest. A real gateway is reconciled by
    // payment id — the reason ChargeRequest passes ours as the merchant order id. The detail
    // names the header: unlike the different-terms 409 below, this one asks the client to KEEP
    // its key and come back, so the next click collects this purchase instead of opening
    // another. (With the mock provider the window is milliseconds; it matters for a real PG.)
    if (earlier.status === 'pending') {
      throw new AppError('DUPLICATE_REQUEST', {
        message: 'A charge with this Idempotency-Key is still in progress',
        details: [{ path: ['Idempotency-Key'], message: 'in progress' }],
      });
    }
    // Same key, different terms: a client bug or a re-used key, never a lost answer (PLAN 7.4
    // DUPLICATE_REQUEST). `packageId` is compared only while the payment still has one — an
    // admin deleting the package sets it to NULL (ADR-0026). No detail, so the client spends
    // the key: the purchase this key names has happened, and the next click is a new one.
    if (
      earlier.amountCoin !== body.expectedAmountCoin ||
      earlier.priceKrw !== body.expectedPriceKrw ||
      (earlier.packageId !== null && earlier.packageId !== body.packageId)
    ) {
      throw new AppError('DUPLICATE_REQUEST', {
        message: 'This Idempotency-Key was already used for a different charge',
      });
    }
    if (earlier.status === 'failed') throw paymentRefused();

    // Written in the same transaction as the `succeeded` status, so a miss is corruption, not
    // a race. By its key (unique per type): the DEPOSIT only — an admin refund writes
    // PAYMENT_CANCEL (and, if the PG refused, PAYMENT_CANCEL_REVERSAL) under the same reference,
    // and the charge's answer is the credit, never the claw-back.
    const [entry] = await this.db
      .select()
      .from(schema.ledgerEntries)
      .where(
        and(
          eq(schema.ledgerEntries.type, 'DEPOSIT'),
          eq(schema.ledgerEntries.idempotencyKey, ledgerKeys.deposit(earlier.id)),
        ),
      )
      .limit(1);
    if (!entry?.toAccountId) {
      throw new AppError('INTERNAL', { message: 'Ledger entry missing for payment' });
    }
    // Rebuilt from the rows the first request wrote — never from the catalogue, which an admin
    // may have re-priced since (ADR-0026); the payment carries the terms actually bought.
    return {
      // Credited once (its DEPOSIT is above): never `cancelled`, so no cancel to confirm.
      payment: toPayment({ ...earlier, cancelConfirmed: null }),
      balance: await this.getBalance(earlier.userId),
      ledgerEntry: toLedgerEntry(entry, entry.toAccountId),
    };
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

  /** Completed corrections only, explicitly projected for this member rather than their admin. */
  async listCorrections(
    userId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<Page<MemberReconciliationCorrection>> {
    const keyset = decodeKeyset(cursor, 'uuid');
    const corrections = schema.reconciliationCorrections;
    const rows = await this.db
      .select({
        id: corrections.id,
        eventId: corrections.eventId,
        mode: corrections.mode,
        amountCoin: corrections.amountCoin,
        balanceDeltaCoin: corrections.balanceDeltaCoin,
        balanceAfterCoin: corrections.balanceAfterCoin,
        userReason: corrections.userReason,
        createdAt: corrections.createdAt,
      })
      .from(corrections)
      .where(
        and(
          eq(corrections.userId, userId),
          keyset
            ? keysetPredicate(corrections.createdAt, corrections.id, keyset, 'uuid')
            : undefined,
        ),
      )
      .orderBy(desc(corrections.createdAt), desc(corrections.id))
      .limit(limit + 1);
    return page(
      rows,
      limit,
      (row) => ({ createdAt: row.createdAt, id: row.id }),
      (row) => {
        if (row.userReason === null)
          throw new AppError('INTERNAL', { message: 'Completed member correction has no reason' });
        return {
          id: row.id,
          eventId: String(row.eventId),
          mode: row.mode,
          amountCoin: serializeCoinAmount(row.amountCoin),
          balanceDeltaCoin: serializeCoinAmount(row.balanceDeltaCoin),
          balanceAfterCoin: serializeCoinAmount(row.balanceAfterCoin),
          userReason: row.userReason,
          createdAt: row.createdAt.toISOString(),
        };
      },
    );
  }

  /**
   * The events of the caller's own user ledger account, either side (#116), newest first,
   * keyset-paginated over (created_at, id). Actual-only restorations have no ledger row and
   * appear solely in the completed correction history.
   */
  async listLedger(
    userId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<Page<LedgerEntry>> {
    const keyset = decodeKeyset(cursor, 'int');
    const account = await findLedgerAccount(this.db, { kind: 'user', userId });
    if (!account) return { items: [], nextCursor: null };
    const rows = await this.db
      .select({
        entry: schema.ledgerEntries,
        correction: {
          id: schema.reconciliationCorrections.id,
          userReason: schema.reconciliationCorrections.userReason,
        },
      })
      .from(schema.ledgerEntries)
      .leftJoin(
        schema.reconciliationCorrections,
        and(
          eq(schema.reconciliationCorrections.ledgerEntryId, schema.ledgerEntries.id),
          eq(schema.reconciliationCorrections.userId, userId),
        ),
      )
      .where(
        and(
          // Each side has its own (account, created_at, id) index (migration 0060).
          or(
            eq(schema.ledgerEntries.fromAccountId, account.id),
            eq(schema.ledgerEntries.toAccountId, account.id),
          ),
          keyset
            ? keysetPredicate(
                schema.ledgerEntries.createdAt,
                schema.ledgerEntries.id,
                keyset,
                'bigint',
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.ledgerEntries.createdAt), desc(schema.ledgerEntries.id))
      .limit(limit + 1);
    return page(
      rows,
      limit,
      (row) => ({ createdAt: row.entry.createdAt, id: row.entry.id.toString() }),
      (row) => toLedgerEntry(row.entry, account.id, row.correction),
    );
  }

  async listPayments(
    userId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<Page<Payment>> {
    const keyset = decodeKeyset(cursor, 'uuid');
    const rows = await this.db
      .select(paymentColumns)
      .from(schema.payments)
      .where(
        and(
          eq(schema.payments.userId, userId),
          keyset
            ? keysetPredicate(schema.payments.createdAt, schema.payments.id, keyset, 'uuid')
            : undefined,
        ),
      )
      .orderBy(desc(schema.payments.createdAt), desc(schema.payments.id))
      .limit(limit + 1);
    return page(rows, limit, (row) => ({ createdAt: row.createdAt, id: row.id }), toPayment);
  }
}

export function toBalance(row: { availableCoin: bigint; lockedCoin: bigint }): Balance {
  return {
    availableCoin: serializeCoinAmount(row.availableCoin),
    lockedCoin: serializeCoinAmount(row.lockedCoin),
  };
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
