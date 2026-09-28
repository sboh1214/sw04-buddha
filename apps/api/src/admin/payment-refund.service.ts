import { Inject, Injectable, Logger } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  PAYMENT_REFUND_WINDOW_DAYS,
  serializePAmount,
  type AdminPayment,
  type PaymentStatus,
  type UserBalanceEvent,
} from '@buddha/shared';
import { and, eq, gte, sql } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { recordPaymentEvent } from '../payments/payment-events.js';
import { type CancelOutcome, type PaymentProvider } from '../payments/payment-provider.js';
import { PaymentProviderRegistry } from '../payments/payment-provider.registry.js';
import { hasCancelNotice, markRefunded, restoreClawBack } from '../payments/payment-transitions.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import { balanceEvent, type PaymentRow } from '../wallet/wallet.service.js';
import { AdminService } from './admin.service.js';

/** The handle `db.transaction` hands its callback; @buddha/db exports no alias for it. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long one cancel attempt holds a `refunding` payment against a retry. The SmartroPay client
 * gives up after SMARTRO_TIMEOUT_MS (25 s), so an attempt still silent after this died with its
 * process, and a retry may take over.
 */
const ATTEMPT_LEASE_MS = 60_000;

/**
 * Why a refund (or a settle, payment-settle.service) is refused before anything moves; the web
 * picks its copy by this message.
 */
export type RefusalReason =
  'window_closed' | 'status' | 'provider' | 'in_progress' | 'approval_mismatch';

