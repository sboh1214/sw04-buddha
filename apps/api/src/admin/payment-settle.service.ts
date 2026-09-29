import { Inject, Injectable } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  paymentIdToMoid,
  serializePAmount,
  type AdminPayment,
  type PaymentSettleOutcome,
  type PaymentStatus,
  type SettlePaymentBody,
  type UserBalanceEvent,
} from '@buddha/shared';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { isPgError, PG_UNIQUE_VIOLATION } from '../common/errors/pg-error.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { DB } from '../infra/db/db.provider.js';
import { recordPaymentEvent } from '../payments/payment-events.js';
import {
  PROVIDER_REF_UNIQUE,
  SETTLE_MIN_AGE_MS,
  markRefunded,
  netCancelOutcome,
  recordedCancelNotices,
  restoreClawBack,
} from '../payments/payment-transitions.js';
import { PAYMENTS_CONFIG, type PaymentsConfig } from '../payments/payments-config.js';
import {
  isApprovalSuccess,
  parseKrw,
  verifySignValue,
} from '../payments/smartro/smartro-protocol.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import { type PaymentRow, WalletService } from '../wallet/wallet.service.js';
import { AdminService } from './admin.service.js';
import { refundNotAllowed } from './payment-refund.service.js';

/** The handle `db.transaction` hands its callback; @buddha/db exports no alias for it. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * `payments.result_message` of a payment an admin credited. A credit always writes it, over
 * whatever reason the payment had (the net cancel's, the PG's refusal): a succeeded payment's
 * reason is shown to no one, so this only marks the row as credited by hand.
 */
export const MANUAL_SETTLE_MESSAGE = '관리자 수동 정리';

/**
 * `payments.result_message` of a payment a settle MOVED to `cancelled` (from `pending` or
 * `failed`) or to `failed` (from `pending`): the reason the payer reads under it, and the admin
 * list's sign that it was closed by hand. A reason on record explained the state the payment left
 * — the PG's error on its approval, which even tells the payer to retry — not this one. A settle
 * that confirms the status the payment has writes none (setStatus).
 */
export const SETTLE_REASON = {
  cancelled: '관리자 확인 후 결제 취소',
  failed: '관리자 확인 결과 미승인',
} as const satisfies Record<'cancelled' | 'failed', string>;

/** `payments.method` is varchar(16). */
const METHOD_MAX = 16;

/** The fields of the PG's approval of a payment, as a recorded event carried them. */
interface RecordedApproval {
  tid: string;
  mid: string | undefined;
  amt: string | undefined;
  moid: string | undefined;
  payMethod: string | undefined;
}

/**
 * The approvals of a payment on record (approvalsOnRecord), newest first within each:
 * `verified` — answers to our own calls whose SignValue verifies, then 재통보 — and `unverified`,
 * answers of ours whose SignValue does not.
 */
interface ApprovalsOnRecord {
  verified: RecordedApproval[];
  unverified: RecordedApproval[];
}

/** What `apply` did: the `user:balance` event to publish, and the approval Tid a credit stored. */
interface Applied {
  event?: UserBalanceEvent;
  providerRef?: string;
}

/** What a settle does to a payment of a given status, when that status allows the outcome. */
type Transition =
  | { kind: 'credit'; from: PaymentStatus }
  | { kind: 'cancel' }
  | { kind: 'fail' }
  | { kind: 'refunded' }
  | { kind: 'restore' };

