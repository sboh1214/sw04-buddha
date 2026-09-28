import { schema, type Db } from '@buddha/db';
import { type PaymentStatus, type UserBalanceEvent } from '@buddha/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import { AppError } from '../common/errors/app-error.js';
import { balanceEvent } from '../wallet/wallet.service.js';
import { classifyCancel, parseKrw } from './smartro/smartro-protocol.js';

/** The handle `db.transaction` hands its callback; @buddha/db exports no alias for it. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Payment transitions more than one path takes (ADR-0042): the admin refund, the admin settle
 * and SmartroPay's 재통보 finish a refund or put its P back the same way, and read a net cancel
 * and a cancel notice the same way. Each runs inside the caller's transaction, guarded by the
 * status it leaves, so of two paths racing on one payment exactly one moves it.
 */

/**
 * No request can still be working on a payment untouched for this long, by the database clock:
 * a ReturnUrl's approval and inquiry (25 s each, SMARTRO_TIMEOUT_MS) and a net cancel (25 s),
 * or a refund attempt (its 60 s lease). An admin may settle it by hand only after that, and the
 * admin list flags it for review only after that (`needsReview`).
 */
export const SETTLE_MIN_AGE_MS = 2 * 60 * 1000;

/** UNIQUE (provider, provider_ref) WHERE provider_ref IS NOT NULL (migration 0015). */
export const PROVIDER_REF_UNIQUE = 'payments_provider_provider_ref_unique';

/**
 * `refunding` → `refunded`: the card is cancelled and the P was already clawed back, so no
 * balance moves. False when the payment was no longer `refunding`.
 */
export async function markRefunded(tx: Tx, paymentId: string, at: Date): Promise<boolean> {
  const rows = await tx
    .update(schema.payments)
    .set({ status: 'refunded', refundedAt: at, updatedAt: at })
    .where(and(eq(schema.payments.id, paymentId), eq(schema.payments.status, 'refunding')))
    .returning({ id: schema.payments.id });
  return rows.length > 0;
}

/**
 * `refunding` → `succeeded`: the card was NOT cancelled, so the P the claw-back took goes back
 * with a PAYMENT_CANCEL_REVERSAL row. Undefined (nothing restored) when the payment was no
 * longer `refunding`, so the P comes back at most once. The caller holds the balance row's lock
 * (taken before the payment's) and read `at` after it.
 */
