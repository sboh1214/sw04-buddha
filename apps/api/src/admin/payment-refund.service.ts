import { Inject, Injectable, Logger } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import { PAYMENT_REFUND_WINDOW_DAYS, serializePAmount, type AdminPayment } from '@buddha/shared';
import { and, eq, gte, sql } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { recordPaymentEvent } from '../payments/payment-events.js';
import { type CancelOutcome, type PaymentProvider } from '../payments/payment-provider.js';
import { PaymentProviderRegistry } from '../payments/payment-provider.registry.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import { balanceEvent, type PaymentRow } from '../wallet/wallet.service.js';
import { AdminService } from './admin.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long one cancel attempt holds a `refunding` payment against a retry. The SmartroPay client
 * gives up after SMARTRO_TIMEOUT_MS (25 s), so an attempt still silent after this died with its
 * process, and a retry may take over.
 */
const ATTEMPT_LEASE_MS = 60_000;

/** Why a refund is refused before anything moves; the web picks its copy by this message. */
type RefusalReason = 'window_closed' | 'status' | 'provider';

function refundNotAllowed(reason: RefusalReason): AppError {
  const messages: Record<RefusalReason, string> = {
    window_closed: `Refunds are possible for ${String(PAYMENT_REFUND_WINDOW_DAYS)} days after the approval`,
    status: 'Only a succeeded payment can be refunded',
    provider: 'The provider of this payment cannot cancel it',
  };
  return new AppError('REFUND_NOT_ALLOWED', {
    message: messages[reason],
    details: [{ path: ['payment'], message: reason }],
  });
}

/**
 * `POST /admin/payments/:id/refund` (ADR-0042, owner decision 5): a full cancel of an unused
 * charge within PAYMENT_REFUND_WINDOW_DAYS of its approval — the whole KRW paid goes back to the
 * card and the whole P comes back out of the balance. The owner accepted that this is the one
 * place P turns back into KRW (청약철회), against PLAN 0.2.
 *
 * CLAW BACK FIRST, THEN CANCEL AT THE PG, COMPENSATE ON REFUSAL. The P is taken in one
 * transaction (the payment becomes `refunding`) before the PG is asked, so the P cannot be spent
 * while the card is being cancelled; a PG that refuses gets the P put back with its own ledger
 * row, and a PG that does not answer leaves the payment `refunding` for the admin to retry —
 * a retry skips the claw-back and asks the PG again (2013 "already cancelled" finishes it).
 *
 * ONE ATTEMPT AT A TIME. An attempt starts by stamping the payment's `updated_at` (the claw-back,
 * or a retry's lease) and ends by recording its `refund_cancel` event. A retry while the last
 * attempt is still waiting on the PG is refused (DUPLICATE_REQUEST): two cancels of one card side
 * by side could end with the card cancelled by one and the P put back by the other's refusal.
 *
 * LOCK ORDER: the balance row first, then the payment row — the order WalletService.creditPayment
 * uses — so a refund and a credit of one account can never deadlock.
 */
@Injectable()
export class PaymentRefundService {
  private readonly logger = new Logger(PaymentRefundService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly providers: PaymentProviderRegistry,
    private readonly publisher: MarketPublisher,
    private readonly admin: AdminService,
  ) {}

  async refund(adminId: string, paymentId: string, reason: string): Promise<AdminPayment> {
    const payment = await this.load(paymentId);
    const provider = this.providers.get(payment.provider);
    if (payment.status === 'refunding') {
      if (!provider || payment.providerRef === null) throw refundNotAllowed('provider');
      await this.takeRetry(adminId, payment, reason);
    } else {
      if (payment.status !== 'succeeded') throw refundNotAllowed('status');
      if (!provider || payment.providerRef === null) throw refundNotAllowed('provider');
      await this.clawBack(adminId, payment, reason);
    }

    let outcome: CancelOutcome;
    try {
      outcome = await provider.cancel({
        paymentId: payment.id,
        providerRef: payment.providerRef,
        priceKrw: payment.priceKrw,
        reason,
      });
    } catch (error) {
      // Whatever broke, the P is already out: treat it like silence, so the payment stays
      // `refunding` and a retry can finish it. The error's own text is not logged — a driver or
      // client error can carry the request it failed on.
      outcome = {
        status: 'unknown',
        payload: { error: error instanceof Error ? error.name : 'unknown failure' },
      };
    }
    if (outcome.status === 'cancelled') await this.finish(payment, outcome, provider);
    else if (outcome.status === 'refused') await this.restore(payment, outcome, provider);
    else await this.leaveRefunding(payment, outcome, provider);
    return this.admin.getPayment(payment.id);
  }