/**
 * `POST /admin/payments/:id/settle` (ADR-0042): an admin settles by hand a SmartroPay payment
 * whose outcome the API could not learn by itself — the approval's answer and the 재통보 never
 * came, a net cancel or a refund's cancel got no clear answer — once the merchant admin
 * (smilebiz) has shown what really happened to the card. The admin list flags these rows
 * (`needsReview`). It moves the payment row itself, so a late 재통보 finds it settled and
 * changes nothing (an approval notice for a credited or confirmed-cancelled payment is a no-op).
 *
 * | status      | condition                                  | outcome     | effect                    |
 * |-------------|--------------------------------------------|-------------|---------------------------|
 * | `pending`   | claimed (`provider_ref` set)               | `credit`    | credited (DEPOSIT)        |
 * | `pending`   | claimed                                    | `cancelled` | `cancelled`, net_cancel   |
 * | `pending`   | —                                          | `failed`    | `failed`                  |
 * | `failed`    | claimed                                    | `credit`    | credited (DEPOSIT)        |
 * | `failed`    | claimed                                    | `cancelled` | `cancelled`, net_cancel   |
 * | `failed`    | claimed                                    | `failed`    | stays `failed` (checked)  |
 * | `cancelled` | net cancel missing or `unknown`            | `credit`    | credited (DEPOSIT)        |
 * | `cancelled` | net cancel missing or `unknown`            | `cancelled` | net_cancel (confirmed)    |
 * | `refunding` | —                                          | `refunded`  | `refunded` (P stays out)  |
 * | `refunding` | —                                          | `restore`   | `succeeded`, REVERSAL     |
 *
 * A settle that confirms the status the payment has (`cancelled` → `cancelled`, `failed` →
 * `failed`) keeps its status and `result_message` — the reason the payer reads (the net
 * cancel's, the PG's refusal) is still the reason — and records only that: `updated_at` and the
 * audit row, plus the manual `net_cancel` for `cancelled` (a `failed` → `failed` settle writes
 * no `payment_events` row). One that moves it to `cancelled` or `failed` writes the settle's own
 * reason (SETTLE_REASON), and a credit writes MANUAL_SETTLE_MESSAGE.
 *
 * A claimed `failed` payment is settled too: our side failed it, and the card may be charged all
 * the same (an approval 재통보 that could not be credited). `failed` again says it was checked,
 * which clears its `needsReview`.
 *
 * A CREDIT STORES THE APPROVAL'S TID. The refund cancels `provider_ref`, and the authentication's
 * Tid a claim recorded may differ from the approval's (the manual, STEP 4). So a credit takes the
 * Tid, PayMethod — and the word — of the approval on record that matches the payment's Mid,
 * amount and Moid (approvalsOnRecord, our own verified answers first; one whose SignValue does
 * not verify only while no verified record contradicts it). With records and none of them
 * matching, the approval was net-cancelled for it, and the credit is refused
 * (`approval_mismatch`: cancel the card in the merchant admin and settle it `cancelled`). With
 * no successful approval on record (every answer was lost, or it was the PG's own error) the
 * admin gives the approval's Tid (`tid`) as the merchant admin shows it. A cancel 재통보
 * recorded meanwhile (recordedCancelNotices) refuses a
 * credit or a restore: a full one says the card IS cancelled (`status`), a partial one that part
 * of it is (`partial_cancel`: settle it `cancelled` or `refunded`, and adjust the balance by
 * hand — no outcome here says how much P the rest is worth).
 *
 * Anything else is REFUND_NOT_ALLOWED `status`; a mock payment is `provider`; a payment touched
 * within SETTLE_MIN_AGE_MS — a ReturnUrl, a net cancel or a refund attempt may still be working
 * on it — is `in_progress`. Everything is decided under the payment row's lock, and the audit
 * row (`payment_settle`) commits with the change. LOCK ORDER: the balance row first, then the
 * payment row, as everywhere a payment and a balance move together.
 */