export async function restoreClawBack(
  tx: Tx,
  paymentId: string,
  at: Date,
): Promise<UserBalanceEvent | undefined> {
  const [restored] = await tx
    .update(schema.payments)
    .set({ status: 'succeeded', updatedAt: at })
    .where(and(eq(schema.payments.id, paymentId), eq(schema.payments.status, 'refunding')))
    .returning();
  if (!restored) return undefined;

  const [balance] = await tx
    .update(schema.balances)
    .set({
      availableP: sql`${schema.balances.availableP} + ${restored.amountP}`,
      // Explicit on purpose: the column's `$onUpdate` would write the API host's clock.
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
}

/** How a net cancel ended, as its `net_cancel` event's `payload.outcome` records it. */
export type NetCancelOutcome = 'cancelled' | 'refused' | 'unknown';

const NET_CANCEL_OUTCOMES: ReadonlySet<string> = new Set(['cancelled', 'refused', 'unknown']);

/**
 * What the payment's net cancels came to, or undefined when it has none: `cancelled` once ANY of
 * them was confirmed — a cancelled card stays cancelled, whatever a later attempt heard — and
 * otherwise the latest one's outcome. An event that names no outcome of the three reads as
 * `unknown`: it proves nothing about the card. (The admin list's `needsReview` asks the same
 * question: is there a confirmed one.)
 */
export async function netCancelOutcome(
  db: Db | Tx,
  paymentId: string,
): Promise<NetCancelOutcome | undefined> {
  const payload = schema.paymentEvents.payload;
  const [row] = await db
    .select({ payload })
    .from(schema.paymentEvents)
    .where(
      and(
        eq(schema.paymentEvents.paymentId, paymentId),
        eq(schema.paymentEvents.type, 'net_cancel'),
      ),
    )
    .orderBy(
      desc(sql`coalesce(${payload}->>'outcome' = 'cancelled', false)`),
      desc(schema.paymentEvents.id),
    )
    .limit(1);
  if (!row) return undefined;
  const outcome = (row.payload as Record<string, unknown> | null)?.outcome;
  return typeof outcome === 'string' && NET_CANCEL_OUTCOMES.has(outcome)
    ? (outcome as NetCancelOutcome)
    : 'unknown';
}

/**
 * What a 재통보 says about a cancel, as it carried it (신통보 names, else the 구통보 TID/OTID).
 * `tid` is the notice's own Tid, which its SignValue covers; `otid` the original transaction's.
 */
export interface CancelNotice {
  stateCd: string | undefined;
  resultCode: string | undefined;
  payMethod: string | undefined;
  tid: string | undefined;
  otid: string | undefined;
  amt: string | undefined;
}

/**
 * What a (verified) 재통보 says about the card of a payment:
 * - `full`: the whole approval was cancelled — StateCd 1 (전취소) or 2 (후취소), a ResultCode
 *   classifyCancel reads as `cancelled` for the payment's method (`payments.method`, else the
 *   notice's own PayMethod), and the shape of a full cancel: no Otid other than its own Tid, and
 *   no Amt other than the payment's.
 * - `partial`: a cancel that went through for PART of the amount. The manual sets Otid "부분취소의
 *   경우" to the original Tid (retryModule) — a partial cancel has a Tid of its own (cancelModule:
 *   PTid) — and its Amt is not the whole price. This service only ever cancels in full (owner
 *   decision 5), so one made in the merchant admin moves nothing: a person reconciles it.
 * - `none`: an approval, or a cancel that failed (a card's 2015 included): it proves nothing.
 */
export type CancelNoticeKind = 'full' | 'partial' | 'none';

export function cancelNoticeKind(
  notice: CancelNotice,
  payment: { method: string | null; priceKrw: number },
): CancelNoticeKind {
  if (notice.stateCd !== '1' && notice.stateCd !== '2') return 'none';
  if (classifyCancel(notice.resultCode, payment.method ?? notice.payMethod) !== 'cancelled') {
    return 'none';
  }
  const otherOriginal = notice.otid !== undefined && notice.otid !== notice.tid;
  // Whether Amt carries the cancelled amount or the original one, a full cancel's is the price.
  const otherAmount = notice.amt !== undefined && parseKrw(notice.amt) !== payment.priceKrw;
  return otherOriginal || otherAmount ? 'partial' : 'full';
}

/**
 * Whether a FULL cancel notice whose own Tid is `noticeTid` cancelled `payment`'s approval:
 * - A payment not yet credited (`pending`, `failed`) holds the authentication's Tid, which the
 *   approval's may differ from (the manual, STEP 4). A claimed one has exactly one approval —
 *   the one its claim asked for — and the notice's Moid, which found the payment, names it.
 *   An unclaimed one was never approved (settleNotify): nothing of it can be cancelled.
 * - Any other holds the approval's own Tid (the credit, the net cancel and the settle all store
 *   it), and a full cancel carries that Tid (cancelModule: PTid, 전체취소 = 원거래 Tid). A
 *   notice naming another Tid is no cancel of it.
 */
export function cancelsApprovalOf(
  payment: { status: PaymentStatus; providerRef: string | null },
  noticeTid: string | undefined,
): boolean {
  if (payment.providerRef === null) return false;
  if (payment.status === 'pending' || payment.status === 'failed') return true;
  return noticeTid === payment.providerRef;
}

/** A recorded `notify` event as a CancelNotice (its payload, and the row's result_code). */
function recordedNotice(payload: unknown, resultCode: string | null): CancelNotice {
  // A JSON `null` in the column is not a notice either (as in netCancelOutcome).
  const fields = payload as Record<string, unknown> | null;
  const text = (...keys: string[]) => {
    for (const key of keys) {
      const value = fields?.[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return undefined;
  };
  return {
    stateCd: text('StateCd'),
    resultCode: text('ResultCode') ?? resultCode ?? undefined,
    payMethod: text('PayMethod'),
    tid: text('Tid', 'TID'),
    otid: text('Otid', 'OTID'),
    amt: text('Amt'),
  };
}

/** The payment fields a cancel notice is judged against. */
export interface NoticeTarget {
  id: string;
  status: PaymentStatus;
  providerRef: string | null;
  method: string | null;
  priceKrw: number;
}

/**
 * Whether SmartroPay's 재통보 has told us `payment`'s approval was cancelled in full: a `notify`
 * event (recorded only once its sender and SignValue verified) that cancelNoticeKind reads as
 * `full` and that cancelsApprovalOf it, judged as the payment is now (`status`). A partial
 * cancel never counts.
 */
export async function hasCancelNotice(db: Db | Tx, payment: NoticeTarget): Promise<boolean> {
  const payload = schema.paymentEvents.payload;
  const rows = await db
    .select({ resultCode: schema.paymentEvents.resultCode, payload })
    .from(schema.paymentEvents)
    .where(
      and(
        eq(schema.paymentEvents.paymentId, payment.id),
        eq(schema.paymentEvents.type, 'notify'),
        sql`${payload}->>'StateCd' in ('1', '2')`,
      ),
    );
  return rows.some((row) => {
    const notice = recordedNotice(row.payload, row.resultCode);
    return cancelNoticeKind(notice, payment) === 'full' && cancelsApprovalOf(payment, notice.tid);
  });
}
