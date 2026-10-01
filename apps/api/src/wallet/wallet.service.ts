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
  type PaymentStatus,
  type UserBalanceEvent,
} from '@buddha/shared';
import { ChargePackageService } from './charge-package.service.js';
import { and, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
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

/**
 * `Payment.cancelConfirmed`, computed where the rows are: for a `cancelled` payment, whether the
 * card's cancel is confirmed (netCancelConfirmed); null for any other status. A net cancel that
 * got no clear answer — or is still waiting for one — leaves it false: the card may still be
 * charged, and an admin settles it (the admin list's `needsReview`).
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
    amountP: serializePAmount(row.amountP),
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
  balance: { availableP: bigint; lockedP: bigint },
  entry: LedgerRow,
): UserBalanceEvent {
  return {
    type: 'user:balance',
    availableP: serializePAmount(balance.availableP),
    lockedP: serializePAmount(balance.lockedP),
    ledgerEntryId: entry.id.toString(),
    ts: entry.createdAt.toISOString(),
  };
}

/** What a package sells for, read and checked against what the client showed (`quote`). */
export interface Quote {
  amountP: bigint;
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
  amountP: bigint;
  /**
   * The statuses this credit may move to `succeeded`. `['pending']` for a charge that is still
   * ours to settle; SmartroPay's 재통보 also passes `failed`, because the PG's approval outranks
   * a failure we recorded on our side (ADR-0042 「재통보」). Anything else is left alone.
   */
  from: readonly PaymentStatus[];
  /** `payments.provider_ref`: the provider's transaction id (SmartroPay: the approval's Tid). */
  providerRef: string;
  /** The PG's PayMethod of the approval (CARD, KAKAO, …); null for the mock. */
  method: string | null;
  /** The PG's ResultMsg; null for the mock. */
  resultMessage: string | null;
  /**
   * Asked with the payment as locked — its row's lock taken after the balance row's, before
   * anything moves — while it is still in `from`: true holds the credit back (nothing written,
   * `heldBack`). SmartroPay's approvals (the ReturnUrl's and the 재통보's: cancelNoticeHold) hold
   * back a card a cancel 재통보 is on record for, judged under the lock that notice's own
   * transaction takes.
   */
  holdBack?: (tx: Tx, payment: PaymentRow) => Promise<boolean>;
}

/**
 * `credited`: this call moved the payment to `succeeded` and credited the P. Otherwise the
 * payment was not in `from` any more — another request settled it first — and `status` is what
 * it is now (undefined: the row is gone); or `holdBack` held it back (`heldBack`).
 */
export type CreditOutcome =
  | { credited: true; result: ChargeResult }
  | { credited: false; status: PaymentStatus | undefined; heldBack?: true };

/**
 * `creditWithin`'s answer inside the transaction: the credit and the `user:balance` event to
 * publish after COMMIT, or — nothing credited — the status the payment has now.
 */
export type CreditTxOutcome =
  { result: ChargeResult; event: UserBalanceEvent } | { status?: PaymentStatus; heldBack?: true };

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
    private readonly publisher: MarketPublisher,
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
   *
   * The immediate flow exists only while the configured provider can settle in one call (the
   * mock). Under SmartroPay it is a 404: the charge goes through `/payments/smartro/prepare`
   * and the payment window instead (ADR-0042).
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

    const { amountP, priceKrw } = await this.quote(body);
    // The "user" trigger creates the balance row at sign-up (PLAN 10.4); missing means a broken
    // account. Checked before anything is reserved or charged: found out only after the
    // provider had accepted, the failed credit would leave a `pending` reservation the client
    // can retry into nothing but 404s — and, the key once spent, into further provider calls.
    // Names no field: the web refetches the catalogue only for the 404 that `packages.get`
    // marks with `packageId`, and this one is not about the catalogue.
    await this.getBalance(userId);

    const reservation = await this.reservePayment({
      userId,
      amountP,
      priceKrw,
      packageId: body.packageId,
      provider: provider.name,
      idempotencyKey,
    });
    if ('earlier' in reservation) return this.replay(reservation.earlier, body);
    const { paymentId } = reservation;

    const outcome = await provider.charge({ paymentId, userId, amountP, priceKrw });

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
      amountP,
      from: ['pending'],
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
   * The package checks both charge flows run, in order: it exists (404 naming `packageId`), it
   * is on sale, and it still sells the terms the client showed (PRICE_MOVED).
   */
  async quote(body: ChargeBody): Promise<Quote> {
    const chargePackage = await this.packages.get(body.packageId);
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
    return { amountP, priceKrw };
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
          amountP: input.amountP,
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
   * `succeeded` (with the provider's reference, method and message, and `approved_at`), the
   * balance grows by its P, and a DEPOSIT ledger row records it. Shared by the mock charge and
   * every SmartroPay path (return, 재통보), so there is one place that can credit a payment.
   *
   * NEVER TWICE: the payment UPDATE is guarded by `status IN (from)`, so of two callers racing
   * on one payment (a ReturnUrl double submit, a 재통보 arriving mid-approval) exactly one
   * matches the row; the other gets `credited: false` and the status the winner left.
   *
   * LOCK ORDER — the balance row first, then the payment row, in every transaction that takes
   * both (this one, the admin refund's claw-back and its compensation): two orders would let a
   * credit and a refund of one account deadlock. The single-statement payment UPDATEs of the
   * callbacks (claim, fail, cancel) hold no balance lock, so they cannot join a cycle. The
   * clock is read after the balance lock: another writer of this account may have committed
   * while this transaction waited, and the ledger row written below must sort after it —
   * `now()` is the transaction start and would sort before work its own balance_after_p
   * includes (clock.ts, A-M3-14).
   *
   * `user:balance` is published after COMMIT (PLAN 8): a credit that arrives by callback has no
   * HTTP answer to carry the new balance to the screen.
   */
  async creditPayment(input: CreditInput): Promise<CreditOutcome> {
    const outcome = await this.db.transaction((tx) => this.creditWithin(tx, input));
    if (!('result' in outcome)) {
      return outcome.heldBack
        ? { credited: false, status: outcome.status, heldBack: true }
        : { credited: false, status: outcome.status };
    }
    await this.publisher.publishUser(input.userId, outcome.event);
    return { credited: true, result: outcome.result };
  }

  /**
   * creditPayment's transaction, run inside the caller's: for a caller that must commit more
   * with the credit (the admin settle writes its audit row in it). The caller publishes the
   * returned `event` after COMMIT, and — the lock order above — locks the balance row before
   * anything else it locks, the payment row included.
   */
  async creditWithin(tx: Tx, input: CreditInput): Promise<CreditTxOutcome> {
    // The lock is what the balance UPDATE below would take anyway; the result is discarded,
    // and a vanished row still falls through to the check that UPDATE has.
    await tx
      .select({ userId: schema.balances.userId })
      .from(schema.balances)
      .where(eq(schema.balances.userId, input.userId))
      .limit(1)
      .for('update');
    if (input.holdBack) {
      const [locked] = await tx
        .select()
        .from(schema.payments)
        .where(
          and(eq(schema.payments.id, input.paymentId), eq(schema.payments.userId, input.userId)),
        )
        .limit(1)
        .for('update');
      if (locked && input.from.includes(locked.status) && (await input.holdBack(tx, locked))) {
        return { status: locked.status, heldBack: true };
      }
    }
    const creditedAt = await clockTimestamp(tx);

    // Approved at the instant it is credited: the same clock as the ledger row, so the admin
    // refund window (PAYMENT_REFUND_WINDOW_DAYS) counts from the moment the P arrived.
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
          inArray(schema.payments.status, [...input.from]),
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

    const [balance] = await tx
      .update(schema.balances)
      .set({
        availableP: sql`${schema.balances.availableP} + ${input.amountP}`,
        // Explicit on purpose: the column's `$onUpdate` would write the API host's clock.
        updatedAt: creditedAt,
      })
      .where(eq(schema.balances.userId, input.userId))
      .returning();
    // The balance row was seen before the reservation, so a miss here is a race with a
    // DELETE, not a client error: a 500, which the web answers by keeping its key, so the
    // retry replays the reservation as in progress instead of buying again. The rollback
    // leaves the payment where it was; the provider has accepted, so that row is the only
    // record that this account is owed P.
    if (!balance) {
      // Loud, with the provider's reference: the row that would carry it rolls back here.
      this.logger.error(
        `payment ${input.paymentId} accepted (${input.providerRef}) but not credited: balance row vanished; payment left ${input.from.join('/')}`,
      );
      throw new AppError('INTERNAL', {
        message: 'Balance row vanished after the provider accepted',
      });
    }

    const [entry] = await tx
      .insert(schema.ledgerEntries)
      .values({
        userId: input.userId,
        type: 'DEPOSIT',
        amountP: input.amountP,
        balanceAfterP: balance.availableP,
        refType: 'payment',
        refId: payment.id,
        createdAt: creditedAt,
      })
      .returning();
    if (!entry) throw new AppError('INTERNAL', { message: 'Ledger insert failed' });

    return {
      result: {
        // Just credited: `succeeded`, so there is no cancel to confirm.
        payment: toPayment({ ...payment, cancelConfirmed: null }),
        balance: toBalance(balance),
        ledgerEntry: toLedgerEntry(entry),
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
      earlier.amountP !== body.expectedAmountP ||
      earlier.priceKrw !== body.expectedPriceKrw ||
      (earlier.packageId !== null && earlier.packageId !== body.packageId)
    ) {
      throw new AppError('DUPLICATE_REQUEST', {
        message: 'This Idempotency-Key was already used for a different charge',
      });
    }
    if (earlier.status === 'failed') throw paymentRefused();

    // Written in the same transaction as the `succeeded` status, so a miss is corruption, not
    // a race. Filtered by user first: that is the indexed half of the lookup. The DEPOSIT only:
    // an admin refund writes PAYMENT_CANCEL (and, if the PG refused, PAYMENT_CANCEL_REVERSAL)
    // under the same reference, and the charge's answer is the credit, never the claw-back.
    const [entry] = await this.db
      .select()
      .from(schema.ledgerEntries)
      .where(
        and(
          eq(schema.ledgerEntries.userId, earlier.userId),
          eq(schema.ledgerEntries.refType, 'payment'),
          eq(schema.ledgerEntries.refId, earlier.id),
          eq(schema.ledgerEntries.type, 'DEPOSIT'),
        ),
      )
      .limit(1);
    if (!entry) throw new AppError('INTERNAL', { message: 'Ledger entry missing for payment' });
    // Rebuilt from the rows the first request wrote — never from the catalogue, which an admin
    // may have re-priced since (ADR-0026); the payment carries the terms actually bought.
    return {
      // Credited once (its DEPOSIT is above): never `cancelled`, so no cancel to confirm.
      payment: toPayment({ ...earlier, cancelConfirmed: null }),
      balance: await this.getBalance(earlier.userId),
      ledgerEntry: toLedgerEntry(entry),
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