@Injectable()
export class PaymentSettleService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PAYMENTS_CONFIG) private readonly config: PaymentsConfig,
    private readonly wallet: WalletService,
    private readonly publisher: MarketPublisher,
    private readonly admin: AdminService,
  ) {}

  async settle(adminId: string, paymentId: string, body: SettlePaymentBody): Promise<AdminPayment> {
    const { outcome, reason, tid } = body;
    const payment = await this.load(paymentId);
    if (payment.provider !== 'smartro') {
      throw refundNotAllowed('provider', 'Only a SmartroPay payment is settled by hand');
    }
    let published: UserBalanceEvent | undefined;
    try {
      published = await this.db.transaction(async (tx) => {
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
        if (!locked) throw new AppError('NOT_FOUND', { message: 'Payment not found' });
        const at = await clockTimestamp(tx);

        const transition = await this.transitionOf(tx, locked, outcome);
        if (!transition) {
          throw refundNotAllowed(
            'status',
            `A ${locked.status} payment cannot be settled as ${outcome}`,
          );
        }
        if (at.getTime() - locked.updatedAt.getTime() < SETTLE_MIN_AGE_MS) {
          throw refundNotAllowed('in_progress');
        }

        const applied = await this.apply(tx, locked, transition, at, tid);
        await tx.insert(schema.adminActions).values({
          adminId,
          type: 'payment_settle',
          targetType: 'payment',
          targetId: locked.id,
          payload: {
            outcome,
            from: locked.status,
            amountP: serializePAmount(locked.amountP),
            priceKrw: locked.priceKrw,
            provider: locked.provider,
            ...(applied.providerRef === undefined ? {} : { tid: applied.providerRef }),
            memo: reason,
          },
          createdAt: at,
        });
        return applied.event;
      });
    } catch (error) {
      // The approval's Tid is already another payment's reference: crediting it here would
      // count one PG transaction twice (the unique index refused it; nothing was written).
      if (isPgError(error, PG_UNIQUE_VIOLATION, PROVIDER_REF_UNIQUE)) {
        throw refundNotAllowed(
          'approval_mismatch',
          'The approval Tid is already recorded on another payment',
        );
      }
      throw error;
    }
    if (published) await this.publisher.publishUser(payment.userId, published);
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

  /** The row of the table above that `outcome` takes from the payment as locked, if any. */
  private async transitionOf(
    tx: Tx,
    payment: PaymentRow,
    outcome: PaymentSettleOutcome,
  ): Promise<Transition | undefined> {
    const claimed = payment.providerRef !== null;
    switch (payment.status) {
      case 'pending':
        if (outcome === 'failed') return { kind: 'fail' };
        if (!claimed) return undefined;
        if (outcome === 'credit') return { kind: 'credit', from: 'pending' };
        if (outcome === 'cancelled') return { kind: 'cancel' };
        return undefined;
      case 'failed':
        // Never claimed, never approved: nothing to settle.
        if (!claimed) return undefined;
        if (outcome === 'credit') return { kind: 'credit', from: 'failed' };
        if (outcome === 'cancelled') return { kind: 'cancel' };
        if (outcome === 'failed') return { kind: 'fail' };
        return undefined;
      case 'cancelled': {
        // A net cancel always records the approval's Tid; without one there is nothing to settle.
        if (!claimed || (outcome !== 'credit' && outcome !== 'cancelled')) return undefined;
        // Only a net cancel that got no clear answer (or never recorded one — its process died):
        // one the PG confirmed is settled already (the card IS cancelled), and a refusal put
        // the payment back to `pending` with it.
        const netCancel = await netCancelOutcome(tx, payment.id);
        if (netCancel !== undefined && netCancel !== 'unknown') return undefined;
        return outcome === 'credit' ? { kind: 'credit', from: 'cancelled' } : { kind: 'cancel' };
      }
      case 'refunding':
        if (outcome === 'refunded') return { kind: 'refunded' };
        if (outcome === 'restore') return { kind: 'restore' };
        return undefined;
      default:
        return undefined;
    }
  }

  /** Applies `transition` under the locks. */
  private async apply(
    tx: Tx,
    payment: PaymentRow,
    transition: Transition,
    at: Date,
    tid: string | undefined,
  ): Promise<Applied> {
    switch (transition.kind) {
      case 'credit': {
        // Claimed (transitionOf).
        if (payment.providerRef === null) throw this.moved();
        // Its notify event commits before the notice waits on this lock: the PG's own word that
        // the card is cancelled, which no settle overrides (the notice then closes it).
        const notices = await recordedCancelNotices(tx, payment);
        if (notices.full) {
          throw refundNotAllowed(
            'status',
            'A cancel 재통보 reports this card cancelled; settle it as cancelled',
          );
        }
        // Part of the card's amount is cancelled: the whole P is not owed, and no outcome here
        // says how much is.
        if (notices.partial) {
          throw refundNotAllowed(
            'partial_cancel',
            'A partial cancel 재통보 is on record for this card; settle it as cancelled and adjust the balance by hand',
          );
        }
        const approval = this.creditedApproval(
          payment,
          await this.approvalsOnRecord(tx, payment),
          tid,
        );
        // The card stays charged: the P it bought, exactly as an approval credits it. A late
        // approval 재통보 then finds the payment `succeeded` and changes nothing.
        const credit = await this.wallet.creditWithin(tx, {
          paymentId: payment.id,
          userId: payment.userId,
          amountP: payment.amountP,
          from: [transition.from],
          providerRef: approval.tid,
          method: approval.payMethod?.slice(0, METHOD_MAX) ?? payment.method,
          resultMessage: MANUAL_SETTLE_MESSAGE,
        });
        if (!('result' in credit)) throw this.moved();
        return { event: credit.event, providerRef: approval.tid };
      }
      case 'cancel': {
        // The card is cancelled (the admin saw it, or cancelled it, in the merchant admin): a
        // `net_cancel` the PG confirmed, marked manual, so an approval 재통보 is a no-op.
        await this.setStatus(tx, payment, 'cancelled', at);
        await recordPaymentEvent(tx, {
          paymentId: payment.id,
          type: 'net_cancel',
          payload: { outcome: 'cancelled', manual: true },
        });
        return {};
      }
      case 'fail':
        // Never approved: the window was abandoned, or the approval was refused. (From `failed`:
        // checked, and it stays so — the audit row is what clears its `needsReview`.)
        await this.setStatus(tx, payment, 'failed', at);
        return {};
      case 'refunded':
        if (!(await markRefunded(tx, payment.id, at))) throw this.moved();
        await recordPaymentEvent(tx, {
          paymentId: payment.id,
          type: 'refund_cancel',
          payload: { outcome: 'cancelled', manual: true },
        });
        return {};
      case 'restore': {
        // As for a credit: the PG's word that the card is cancelled is not overridden by hand,
        // in full or in part.
        const notices = await recordedCancelNotices(tx, payment);
        if (notices.full) {
          throw refundNotAllowed(
            'status',
            'A cancel 재통보 reports this card cancelled; settle it as refunded',
          );
        }
        if (notices.partial) {
          throw refundNotAllowed(
            'partial_cancel',
            'A partial cancel 재통보 is on record for this card; settle it as refunded and adjust the balance by hand',
          );
        }
        const event = await restoreClawBack(tx, payment.id, at);
        if (!event) throw this.moved();
        await recordPaymentEvent(tx, {
          paymentId: payment.id,
          type: 'refund_cancel',
          payload: { outcome: 'refused', manual: true },
        });
        return { event };
      }
    }
  }

  /**
   * The approval a credit stores: the first verified record (approvalsOnRecord's order) that
   * matches the payment, else the first unverified one that does — unless a verified record
   * contradicts it (disagreementsOf, or another Tid): the PG vouched for that record, not for
   * this one. Refused as `approval_mismatch` when records exist and none can be taken, or when
   * the admin's `tid` is not the one taken; with none on record, the `tid` the admin read in the
   * merchant admin (VALIDATION_ERROR without it).
   */
  private creditedApproval(
    payment: PaymentRow,
    recorded: ApprovalsOnRecord,
    tid: string | undefined,
  ): { tid: string; payMethod: string | undefined } {
    const matches = (approval: RecordedApproval) =>
      this.mismatchesOf(payment, approval).length === 0;
    const [first] = [...recorded.verified, ...recorded.unverified];
    if (!first) {
      if (tid === undefined) {
        throw new AppError('VALIDATION_ERROR', {
          message:
            "No successful approval of this payment is on record: give the approval's Tid as the merchant admin shows it",
          details: [
            {
              path: ['tid'],
              message: 'required: no successful approval of this payment is on record',
            },
          ],
        });
      }
      return { tid, payMethod: undefined };
    }
    let matching = recorded.verified.find(matches);
    if (!matching) {
      const unverified = recorded.unverified.find(matches);
      if (unverified) {
        const contradiction = recorded.verified
          .map((approval) => ({
            approval,
            reasons: [
              ...(approval.tid === unverified.tid ? [] : ['Tid']),
              ...this.disagreementsOf(payment, approval),
            ],
          }))
          .find(({ reasons }) => reasons.length > 0);
        if (contradiction) {
          throw refundNotAllowed(
            'approval_mismatch',
            `The verified approval on record (${contradiction.approval.tid}) contradicts the unverified one (${unverified.tid}): ${contradiction.reasons.join(', ')}`,
          );
        }
        matching = unverified;
      }
    }
    if (!matching) {
      throw refundNotAllowed(
        'approval_mismatch',
        `The approval on record (${first.tid}) does not match this payment: ${this.mismatchesOf(payment, first).join(', ')}`,
      );
    }
    if (tid !== undefined && tid !== matching.tid) {
      throw refundNotAllowed(
        'approval_mismatch',
        `The approval on record is ${matching.tid}, not the Tid given`,
      );
    }
    return matching;
  }

  /** Where a recorded approval disagrees with the payment, or says nothing: Mid, amount, Moid. */
  private mismatchesOf(payment: PaymentRow, approval: RecordedApproval): string[] {
    const mismatches: string[] = [];
    const smartro = this.config.smartro;
    // Without the credentials there is no Mid to compare; the amount and Moid still decide.
    if (smartro && approval.mid !== smartro.mid) mismatches.push('Mid');
    if (parseKrw(approval.amt) !== payment.priceKrw) mismatches.push('Amt');
    if (approval.moid !== undefined && approval.moid !== paymentIdToMoid(payment.id)) {
      mismatches.push('Moid');
    }
    return mismatches;
  }

  /**
   * Where a recorded approval says something else than the payment — a Mid, an amount or a Moid
   * it carries that is not the payment's. A field it lacks (a notice without its Mid) is no
   * disagreement: mismatchesOf counts it, this does not.
   */
  private disagreementsOf(payment: PaymentRow, approval: RecordedApproval): string[] {
    const smartro = this.config.smartro;
    return this.mismatchesOf(payment, approval).filter((field) => {
      if (field === 'Mid') return smartro !== null && approval.mid !== undefined;
      if (field === 'Amt') return approval.amt !== undefined;
      return true;
    });
  }

  /**
   * The PG's approvals of the payment on record — every success among the approval's answer,
   * the result inquiry's and the approval 재통보 (StateCd 0) — in the order a credit trusts them,
   * newest first within each:
   * 1. an answer to our own call whose SignValue verifies (recorded as it came, so checked here);
   * 2. a 재통보 (recorded only once its SignValue verified — but its fields are the notice's, and
   *    a notice missing its Mid or writing its amount otherwise must not hide an answer of ours);
   * 3. an answer of ours that does not verify (an approval net-cancelled for that alone), which
   *    still names the Tid the merchant admin shows — `unverified`, taken only while no verified
   *    record contradicts it (creditedApproval).
   */
  private async approvalsOnRecord(tx: Tx, payment: PaymentRow): Promise<ApprovalsOnRecord> {
    const rows = await tx
      .select({
        type: schema.paymentEvents.type,
        resultCode: schema.paymentEvents.resultCode,
        payload: schema.paymentEvents.payload,
      })
      .from(schema.paymentEvents)
      .where(
        and(
          eq(schema.paymentEvents.paymentId, payment.id),
          inArray(schema.paymentEvents.type, ['approval', 'approval_inquiry', 'notify']),
        ),
      )
      .orderBy(desc(schema.paymentEvents.id));
    const smartro = this.config.smartro;
    const answers: RecordedApproval[] = [];
    const notices: RecordedApproval[] = [];
    const unverified: RecordedApproval[] = [];
    for (const row of rows) {
      const fields = row.payload as Record<string, unknown> | null;
      const text = (...keys: string[]): string | undefined => {
        for (const key of keys) {
          const value = fields?.[key];
          if (typeof value === 'string' && value.length > 0) return value;
          if (typeof value === 'number' && Number.isFinite(value)) return String(value);
        }
        return undefined;
      };
      const code = row.resultCode ?? text('ResultCode');
      if (code === undefined || !isApprovalSuccess(code)) continue;
      if (row.type === 'notify' && text('StateCd') !== '0') continue;
      const tid = text('Tid', 'TID');
      if (tid === undefined) continue;
      const approval: RecordedApproval = {
        tid,
        mid: text('Mid', 'MID'),
        amt: text('Amt'),
        moid: text('Moid', 'OID'),
        payMethod: text('PayMethod'),
      };
      if (row.type === 'notify') {
        notices.push(approval);
        continue;
      }
      const sign = text('SignValue');
      const verified =
        smartro !== null &&
        sign !== undefined &&
        verifySignValue(sign, tid, code, smartro.merchantKey);
      (verified ? answers : unverified).push(approval);
    }
    return { verified: [...answers, ...notices], unverified };
  }

  /**
   * `pending`/`failed`/`cancelled` → `status`, guarded by the status the row was locked in, with
   * the settle's reason (SETTLE_REASON). A payment already in `status` is only touched
   * (`updated_at`): the settle confirms it, and the reason on record is still why it ended.
   */
  private async setStatus(
    tx: Tx,
    payment: PaymentRow,
    status: Extract<PaymentStatus, 'cancelled' | 'failed'>,
    at: Date,
  ): Promise<void> {
    const change =
      payment.status === status
        ? { updatedAt: at }
        : { status, resultMessage: SETTLE_REASON[status], updatedAt: at };
    const rows = await tx
      .update(schema.payments)
      .set(change)
      .where(and(eq(schema.payments.id, payment.id), eq(schema.payments.status, payment.status)))
      .returning({ id: schema.payments.id });
    if (rows.length === 0) throw this.moved();
  }

  /** The row is locked, so this is a bug rather than a race: nothing is written. */
  private moved(): AppError {
    return new AppError('INTERNAL', { message: 'The payment moved under its lock' });
  }
}