export function refundNotAllowed(reason: RefusalReason, message?: string): AppError {
  const messages: Record<RefusalReason, string> = {
    window_closed: `Refunds are possible for ${String(PAYMENT_REFUND_WINDOW_DAYS)} days after the approval`,
    status: message ?? 'Only a succeeded payment can be refunded',
    provider: message ?? 'The provider of this payment cannot cancel it',
    in_progress: message ?? 'A request may still be working on this payment; try again shortly',
    approval_mismatch: message ?? 'The approval on record does not match this payment',
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
 * Whatever the answer, a verified 재통보 of a full cancel of the approval (hasCancelNotice) is
 * the PG's word that the card is cancelled, and finishes the refund instead of putting the P
 * back — checked again under the payment row's lock before any P goes back.
 *
 * A RETRY NEVER PUTS THE P BACK BY ITSELF. Its first attempt may have cancelled the card before
 * the answer was lost, so a refusal now may only mean "not again" in a code we do not know as
 * "already cancelled". A refused retry leaves the payment `refunding` for an admin to check in
 * the merchant admin and settle by hand (`POST /admin/payments/:id/settle`, restore or
 * refunded) — unless the 재통보 has already told us the card was cancelled, which finishes it.
 *
 * ONE ATTEMPT AT A TIME. An attempt starts by stamping the payment's `updated_at` (the claw-back,
 * or a retry's lease) and ends by recording its `refund_cancel` event. A retry while the last
 * attempt is still waiting on the PG is refused (DUPLICATE_REQUEST): two cancels of one card side
 * by side could end with the card cancelled by one and the P put back by the other's refusal.
 * The stamp is also the attempt's claim at the moment of change: a first attempt puts the P back
 * only while the payment still carries ITS stamp. One that waited so long (a slow PG, a busy
 * balance row) that a retry took the payment over leaves it to that retry, and to a settle.
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
    // A retry: an earlier attempt clawed the P back and may have reached the card.
    const retry = payment.status === 'refunding';
    // This attempt's stamp on the payment (`updated_at`): see ONE ATTEMPT AT A TIME.
    let stamp: Date;
    if (retry) {
      if (!provider || payment.providerRef === null) throw refundNotAllowed('provider');
      stamp = await this.takeRetry(adminId, payment, reason);
    } else {
      if (payment.status !== 'succeeded') throw refundNotAllowed('status');
      if (!provider || payment.providerRef === null) throw refundNotAllowed('provider');
      stamp = await this.clawBack(adminId, payment, reason);
    }

    let outcome: CancelOutcome;
    try {
      outcome = await provider.cancel({
        paymentId: payment.id,
        providerRef: payment.providerRef,
        priceKrw: payment.priceKrw,
        reason,
        method: payment.method,
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
    if (outcome.status === 'cancelled') {
      await this.finish(payment, outcome, provider);
    } else if (await hasCancelNotice(this.db, { ...payment, status: 'refunding' })) {
      // The PG's own 재통보 said the card was cancelled — on a first attempt too: a card
      // cancelled in the merchant admin while the payment was `succeeded` (settleNotify
      // records that notice and moves nothing), whose cancel now comes back in a code we do not
      // know as "already cancelled". Whatever this answer says, the refund is done; putting
      // the P back would leave the payer both.
      await this.finish(payment, outcome, provider);
    } else if (outcome.status === 'refused') {
      if (retry) await this.holdRefused(payment, outcome, provider);
      await this.restore(payment, outcome, provider, stamp);
    } else {
      await this.leaveRefunding(payment, outcome, provider);
    }
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
  private async clawBack(adminId: string, payment: PaymentRow, reason: string): Promise<Date> {
    const { event: published, at: stamp } = await this.db.transaction(async (tx) => {
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
      return { event: balanceEvent(balance, entry), at };
    });
    await this.publisher.publishUser(payment.userId, published);
    return stamp;
  }

  /**
   * A retry of a `refunding` payment (the P is already out, so it only asks the PG again): takes
   * the attempt lease — refused while the last attempt is still waiting on the PG — and records
   * who retried and why (the reason is the CancelMsg the PG gets) in the same transaction. Only
   * the payment row is locked, so no lock order with the balance arises.
   */
  private async takeRetry(adminId: string, payment: PaymentRow, reason: string): Promise<Date> {
    return this.db.transaction(async (tx) => {
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
      return at;
    });
  }

  /**
   * tx2, the card is cancelled (2001, an "already cancelled" code on a retry, or a cancel
   * 재통보 said so): `refunded`. The P is already out.
   */
  private async finish(
    payment: PaymentRow,
    outcome: CancelOutcome,
    provider: PaymentProvider,
  ): Promise<void> {
    const now = await this.db.transaction(async (tx) => {
      const at = await clockTimestamp(tx);
      const done = await markRefunded(tx, payment.id, at);
      await recordPaymentEvent(tx, {
        paymentId: payment.id,
        type: 'refund_cancel',
        resultCode: outcome.resultCode,
        resultMessage: outcome.resultMessage,
        payload: outcome.payload,
      });
      return done ? undefined : { status: await this.statusOf(tx, payment.id) };
    });
    if (!now) return;
    if (now.status === 'refunded') {
      // The same end, reached first by this cancel's own 재통보 or by another attempt.
      this.logger.log(
        `refund of payment ${payment.id}: ${provider.name} cancelled ${String(payment.providerRef)}; it was refunded already`,
      );
      return;
    }
    // Anything else — at worst a refusal that put the P back — only a person can square with a
    // cancelled card: a payment `succeeded` again is refunded once more.
    this.logger.error(
      `refund of payment ${payment.id}: ${provider.name} cancelled ${String(payment.providerRef)} but the payment was ${now.status ?? 'gone'}, no longer refunding; check it in the admin payments list and refund it again if it is succeeded`,
    );
  }

  /**
   * tx2, the PG refused a first attempt: the P goes back with a PAYMENT_CANCEL_REVERSAL row and
   * the payment is `succeeded` again (answers PAYMENT_GATEWAY_REFUSED with the PG's words) —
   * decided under the payment row's lock, after the balance row's, on the payment as it is now:
   * - a cancel 재통보 recorded meanwhile (its own transaction may be waiting on this lock) is the
   *   PG's word that the card IS cancelled: the refund finishes instead, answering normally;
   * - no longer `refunding` — the 재통보 finished it, or anything else moved it — nothing is
   *   put back: `refunded` answers normally, anything else PAYMENT_GATEWAY_REFUSED;
   * - no longer this attempt's (`stamp`): a retry took it over and may be cancelling the card
   *   right now, so nothing is put back and it is left to that retry, or a settle
   *   (PAYMENT_GATEWAY_REFUSED `settle_required`, as holdRefused).
   */
  private async restore(
    payment: PaymentRow,
    outcome: CancelOutcome,
    provider: PaymentProvider,
    stamp: Date,
  ): Promise<void> {
    const decision = await this.db.transaction(
      async (
        tx,
      ): Promise<
        | { kind: 'restored'; event: UserBalanceEvent }
        | { kind: 'finished' | 'taken' }
        | { kind: 'moved'; status: PaymentStatus | undefined }
      > => {
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
        const at = await clockTimestamp(tx);
        await recordPaymentEvent(tx, {
          paymentId: payment.id,
          type: 'refund_cancel',
          resultCode: outcome.resultCode,
          resultMessage: outcome.resultMessage,
          payload: outcome.payload,
        });
        if (locked?.status !== 'refunding') return { kind: 'moved', status: locked?.status };
        if (await hasCancelNotice(tx, locked)) {
          if (!(await markRefunded(tx, locked.id, at))) throw this.movedUnderLock();
          return { kind: 'finished' };
        }
        if (locked.updatedAt.getTime() !== stamp.getTime()) return { kind: 'taken' };
        const event = await restoreClawBack(tx, locked.id, at);
        if (!event) throw this.movedUnderLock();
        return { kind: 'restored', event };
      },
    );
    const code = outcome.resultCode ?? 'no code';
    const gateway = {
      path: ['gateway'],
      message: `${outcome.resultCode ?? ''} ${outcome.resultMessage ?? ''}`.trim(),
    };
    switch (decision.kind) {
      case 'restored':
        await this.publisher.publishUser(payment.userId, decision.event);
        this.logger.warn(
          `refund of payment ${payment.id} refused by ${provider.name} (${code}); P restored`,
        );
        throw new AppError('PAYMENT_GATEWAY_REFUSED', {
          message: 'The payment gateway refused the cancel; the P was restored',
          details: [gateway],
        });
      case 'finished':
        this.logger.log(
          `refund of payment ${payment.id}: ${provider.name} refused the cancel (${code}), but its 재통보 had reported the card cancelled; refunded`,
        );
        return;
      case 'moved':
        if (decision.status === 'refunded') {
          this.logger.log(
            `refund of payment ${payment.id}: ${provider.name} refused the cancel (${code}), but the payment was refunded meanwhile (its 재통보, or another attempt); nothing restored`,
          );
          return;
        }
        this.logger.error(
          `refund of payment ${payment.id} refused by ${provider.name} (${code}) but the payment was ${decision.status ?? 'gone'}, no longer refunding; nothing restored — check it in the admin payments list`,
        );
        throw new AppError('PAYMENT_GATEWAY_REFUSED', {
          message: 'The payment gateway refused the cancel',
          details: [gateway],
        });
      case 'taken':
        this.logger.error(
          `refund of payment ${payment.id}: ${provider.name} refused the cancel (${code}) after a retry took the payment over; nothing restored — the retry decides it, or check the card in the merchant admin and settle it (POST /admin/payments/${payment.id}/settle: refunded or restore)`,
        );
        throw new AppError('PAYMENT_GATEWAY_REFUSED', {
          message:
            'The payment gateway refused the cancel after a retry took the refund over; the payment stays refunding until it is settled',
          details: [gateway, { path: ['payment'], message: 'settle_required' }],
        });
    }
  }

  /** The payment's status now, inside `tx`; undefined when the row is gone. */
  private async statusOf(tx: Tx, paymentId: string): Promise<PaymentStatus | undefined> {
    const [row] = await tx
      .select({ status: schema.payments.status })
      .from(schema.payments)
      .where(eq(schema.payments.id, paymentId))
      .limit(1);
    return row?.status;
  }

  /** The row is locked, so this is a bug rather than a race: the transaction rolls back. */
  private movedUnderLock(): AppError {
    return new AppError('INTERNAL', { message: 'The payment moved under its lock' });
  }

  /**
   * A retry the PG refused: the first attempt may have cancelled the card, so nothing is put
   * back and the payment stays `refunding` — an admin checks the card in the merchant admin and
   * settles it (restore, or refunded). Answers PAYMENT_GATEWAY_REFUSED with the PG's words and a
   * second detail, `settle_required`.
   */
  private async holdRefused(
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
      `refund of payment ${payment.id}: ${provider.name} refused the retried cancel (${outcome.resultCode ?? 'no code'}) of ${String(payment.providerRef)}; left refunding — check the card in the merchant admin, then settle it (POST /admin/payments/${payment.id}/settle: refunded or restore)`,
    );
    throw new AppError('PAYMENT_GATEWAY_REFUSED', {
      message:
        'The payment gateway refused the retried cancel; the payment stays refunding until it is settled by hand',
      details: [
        {
          path: ['gateway'],
          message: `${outcome.resultCode ?? ''} ${outcome.resultMessage ?? ''}`.trim(),
        },
        { path: ['payment'], message: 'settle_required' },
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
      `refund of payment ${payment.id}: ${provider.name} gave no answer to the cancel (${outcome.resultCode ?? 'no code'}); left refunding — retry it, or check the card in the merchant admin and settle it (POST /admin/payments/${payment.id}/settle)`,
    );
    throw new AppError('PAYMENT_GATEWAY_ERROR', {
      message: 'The payment gateway did not answer the cancel; retry the refund',
    });
  }
}