  private async load(paymentId: string): Promise<PaymentRow> {
    const [row] = await this.db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.id, paymentId))
      .limit(1);
    if (!row) throw new AppError('NOT_FOUND', { message: 'Payment not found' });
    return row;
  }

  /**
   * tx1: the whole P out of the balance (only if it is all still available — "unused"), a
   * PAYMENT_CANCEL ledger row, the payment `refunding`, and the audit row, together. The window
   * and the status are judged again under the locks, against the database clock.
   */
  private async clawBack(adminId: string, payment: PaymentRow, reason: string): Promise<void> {
    const published = await this.db.transaction(async (tx) => {
      await tx
        .select({ userId: schema.balances.userId })
        .from(schema.balances)
        .where(eq(schema.balances.userId, payment.userId))
        .limit(1)
        .for('update');
      const [locked] = await tx
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.id, payment.id))
        .limit(1)
        .for('update');
      // A concurrent refund got here first (or anything else moved it): refuse rather than
      // claw back twice. That request carries the refund on.
      if (locked?.status !== 'succeeded') throw refundNotAllowed('status');
      const at = await clockTimestamp(tx);
      // `approved_at` is when the P arrived; rows credited before it existed fall back to the
      // reservation's own time (migration 0015 backfilled the succeeded ones anyway).
      const since = locked.approvedAt ?? locked.createdAt;
      if (at.getTime() - since.getTime() > PAYMENT_REFUND_WINDOW_DAYS * DAY_MS) {
        throw refundNotAllowed('window_closed');
      }

      const [balance] = await tx
        .update(schema.balances)
        .set({
          availableP: sql`${schema.balances.availableP} - ${locked.amountP}`,
          // Explicit on purpose: the column's `$onUpdate` would write the API host's clock.
          updatedAt: at,
        })
        .where(
          and(
            eq(schema.balances.userId, locked.userId),
            sql`${schema.balances.availableP} >= ${locked.amountP}`,
          ),
        )
        .returning();
      if (!balance) {
        // Some of this charge's P has been spent (or is locked in an order): the owner's
        // policy refunds unused charges only.
        throw new AppError('INSUFFICIENT_BALANCE', {
          message: 'Part of the P this payment bought has already been used',
          details: [{ path: ['amountP'], message: 'P already used' }],
        });
      }

      const [action] = await tx
        .insert(schema.adminActions)
        .values({
          adminId,
          type: 'payment_refund',
          targetType: 'payment',
          targetId: locked.id,
          payload: {
            amountP: serializePAmount(locked.amountP),
            priceKrw: locked.priceKrw,
            provider: locked.provider,
            memo: reason,
          },
          createdAt: at,
        })
        .returning();
      if (!action) throw new AppError('INTERNAL', { message: 'Admin action insert failed' });

      const [entry] = await tx
        .insert(schema.ledgerEntries)
        .values({
          userId: locked.userId,
          type: 'PAYMENT_CANCEL',
          amountP: -locked.amountP,
          balanceAfterP: balance.availableP,
          refType: 'payment',
          refId: locked.id,
          createdAt: at,
        })
        .returning();
      if (!entry) throw new AppError('INTERNAL', { message: 'Ledger insert failed' });

      await tx
        .update(schema.payments)
        .set({ status: 'refunding', updatedAt: at })
        .where(eq(schema.payments.id, locked.id));
      return balanceEvent(balance, entry);
    });
    await this.publisher.publishUser(payment.userId, published);
  }

  /**
   * A retry of a `refunding` payment (the P is already out, so it only asks the PG again): takes
   * the attempt lease — refused while the last attempt is still waiting on the PG — and records
   * who retried and why (the reason is the CancelMsg the PG gets) in the same transaction. Only
   * the payment row is locked, so no lock order with the balance arises.
   */
  private async takeRetry(adminId: string, payment: PaymentRow, reason: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.id, payment.id))
        .limit(1)
        .for('update');
      // Finished (or put back) meanwhile: nothing is left to retry.
      if (locked?.status !== 'refunding') throw refundNotAllowed('status');
      const at = await clockTimestamp(tx);
      const [answered] = await tx
        .select({ id: schema.paymentEvents.id })
        .from(schema.paymentEvents)
        .where(
          and(
            eq(schema.paymentEvents.paymentId, locked.id),
            eq(schema.paymentEvents.type, 'refund_cancel'),
            gte(schema.paymentEvents.createdAt, locked.updatedAt),
          ),
        )
        .limit(1);
      if (!answered && at.getTime() - locked.updatedAt.getTime() < ATTEMPT_LEASE_MS) {
        throw new AppError('DUPLICATE_REQUEST', {
          message:
            'A refund of this payment is still waiting on the payment gateway; retry shortly',
          details: [{ path: ['payment'], message: 'in progress' }],
        });
      }
      await tx
        .update(schema.payments)
        .set({ updatedAt: at })
        .where(eq(schema.payments.id, locked.id));
      await tx.insert(schema.adminActions).values({
        adminId,
        type: 'payment_refund',
        targetType: 'payment',
        targetId: locked.id,
        payload: {
          amountP: serializePAmount(locked.amountP),
          priceKrw: locked.priceKrw,
          provider: locked.provider,
          memo: reason,
          retry: true,
        },
        createdAt: at,
      });
    });
  }

  /** tx2, the PG cancelled (2001, or 2013 on a retry): `refunded`. The P is already out. */
  private async finish(
    payment: PaymentRow,
    outcome: CancelOutcome,
    provider: PaymentProvider,
  ): Promise<void> {
    const refunded = await this.db.transaction(async (tx) => {
      const at = await clockTimestamp(tx);
      const rows = await tx
        .update(schema.payments)
        .set({ status: 'refunded', refundedAt: at, updatedAt: at })
        .where(and(eq(schema.payments.id, payment.id), eq(schema.payments.status, 'refunding')))
        .returning({ id: schema.payments.id });
      await recordPaymentEvent(tx, {
        paymentId: payment.id,
        type: 'refund_cancel',
        resultCode: outcome.resultCode,
        resultMessage: outcome.resultMessage,
        payload: outcome.payload,
      });
      return rows.length > 0;
    });
    if (!refunded) {
      // The card IS cancelled, but something moved the payment out of `refunding` meanwhile —
      // at worst a refusal that put the P back. Only a person can square the two.
      this.logger.error(
        `refund of payment ${payment.id}: ${provider.name} cancelled ${String(payment.providerRef)} but the payment was no longer refunding; reconcile it by hand`,
      );
    }
  }

  /**
   * tx2, the PG refused: the P goes back with a PAYMENT_CANCEL_REVERSAL row and the payment is
   * `succeeded` again. Guarded by `status = 'refunding'`, so it restores the P at most once
   * whatever else moved the payment. Answers PAYMENT_GATEWAY_REFUSED with the PG's words.
   */
  private async restore(
    payment: PaymentRow,
    outcome: CancelOutcome,
    provider: PaymentProvider,
  ): Promise<never> {
    const published = await this.db.transaction(async (tx) => {
      await tx
        .select({ userId: schema.balances.userId })
        .from(schema.balances)
        .where(eq(schema.balances.userId, payment.userId))
        .limit(1)
        .for('update');
      const at = await clockTimestamp(tx);
      await recordPaymentEvent(tx, {
        paymentId: payment.id,
        type: 'refund_cancel',
        resultCode: outcome.resultCode,
        resultMessage: outcome.resultMessage,
        payload: outcome.payload,
      });
      const [restored] = await tx
        .update(schema.payments)
        .set({ status: 'succeeded', updatedAt: at })
        .where(and(eq(schema.payments.id, payment.id), eq(schema.payments.status, 'refunding')))
        .returning();
      if (!restored) return undefined;

      const [balance] = await tx
        .update(schema.balances)
        .set({
          availableP: sql`${schema.balances.availableP} + ${restored.amountP}`,
          updatedAt: at,
        })
        .where(eq(schema.balances.userId, restored.userId))
        .returning();
      if (!balance) throw new AppError('INTERNAL', { message: 'Balance row vanished mid-refund' });
      const [entry] = await tx
        .insert(schema.ledgerEntries)
        .values({
          userId: restored.userId,
          type: 'PAYMENT_CANCEL_REVERSAL',
          amountP: restored.amountP,
          balanceAfterP: balance.availableP,
          refType: 'payment',
          refId: restored.id,
          createdAt: at,
        })
        .returning();
      if (!entry) throw new AppError('INTERNAL', { message: 'Ledger insert failed' });
      return balanceEvent(balance, entry);
    });
    const code = outcome.resultCode ?? 'no code';
    if (published) {
      await this.publisher.publishUser(payment.userId, published);
      this.logger.warn(
        `refund of payment ${payment.id} refused by ${provider.name} (${code}); P restored`,
      );
    } else {
      this.logger.error(
        `refund of payment ${payment.id} refused by ${provider.name} (${code}) but the payment was no longer refunding; nothing restored — reconcile it by hand`,
      );
    }
    throw new AppError('PAYMENT_GATEWAY_REFUSED', {
      message: published
        ? 'The payment gateway refused the cancel; the P was restored'
        : 'The payment gateway refused the cancel',
      details: [
        {
          path: ['gateway'],
          message: `${outcome.resultCode ?? ''} ${outcome.resultMessage ?? ''}`.trim(),
        },
      ],
    });
  }

  /** No answer: the card may or may not be cancelled, so the payment stays `refunding`. */
  private async leaveRefunding(
    payment: PaymentRow,
    outcome: CancelOutcome,
    provider: PaymentProvider,
  ): Promise<never> {
    await recordPaymentEvent(this.db, {
      paymentId: payment.id,
      type: 'refund_cancel',
      resultCode: outcome.resultCode,
      resultMessage: outcome.resultMessage,
      payload: outcome.payload,
    });
    this.logger.error(
      `refund of payment ${payment.id}: ${provider.name} gave no answer to the cancel; left refunding — retry it`,
    );
    throw new AppError('PAYMENT_GATEWAY_ERROR', {
      message: 'The payment gateway did not answer the cancel; retry the refund',
    });
  }
}
