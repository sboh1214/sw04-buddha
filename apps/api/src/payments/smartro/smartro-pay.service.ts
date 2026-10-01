import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  CARD_MIN_PRICE_KRW,
  formatKrw,
  isNoEmailAddress,
  moidToPaymentId,
  paymentIdToMoid,
  vatSplit,
  type ChargeBody,
  type PaymentEventType,
  type PaymentProviderInfo,
  type PaymentReturnResult,
  type PaymentStatus,
  type SmartroPrepareResult,
} from '@buddha/shared';
import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import { assertExpectedAccount } from '../../auth/expected-account.js';
import { AppError } from '../../common/errors/app-error.js';
import { findPgError, isPgError, PG_UNIQUE_VIOLATION } from '../../common/errors/pg-error.js';
import { clockTimestamp } from '../../infra/db/clock.js';
import { DB } from '../../infra/db/db.provider.js';
import {
  type CreditInput,
  type CreditOutcome,
  type PaymentRow,
  WalletService,
} from '../../wallet/wallet.service.js';
import { type PaymentEventInput, recordPaymentEvent, resultMessageOf } from '../payment-events.js';
import { type CancelOutcome } from '../payment-provider.js';
import { PaymentProviderRegistry } from '../payment-provider.registry.js';
import {
  PROVIDER_REF_UNIQUE,
  type CancelNotice,
  type CrossPostedApproval,
  approvalsMadeElsewhere,
  approvedAmountOf,
  cancelNoticeKind,
  cancelsApprovalOf,
  crossPostedApprovalOf,
  markRefunded,
  netCancelOutcome,
  recordedCancelNotices,
} from '../payment-transitions.js';
import { PAYMENTS_CONFIG, type PaymentsConfig, type SmartroConfig } from '../payments-config.js';
import { type CallbackFields, type CallbackRequest, field } from './callback-form.js';
import {
  SMARTRO_CLIENT,
  SmartroUnreachableError,
  type SmartroAuth,
  type SmartroClient,
  type SmartroResponse,
} from './smartro-client.js';
import { stringField } from './smartro-payment.provider.js';
import {
  APPROVAL_SUCCESS_CODES,
  ediDate,
  encryptData,
  goodsName,
  isAllowedNotifyAddress,
  isApprovalSuccess,
  isApprovalUnknown,
  mallUserId,
  parseKrw,
  smartroCallbackUrl,
  smartroScriptUrls,
  verifySignValue,
} from './smartro-protocol.js';

/** BuyerEmail: at most 60 characters; a longer address is left out rather than cut. */
const BUYER_EMAIL_MAX = 60;
/** `payments.method` is varchar(16). */
const METHOD_MAX = 16;

/** CancelMsg of a net cancel: an approval we could not verify or could not credit. */
const NET_CANCEL_REASON = '가맹점 승인 처리 실패로 인한 자동 취소';

/**
 * `payments.result_message` of a payment a cancel 재통보 closed before it was credited — the
 * reason the payer and the admin list read, not the PG's "취소 성공".
 */
const NOTICE_CANCEL_REASON = '결제대행사 취소 통보에 따른 취소';

/**
 * `payments.result_message` of a payment whose approval was another payment's window (netCancel,
 * the payment it only names): the Moid and the Tid the merchant admin files that charge under,
 * and what it charged (the approval's Amt — the other payment's price, or this one's when that
 * Moid was typed into this payment's own window). The settle dialog shows this payment's own
 * 주문번호, under which the merchant admin finds nothing; the admin row's reason line (and the
 * payer's) says where to look instead. Worded to stay true once settled: honoured, the P comes
 * from a balance adjustment, never from this payment.
 */
function crossPostReason(moid: string, tid: string, amount: number | null): string | null {
  const charged = amount === null ? '' : `승인 금액 ${formatKrw(amount)}, `;
  return resultMessageOf(
    `다른 주문번호(${moid})의 결제창이 이 결제로 승인됨 — ${charged}승인 거래번호(TID) ${tid}, 이 결제로는 충전하지 않음(관리자 확인)`,
  );
}

/** An approval's Amt as a log says it: what the card was charged, when the answer told. */
function chargedText(amount: number | null): string {
  return amount === null ? 'an amount its answer did not give' : `${String(amount)} KRW`;
}

/**
 * What a cancel 재통보 that went through did (settleCancelNotice): finished a refund, confirmed a
 * net cancel, closed a payment not yet credited — or nothing, and why.
 */
type CancelNoticeVerdict =
  | 'refunded'
  | 'confirmed'
  | 'cancelled'
  | 'external'
  | 'partial'
  | 'unclaimed'
  | 'other-approval'
  | 'cross-post'
  | 'settled';

/**
 * How an admin reconciles a partial cancel of a payment's card, by the payment as the notice
 * found it. No settle outcome moves part of the P: a credit or a restore is refused
 * (`partial_cancel`), so the payment is closed by the settle that says the card is (partly)
 * cancelled, and the P the rest is worth is set with a balance adjustment. A payment credited
 * (`succeeded`) or refunded is no settle's, nor is a `cancelled` one whose net cancel is
 * confirmed: only the adjustment applies. One no ReturnUrl claimed was never approved
 * (settleNotify): there is no card of it to reconcile.
 */
function partialCancelFix(
  paymentId: string,
  payment: { status?: PaymentStatus; providerRef?: string | null },
): string {
  const settle = `POST /admin/payments/${paymentId}/settle`;
  const adjust = 'POST /admin/users/:id/balance-adjust';
  switch (payment.status) {
    case 'pending':
    case 'failed':
      if (payment.providerRef === null) {
        return 'no ReturnUrl claimed it, so none of its approvals is ours — check the notice by hand';
      }
      return `a settle credit is refused (partial_cancel) — settle it cancelled (${settle}), then adjust the balance (${adjust})`;
    case 'cancelled':
      // Open to a settle only while its net cancel is unconfirmed (needsReview); once confirmed
      // it is closed, and every settle outcome answers `status`.
      return `if the admin list flags it (its net cancel unconfirmed), settle it cancelled (${settle}; a settle credit is refused: partial_cancel); either way adjust the balance (${adjust})`;
    case 'refunding':
      return `a settle restore is refused (partial_cancel) — settle it refunded (${settle}), then adjust the balance (${adjust})`;
    default:
      return `no settle applies to a ${String(payment.status)} payment — adjust the balance only (${adjust})`;
  }
}

/**
 * What held a credit back, once something has: a recorded cancel 재통보 (cancelNoticeHold), or —
 * the approval 재통보's only (approvalNoticeHold) — the approval that spent the payment's claim on
 * another payment's window (`crossPost`).
 */
interface HeldBy {
  by: 'full' | 'partial' | 'cross-post' | undefined;
  crossPost?: CrossPostedApproval;
}

/**
 * The `holdBack` of every credit of a SmartroPay approval — the ReturnUrl's and the approval
 * 재통보's (ADR-0042): no credit while a cancel 재통보 of the card is on record
 * (recordedCancelNotices), judged under the payment row's lock, which that notice's own
 * transaction takes too. A full one's own judgement closes the payment (a person settles one it
 * left open); a partial one means the whole P is not owed, and nothing here says how much is.
 * `held.by` says which one held the credit back.
 */
function cancelNoticeHold(): { held: HeldBy; holdBack: NonNullable<CreditInput['holdBack']> } {
  const held: HeldBy = { by: undefined };
  return {
    held,
    holdBack: async (tx, locked) => {
      const notices = await recordedCancelNotices(tx, locked);
      held.by = notices.full ? 'full' : notices.partial ? 'partial' : undefined;
      return held.by !== undefined;
    },
  };
}

/**
 * The approval 재통보's `holdBack`: cancelNoticeHold's — and first, none for a payment whose one
 * approval call approved another payment's window (crossPostedApprovalOf), judged under the
 * same lock: no approval of its own Moid is its own, and a credit would end its flag while that
 * window's charge is owed. Before the cancel notices: a cancel 재통보 of its Moid closes no such
 * payment (cancelNoticeVerdict), so it is no reason the log may give.
 */
function approvalNoticeHold(): { held: HeldBy; holdBack: NonNullable<CreditInput['holdBack']> } {
  const inner = cancelNoticeHold();
  return {
    held: inner.held,
    holdBack: async (tx, locked) => {
      const crossPost = await crossPostedApprovalOf(tx, locked);
      if (crossPost) {
        inner.held.by = 'cross-post';
        inner.held.crossPost = crossPost;
        return true;
      }
      return inner.holdBack(tx, locked);
    },
  };
}

/**
 * A cancel 재통보 judged under the payment row's lock: the verdict, and the payment as it was
 * then (its status and reference) with the approval amount the notice was read against.
 */
interface JudgedCancelNotice {
  verdict: CancelNoticeVerdict | 'no-cancel';
  status?: PaymentStatus;
  providerRef?: string | null;
  amount: number;
  /** The approval that spent the payment's claim on another payment's window, if one did. */
  crossPost?: CrossPostedApproval;
}

/**
 * Another payment of ours an approval belongs to (otherPaymentOf): one that holds its Tid as
 * `provider_ref` (`holdsTid`), else the one its Moid names.
 */
interface OtherPayment extends Pick<
  PaymentRow,
  'id' | 'userId' | 'provider' | 'status' | 'providerRef'
> {
  holdsTid: boolean;
}

/**
 * The payment an approval only names, as closeNamedPayment left it: how it stands for the log
 * (`state`, with what went wrong closing or reading it), and what picks the advice
 * (crossPostAdvice): its status and claim; whether its own claim was spent on yet another
 * payment's window (`spent`: then nothing of its Moid credits or closes it); and, `cancelled`,
 * whether its own net cancel is still unconfirmed (`unconfirmed`: open to a settle).
 */
interface NamedPayment {
  state: string;
  status: PaymentStatus;
  providerRef: string | null;
  spent: boolean;
  unconfirmed: boolean;
}

/**
 * Another SmartroPay payment whose own ReturnUrl made an approval, for a log to name
 * (madeThrough): one holding its Tid as its claim (`holds`), else one whose approval call's
 * answer recorded it — with the Moid that answer named (`moid`: none when no answer reached it).
 */
interface MadeThrough {
  id: string;
  userId: string;
  holds: boolean;
  moid: string | undefined;
}

/** The handle `db.transaction` hands its callback; @buddha/db exports no alias for it. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** What SmartroPay needs in its body to stop re-sending a 재통보. */
export const NOTIFY_OK = 'OK';

/**
 * The fields a callback's `payment_events` row keeps: what SmartroPay's ReturnUrl, StopUrl and
 * 재통보 posts carry (신통보 names, and the 구통보 TID/OTID/OID/MID). The ReturnUrl and StopUrl
 * are public and the table is append-only, so nothing else a caller posts is ever stored.
 */
const CALLBACK_EVENT_FIELDS = [
  'Tid',
  'TID',
  'Otid',
  'OTID',
  'TrAuthKey',
  'Moid',
  'OID',
  'Mid',
  'MID',
  'ResultCode',
  'ResultMsg',
  'PayMethod',
  'Amt',
  'AuthDate',
  'AuthCode',
  'StateCd',
  'FnCd',
  'FnName',
] as const;

/** A callback as its `payment_events` row: the known fields only (CALLBACK_EVENT_FIELDS). */
function callbackEvent(
  paymentId: string,
  type: PaymentEventType,
  fields: CallbackFields,
): PaymentEventInput {
  const payload: Record<string, string> = {};
  for (const name of CALLBACK_EVENT_FIELDS) {
    const value = fields.get(name);
    if (value !== undefined) payload[name] = value;
  }
  return {
    paymentId,
    type,
    resultCode: field(fields, 'ResultCode'),
    resultMessage: field(fields, 'ResultMsg'),
    payload,
  };
}

/**
 * The browser's `result` for a payment already past `pending` (a double submit, the back
 * button). A refunded charge did succeed; its refund is a later, separate event the wallet shows.
 * Read through resultOf: a `cancelled` payment whose cancel is not confirmed is `pending`.
 */
const RESULT_BY_STATUS: Readonly<Record<PaymentStatus, PaymentReturnResult>> = {
  pending: 'pending',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
  refunding: 'succeeded',
  refunded: 'succeeded',
};

interface Buyer {
  realName: string;
  phone: string;
  /** `''` for an account without a real mailbox (the synthetic social-login address). */
  email: string;
}

/** The fields of an approval (or inquiry) answer this service uses; the rest is only logged. */
interface Approval {
  resultCode: string;
  resultMessage?: string;
  tid?: string;
  moid?: string;
  mid?: string;
  amt?: string;
  payMethod?: string;
  signValue?: string;
}

/** Undefined when the answer carries no ResultCode: it says nothing about the payment. */
function readApproval(answer: SmartroResponse): Approval | undefined {
  const resultCode = stringField(answer, 'ResultCode');
  if (resultCode === undefined || resultCode.length === 0) return undefined;
  const text = (key: string) => {
    const value = stringField(answer, key);
    return value === undefined || value.length === 0 ? undefined : value;
  };
  return {
    resultCode,
    resultMessage: text('ResultMsg'),
    tid: text('Tid'),
    moid: text('Moid'),
    mid: text('Mid'),
    amt: text('Amt'),
    payMethod: text('PayMethod'),
    signValue: text('SignValue'),
  };
}

/**
 * What a failure may say in a log line. Never the error's own message when it came from the
 * driver: drizzle puts the bound parameters there (a TrAuthKey on the return path), and nothing
 * the PG sent may reach a log beyond its result code (ADR-0042 「payment_events」).
 */
export function describeFailure(error: unknown): string {
  if (error instanceof AppError) return `${error.code}: ${error.message}`;
  if (error instanceof SmartroUnreachableError) return error.message;
  const pg = findPgError(error);
  if (pg) return `SQLSTATE ${pg.code}`;
  return error instanceof Error ? error.name : 'unknown failure';
}

/**
 * SmartroPay 일반연동 (ADR-0042): the charge flow the web opens when PAYMENT_PROVIDER=smartro.
 *
 * 1. `prepare` reserves a `pending` payment and signs the `tranMgr` form for it.
 * 2. The payment window authenticates the payer and hands back Tid + TrAuthKey — to our
 *    ReturnUrl (mobile, a cross-site POST with no cookie) or through the SDK's Callback, which
 *    our page submits there (PC). `handleReturn` asks the PG to approve, verifies the answer and
 *    credits the P, or net-cancels an approval it cannot credit.
 * 3. `handleStop` closes a payment the payer abandoned; `handleNotify` (재통보) settles one the
 *    ReturnUrl claimed but whose approval answer it never got.
 *
 * Every callback finds its payment by Moid (our payment id without hyphens), never by session,
 * and every exchange with the PG is appended to `payment_events` — a ReturnUrl or StopUrl only
 * when it acts on a payment (claims or closes it), so re-posting one to a settled payment, which
 * anyone who knows its Moid can do, stores nothing.
 */
@Injectable()
export class SmartroPayService {
  private readonly logger = new Logger(SmartroPayService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(PAYMENTS_CONFIG) private readonly config: PaymentsConfig,
    @Inject(SMARTRO_CLIENT) private readonly client: SmartroClient,
    private readonly wallet: WalletService,
    private readonly providers: PaymentProviderRegistry,
  ) {}

  /** `GET /payments/provider`: which charge flow the web offers. */
  providerInfo(now: Date = new Date()): PaymentProviderInfo {
    const smartro = this.config.provider === 'smartro' ? this.config.smartro : null;
    if (!smartro) return { provider: 'mock' };
    return {
      provider: 'smartro',
      mode: smartro.mode,
      scriptUrl: smartroScriptUrls(smartro.mode, now),
    };
  }

  /**
   * `POST /payments/smartro/prepare`. The same guards, in the same order, as the immediate
   * charge (`WalletService.charge`) — account, replay by key, package, terms — plus the card
   * minimum and the buyer's contact, which the payment window requires (BuyerName, BuyerTel).
   */
  async prepare(
    userId: string,
    body: ChargeBody,
    idempotencyKey: string,
  ): Promise<SmartroPrepareResult> {
    const smartro = this.config.provider === 'smartro' ? this.config.smartro : null;
    if (!smartro) {
      throw new AppError('NOT_FOUND', {
        message: 'SmartroPay is not the configured payment provider',
      });
    }
    assertExpectedAccount(userId, body.expectedAccountId);
    const earlier = await this.wallet.paymentByKey(userId, idempotencyKey);
    if (earlier) return this.replay(smartro, earlier, body);

    const quote = await this.wallet.quote(body);
    // Below 1,000원 the PG refuses a card (ResultCode 3041) after the payer typed it all in.
    if (quote.priceKrw < CARD_MIN_PRICE_KRW) {
      throw new AppError('VALIDATION_ERROR', {
        message: `A card payment must be at least ${String(CARD_MIN_PRICE_KRW)} KRW`,
        details: [{ path: ['packageId'], message: 'below the card minimum' }],
      });
    }
    const buyer = await this.buyerOf(userId);
    // Before anything is reserved, as in `charge`: a broken account (no balance row) would
    // otherwise pay and then fail its credit.
    await this.wallet.getBalance(userId);

    const reservation = await this.wallet.reservePayment({
      userId,
      amountP: quote.amountP,
      priceKrw: quote.priceKrw,
      packageId: body.packageId,
      provider: 'smartro',
      idempotencyKey,
    });
    if ('earlier' in reservation) return this.replay(smartro, reservation.earlier, body);
    return this.signedForm(
      smartro,
      { id: reservation.paymentId, userId, amountP: quote.amountP, priceKrw: quote.priceKrw },
      buyer,
    );
  }

  /**
   * A key this account used before. Still `pending` and unclaimed — the window was never
   * completed, or the answer was lost — it gets a freshly signed form for the SAME payment (a
   * new EdiDate: the old signature may have aged). Anything else spends the key: other terms,
   * or a payment an approval already claimed or settled.
   */
  private async replay(
    smartro: SmartroConfig,
    earlier: PaymentRow,
    body: ChargeBody,
  ): Promise<SmartroPrepareResult> {
    if (
      earlier.provider !== 'smartro' ||
      earlier.amountP !== body.expectedAmountP ||
      earlier.priceKrw !== body.expectedPriceKrw ||
      (earlier.packageId !== null && earlier.packageId !== body.packageId)
    ) {
      throw new AppError('DUPLICATE_REQUEST', {
        message: 'This Idempotency-Key was already used for a different charge',
      });
    }
    if (earlier.status !== 'pending' || earlier.providerRef !== null) {
      throw new AppError('DUPLICATE_REQUEST', {
        message:
          'This Idempotency-Key belongs to a payment that has already been approved or closed',
      });
    }
    return this.signedForm(smartro, earlier, await this.buyerOf(earlier.userId));
  }

  /** The buyer fields of the window: the contact is required (ADR-0043), the email optional. */
  private async buyerOf(userId: string): Promise<Buyer> {
    const [row] = await this.db
      .select({
        email: schema.user.email,
        realName: schema.userContacts.realName,
        phone: schema.userContacts.phone,
      })
      .from(schema.user)
      .leftJoin(schema.userContacts, eq(schema.userContacts.userId, schema.user.id))
      .where(eq(schema.user.id, userId))
      .limit(1);
    if (!row?.realName || !row.phone) {
      throw new AppError('CONTACT_REQUIRED', {
        message: 'Register a real name and a mobile number before paying',
      });
    }
    const email =
      isNoEmailAddress(row.email) || row.email.length > BUYER_EMAIL_MAX ? '' : row.email;
    return { realName: row.realName, phone: row.phone, email };
  }

  private signedForm(
    smartro: SmartroConfig,
    payment: { id: string; userId: string; amountP: bigint; priceKrw: number },
    buyer: Buyer,
    now: Date = new Date(),
  ): SmartroPrepareResult {
    const moid = paymentIdToMoid(payment.id);
    const amt = String(payment.priceKrw);
    const edi = ediDate(now);
    const vat = vatSplit(payment.priceKrw);
    const returnUrl = smartroCallbackUrl(this.config.webOrigin, 'return', moid);
    return {
      paymentId: payment.id,
      mode: smartro.mode,
      scriptUrl: smartroScriptUrls(smartro.mode, now),
      approvalUrl: returnUrl,
      form: {
        PayMethod: 'CARD',
        GoodsCnt: '1',
        GoodsName: goodsName(payment.amountP),
        Amt: amt,
        Moid: moid,
        Mid: smartro.mid,
        ReturnUrl: returnUrl,
        // Both fit in 100 characters: paymentsConfigFromEnv refuses to boot on a longer origin.
        StopUrl: smartroCallbackUrl(this.config.webOrigin, 'stop', moid),
        BuyerName: buyer.realName,
        BuyerTel: buyer.phone,
        BuyerEmail: buyer.email,
        EdiDate: edi,
        EncryptData: encryptData(edi, smartro.mid, amt, smartro.merchantKey),
        TaxAmt: String(vat.taxAmt),
        TaxFreeAmt: String(vat.taxFreeAmt),
        VatAmt: String(vat.vatAmt),
        MallUserId: mallUserId(payment.userId),
      },
    };
  }

  /** Where the callbacks send the browser: the wallet, with the outcome to announce. */
  walletUrl(paymentId: string | null, result: PaymentReturnResult): string {
    const query = new URLSearchParams();
    if (paymentId !== null) query.set('payment', paymentId);
    query.set('result', result);
    return `${this.config.webOrigin}/wallet?${query.toString()}`;
  }

  // --- ReturnUrl -----------------------------------------------------------------------

  /**
   * `POST /payments/smartro/return?m=<moid>` → the wallet URL to 303 to. Idempotent and
   * race-safe: whoever claims the payment (`provider_ref` set while `pending`) is the only
   * request that ever asks the PG to approve it; a double submit reads the current status.
   * Nothing in here answers with an error page — the browser always lands on the wallet, and
   * an unexpected failure says `pending`: the payment row, the 재통보 and an admin settle it.
   */
  async handleReturn(request: CallbackRequest): Promise<string> {
    let paymentId: string | null = null;
    try {
      const payment = await this.callbackPayment(request.moid ?? field(request.fields, 'Moid'));
      if (!payment) return this.walletUrl(null, 'failed');
      paymentId = payment.id;
      return await this.settleReturn(payment, request.fields);
    } catch (error) {
      this.logger.error(
        `ReturnUrl of payment ${paymentId ?? '(unknown)'} failed: ${describeFailure(error)}`,
      );
      return this.walletUrl(paymentId, 'pending');
    }
  }

  private async settleReturn(payment: PaymentRow, fields: CallbackFields): Promise<string> {
    if (payment.status !== 'pending') {
      return this.walletUrl(payment.id, await this.resultOf(payment.id, payment.status));
    }
    // Another request holds the approval (the Tid 중복 FAQ: a second submit of the same form).
    if (payment.providerRef !== null) return this.walletUrl(payment.id, 'pending');

    const smartro = this.config.smartro;
    if (!smartro) {
      this.logger.error(`ReturnUrl of payment ${payment.id}: SmartroPay is not configured`);
      return this.walletUrl(payment.id, 'failed');
    }

    const tid = field(fields, 'Tid');
    const trAuthKey = field(fields, 'TrAuthKey');
    // Recorded only with the change it causes (the claim, or the close), in its transaction.
    const event = callbackEvent(payment.id, 'return', fields);
    if (tid === undefined || trAuthKey === undefined) {
      // The window came back without an authentication: nothing can be approved.
      const closed = await this.markFailed(
        payment.id,
        resultMessageOf(field(fields, 'ResultMsg')),
        'unclaimed',
        event,
      );
      return closed ? this.walletUrl(payment.id, 'failed') : this.currentResult(payment.id);
    }

    const claim = await this.claim(payment.id, tid, event);
    if (claim === 'lost') return this.currentResult(payment.id);
    if (claim === 'foreign-tid') {
      // A Tid already recorded on ANOTHER payment: approving it here could credit one PG
      // transaction twice. Nothing of ours was approved, so this payment just fails.
      this.logger.warn(`ReturnUrl of payment ${payment.id} carried a Tid another payment holds`);
      const closed = await this.markFailed(payment.id, null, 'unclaimed', event);
      return closed ? this.walletUrl(payment.id, 'failed') : this.currentResult(payment.id);
    }

    const approval = await this.approveOrInquire(payment.id, { Tid: tid, TrAuthKey: trAuthKey });
    if (!approval) return this.walletUrl(payment.id, 'pending');
    return this.settleApproval(smartro, payment, approval, tid);
  }

  /**
   * `provider_ref = Tid` while the payment is `pending` and unclaimed: the one statement that
   * decides which of two concurrent submits approves, committed with the `return` event (ADR-0042
   * 「ReturnUrl」 step 3) so a claimed payment always shows what claimed it. It holds the payment row
   * alone (no balance lock), so it cannot take part in a deadlock with a credit or a refund.
   */
  private async claim(
    paymentId: string,
    tid: string,
    event: PaymentEventInput,
  ): Promise<'claimed' | 'lost' | 'foreign-tid'> {
    try {
      return await this.db.transaction(async (tx) => {
        const rows = await tx
          .update(schema.payments)
          .set({ providerRef: tid, updatedAt: new Date() })
          .where(
            and(
              eq(schema.payments.id, paymentId),
              eq(schema.payments.status, 'pending'),
              isNull(schema.payments.providerRef),
            ),
          )
          .returning({ id: schema.payments.id });
        if (rows.length === 0) return 'lost';
        await recordPaymentEvent(tx, event);
        return 'claimed';
      });
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION, PROVIDER_REF_UNIQUE)) return 'foreign-tid';
      throw error;
    }
  }

  /**
   * The approval, and on NO answer (network, timeout, unreadable body) one result inquiry —
   * the approval may have gone through even though its answer did not. Undefined when neither
   * answered: the payment stays `pending` (claimed), for the 재통보 or an admin.
   *
   * Only a SUCCESS from the inquiry counts. The manual promises its answer equals the
   * approval's only for an approved transaction ("승인 후 1시간 이내의 거래"), and its other
   * codes include the inquiry's own failures (6017 승인이력 없음, 6021 거래조회 오류, W036,
   * 9999): asked while a slow approval is still on its way, it says "nothing found" about a card
   * about to be charged. So any other answer is no answer either (ADR-0042 「ReturnUrl」 step 4:
   * still unknown → keep `pending`), never a failure — a failed payment's charge nobody would
   * look for.
   */
  private async approveOrInquire(
    paymentId: string,
    auth: SmartroAuth,
  ): Promise<Approval | undefined> {
    const attempts: [PaymentEventType, () => Promise<SmartroResponse>][] = [
      ['approval', () => this.client.approve(auth)],
      ['approval_inquiry', () => this.client.inquire(auth)],
    ];
    for (const [type, call] of attempts) {
      let answer: SmartroResponse;
      try {
        answer = await call();
      } catch (error) {
        const why = describeFailure(error);
        this.logger.warn(`payment ${paymentId}: ${type} got no answer (${why})`);
        await recordPaymentEvent(this.db, { paymentId, type, payload: { error: why } });
        continue;
      }
      const approval = readApproval(answer);
      await recordPaymentEvent(this.db, {
        paymentId,
        type,
        resultCode: approval?.resultCode,
        resultMessage: approval?.resultMessage,
        payload: answer,
      });
      if (approval && (type === 'approval' || isApprovalSuccess(approval.resultCode))) {
        return approval;
      }
      this.logger.warn(
        approval
          ? `payment ${paymentId}: ${type} answered ${approval.resultCode}, which says nothing of the approval`
          : `payment ${paymentId}: ${type} answered without a ResultCode`,
      );
    }
    this.logger.error(
      `payment ${paymentId}: approval outcome unknown; left pending for the 재통보 — or check it in the merchant admin and settle it (POST /admin/payments/${paymentId}/settle)`,
    );
    return undefined;
  }

  private async settleApproval(
    smartro: SmartroConfig,
    payment: PaymentRow,
    approval: Approval,
    authTid: string,
  ): Promise<string> {
    if (!isApprovalSuccess(approval.resultCode)) {
      // Any other answer fails the payment (ADR-0042 「ReturnUrl」 step 5) — also the PG's own
      // failure, which is no decline: the card may be charged all the same. That one the admin
      // list flags (`needsReview`), and this says so.
      const failed = await this.markFailed(
        payment.id,
        resultMessageOf(approval.resultMessage),
        'claimed',
      );
      if (failed && isApprovalUnknown(approval.resultCode)) {
        this.logger.error(
          `payment ${payment.id}: the approval answered ${approval.resultCode}, the PG's own failure rather than a decline; failed, but the card may be charged — check it in the merchant admin and settle it (POST /admin/payments/${payment.id}/settle: credit, cancelled or failed)`,
        );
      }
      return failed ? this.walletUrl(payment.id, 'failed') : this.currentResult(payment.id);
    }

    // The approval's own Tid, which may differ from the authentication's (the manual, STEP 4).
    const tid = approval.tid ?? authTid;
    const mismatches = this.verifyApproval(smartro, payment, approval, tid);
    if (mismatches.length > 0) {
      this.logger.error(
        `payment ${payment.id}: approval ${tid} does not verify (${mismatches.join(', ')}); net-cancelling`,
      );
      return this.netCancel(payment, tid, approval);
    }

    // Held back like the approval 재통보's credit (cancelNoticeHold): a cancel 재통보 of the card
    // may arrive while the approval runs — the PG approved at our call, and its answer (or the
    // inquiry's) takes seconds to come back — and a partial one leaves the payment `pending`.
    const { held, holdBack } = cancelNoticeHold();
    let credit: CreditOutcome;
    try {
      credit = await this.wallet.creditPayment({
        paymentId: payment.id,
        userId: payment.userId,
        amountP: payment.amountP,
        from: ['pending'],
        providerRef: tid,
        method: approval.payMethod?.slice(0, METHOD_MAX) ?? null,
        resultMessage: resultMessageOf(approval.resultMessage),
        holdBack,
      });
    } catch (error) {
      // Read again before cancelling: the credit may have committed and failed only after
      // (a COMMIT whose acknowledgement was lost), or the 재통보 may have credited this approval
      // meanwhile. A payment no longer `pending` is not this request's to cancel — once it
      // succeeded, its P is in the balance and cancelling the card would give it away.
      const current = await this.currentStatus(payment.id);
      if (current !== undefined && current !== 'pending') {
        this.logger.error(
          `payment ${payment.id}: the credit of ${tid} failed (${describeFailure(error)}) but the payment is ${current}; not cancelled`,
        );
        return this.walletUrl(payment.id, await this.resultOf(payment.id, current));
      }
      this.logger.error(
        `payment ${payment.id}: approved (${tid}) but the credit failed (${describeFailure(error)}); net-cancelling`,
      );
      return this.netCancel(payment, tid, approval);
    }
    if (credit.credited || credit.status === 'succeeded') {
      // Credited here, or by the 재통보 that arrived while the approval ran.
      if (!credit.credited) await this.creditedUnderAnotherTid(payment, tid, 'approval');
      return this.walletUrl(payment.id, 'succeeded');
    }
    if (credit.heldBack) {
      // Never net-cancelled: the card is cancelled already, in full or in part, and this service
      // cancels only in full. The payment stays claimed as it was, for that notice or a person.
      if (held.by === 'full') {
        // That notice is recorded before it is judged (under the lock this credit held), so its
        // judgement follows and closes the payment `cancelled`.
        this.logger.warn(
          `payment ${payment.id}: approved (${tid}) but a full cancel 재통보 of the card is on record; not credited — that notice closes it cancelled unless it already ran and did not; if it stays ${String(credit.status)}, check the card in the merchant admin and settle it (POST /admin/payments/${payment.id}/settle)`,
        );
      } else {
        this.logger.error(
          `payment ${payment.id}: approved (${tid}) but a partial cancel 재통보 of the card is on record; not credited — check the card in the merchant admin, settle it cancelled (POST /admin/payments/${payment.id}/settle; a settle credit is refused: partial_cancel), then adjust the balance by hand (POST /admin/users/:id/balance-adjust)`,
        );
      }
      // As it stands now: `pending` while it is open — or `cancelled` once the full notice's
      // judgement has closed it.
      return this.currentResult(payment.id);
    }
    const result = credit.status ? await this.resultOf(payment.id, credit.status) : 'pending';
    if (credit.status === 'cancelled' && result === 'cancelled') {
      // A cancel 재통보 closed it while the approval ran: the PG's word that this card is
      // cancelled. Nothing is owed and nothing is left to settle.
      this.logger.warn(
        `payment ${payment.id}: approved (${tid}) but a cancel 재통보 had closed it cancelled meanwhile; nothing credited`,
      );
    } else {
      this.logger.error(
        `payment ${payment.id}: approved (${tid}) but it was ${credit.status ?? 'gone'} before the credit; check the card in the merchant admin and settle it (POST /admin/payments/${payment.id}/settle)`,
      );
    }
    return this.walletUrl(payment.id, result);
  }

  /** Every check an approval must pass before its P is credited (ADR-0042 「ReturnUrl」 step 6). */
  private verifyApproval(
    smartro: SmartroConfig,
    payment: PaymentRow,
    approval: Approval,
    tid: string,
  ): string[] {
    const mismatches: string[] = [];
    if (
      approval.signValue === undefined ||
      !verifySignValue(approval.signValue, tid, approval.resultCode, smartro.merchantKey)
    ) {
      mismatches.push('SignValue');
    }
    if (approval.mid !== smartro.mid) mismatches.push('Mid');
    if (approval.moid !== paymentIdToMoid(payment.id)) mismatches.push('Moid');
    if (parseKrw(approval.amt) !== payment.priceKrw) mismatches.push('Amt');
    return mismatches;
  }

  /**
   * 망취소: the PG approved a payment we will not credit, so the card is cancelled at once —
   * for the amount it actually approved. The `net_cancel` event records how it ended
   * (`payload.outcome`), and the payment follows:
   * - `cancelled`: it stays `cancelled`.
   * - `refused` (a definite no: the approval stands and the card is charged): back to `pending`
   *   in the same transaction as the event, where the 재통보 can still credit it — unless a
   *   cancel 재통보 confirmed the card cancelled meanwhile; then it stays `cancelled`.
   * - `unknown`: it stays `cancelled` — the card may be cancelled, so no 재통보 may credit it —
   *   for an admin to check in the merchant admin and settle (`needsReview`).
   *
   * Never an approval that belongs to ANOTHER payment of ours: its Moid names one, or its Tid
   * is already one's reference. This payment, which nothing approved, fails (claimed) and is
   * never credited with it (a settle credit is refused: approval_mismatch, the Moid).
   * - The other payment HOLDS the Tid (a payer who replays an earlier payment's Tid and
   *   TrAuthKey here gets that approval back from the inquiry): its own flow has the approval,
   *   and cancelling it would cancel a card whose P was credited. Nothing more is owed.
   * - It only NAMES it (Moid): the authentication of that payment's window was posted to this
   *   payment's ReturnUrl — under 인증/승인 분리 our call approves whatever Tid and TrAuthKey it
   *   is given. While the named payment is unclaimed, no flow of ours can ever credit that
   *   approval: its own ReturnUrl with the same Tid collides with this claim ('foreign-tid'),
   *   its approval 재통보 credits claimed payments only, and the settle takes no unclaimed one.
   *   So the card is charged with no P, and the admin list flags THIS payment, which holds the
   *   claim and the answer (`needsReview`: a successful approval on a failed payment whose Tid
   *   no other payment holds), for a person to cancel the card in the merchant admin or honour
   *   it by hand. Its reason (crossPostReason) names the Moid, the Tid and the amount the
   *   merchant admin files that charge under: the admin row shows it, and the settle dialog's
   *   주문번호 is this payment's own. Nothing of this payment's own Moid ends that flag after: its
   *   claim is spent (crossPostedApprovalOf), so an approval 재통보 of its Moid is not credited,
   *   a cancel 재통보 of it does not close it, and a settle does not credit it — such an approval
   *   was made elsewhere and is settled there. The named payment, while `pending`, unclaimed and the same account's, is
   *   closed `failed` with it (closeNamedPayment), so its own ReturnUrl and its idempotency key
   *   approve no window of it again. That is all it stops: a window of it already
   *   authenticated, cross-posted the same way to a third payment's ReturnUrl, is approved there
   *   too — and flags that payment, never credits it. Another account's is left open: a payer
   *   can type any Moid into a window of their own (EncryptData does not cover it). A named
   *   payment claimed already (a window of its own, or its own claim won the race with that
   *   close) may get two approvals under its Moid. The log's advice turns on how the named one
   *   stands (crossPostAdvice), and ADR-0042's 2026-10-01 addendum lists what is left open.
   */
  private async netCancel(payment: PaymentRow, tid: string, approval: Approval): Promise<string> {
    const owner = await this.otherPaymentOf(payment.id, approval.moid, tid);
    if (owner?.holdsTid) {
      const failed = await this.markFailed(payment.id, null, 'claimed');
      this.logger.error(
        `payment ${payment.id}: approval ${tid} belongs to payment ${owner.id}, which holds it; not cancelled, this payment fails`,
      );
      return failed ? this.walletUrl(payment.id, 'failed') : this.currentResult(payment.id);
    }
    if (owner !== undefined) {
      const amount = parseKrw(approval.amt);
      const failed = await this.markFailed(
        payment.id,
        crossPostReason(paymentIdToMoid(owner.id), tid, amount),
        'claimed',
      );
      // Not failed: settled meanwhile (a 재통보 of its own Moid credited or closed it while this
      // approval ran) — then nothing flags this approval, and the log says so.
      const meanwhile = failed
        ? undefined
        : await this.currentStatus(payment.id).then(
            (status) => status ?? 'gone',
            () => 'unreadable',
          );
      const named = await this.closeNamedPayment(owner, payment.userId);
      this.logger.error(this.crossPostAdvice(payment, owner, named, tid, amount, meanwhile));
      return failed ? this.walletUrl(payment.id, 'failed') : this.currentResult(payment.id);
    }
    // Reserve before the PG is asked: `cancelled` first, so a 재통보 credit racing this cancel
    // finds the payment settled (or, while no `net_cancel` event exists yet, asks to be sent
    // again — settleNotify) instead of crediting P for a card that is about to be cancelled.
    // The reason goes with it: whatever the cancel comes to — confirmed later by a 재통보 or an
    // admin — this is why the payment ended, and the payer and the admin list read it.
    const reserved = await this.db
      .update(schema.payments)
      .set({
        status: 'cancelled',
        providerRef: tid,
        resultMessage: NET_CANCEL_REASON,
        updatedAt: new Date(),
      })
      .where(and(eq(schema.payments.id, payment.id), eq(schema.payments.status, 'pending')))
      .returning({ id: schema.payments.id });
    if (reserved.length === 0) {
      const current = await this.currentStatus(payment.id);
      if (
        current === 'cancelled' &&
        (await netCancelOutcome(this.db, payment.id)) === 'cancelled'
      ) {
        // A cancel 재통보 closed it first: the card is cancelled already.
        this.logger.warn(
          `payment ${payment.id}: a cancel 재통보 closed it before its net cancel of ${tid}; nothing to cancel`,
        );
      } else {
        this.logger.error(
          `payment ${payment.id}: ${current ?? 'gone'} before its net cancel of ${tid}; not cancelled — check it in the admin payments list (refund a succeeded one that should not stand; settle anything else: POST /admin/payments/${payment.id}/settle)`,
        );
      }
      return this.currentResult(payment.id);
    }
    const provider = this.providers.get('smartro');
    // The whole of what the PG approved — for an approval of another amount, not the price.
    const cancelAmt = parseKrw(approval.amt) ?? payment.priceKrw;
    // A throw is "no answer" too: the card may or may not be cancelled.
    const unknown: CancelOutcome = { status: 'unknown' };
    const outcome: CancelOutcome = provider
      ? await provider
          .cancel({
            paymentId: payment.id,
            providerRef: tid,
            priceKrw: cancelAmt,
            reason: NET_CANCEL_REASON,
            // The approval's own: the payment has no method until it is credited.
            method: approval.payMethod ?? null,
          })
          .catch(() => unknown)
      : unknown;
    // The PG's answer may not name the outcome or the amount asked for: those are ours.
    const { outcome: _theirs, cancelAmt: _theirAmount, ...answer } = outcome.payload ?? {};
    const event: PaymentEventInput = {
      paymentId: payment.id,
      type: 'net_cancel',
      resultCode: outcome.resultCode,
      resultMessage: outcome.resultMessage,
      // First, so the 64-key bound on a stored payload can never drop them. `cancelAmt` is what
      // a full cancel 재통보 of this approval carries as its amount (approvedAmountOf).
      payload: { outcome: outcome.status, cancelAmt, ...answer },
    };

    if (outcome.status === 'refused') {
      // A definite no: the approval stands and the card is charged. Back to `pending` — where
      // the 재통보 can still credit it — in ONE transaction with the event, the revert first,
      // so no notice ever sees the refusal recorded on a payment that is still `cancelled`.
      // Unless a cancel 재통보 confirmed the card cancelled while the PG was answering here
      // (settleCancelNotice): the payment row's lock, which that notice takes too, orders the
      // two, and the confirmation wins — reopened, the next approval 재통보 would credit P for
      // a card the PG itself said is cancelled.
      const reopened = await this.db.transaction(async (tx) => {
        await tx
          .select({ id: schema.payments.id })
          .from(schema.payments)
          .where(eq(schema.payments.id, payment.id))
          .limit(1)
          .for('update');
        const confirmed = (await netCancelOutcome(tx, payment.id)) === 'cancelled';
        if (!confirmed) {
          await tx
            .update(schema.payments)
            // Pending again, so no reason yet: the credit or a failure writes its own.
            .set({ status: 'pending', resultMessage: null, updatedAt: new Date() })
            .where(
              and(eq(schema.payments.id, payment.id), eq(schema.payments.status, 'cancelled')),
            );
        }
        await recordPaymentEvent(tx, event);
        return !confirmed;
      });
      if (!reopened) {
        this.logger.error(
          `payment ${payment.id}: net cancel of ${tid} refused (${outcome.resultCode ?? 'no code'}), but the 재통보 already confirmed the card cancelled; left cancelled — check the card in the merchant admin`,
        );
        return this.walletUrl(payment.id, 'cancelled');
      }
      this.logger.error(
        `payment ${payment.id}: net cancel of ${tid} refused (${outcome.resultCode ?? 'no code'}); back to pending for the 재통보 — or check it in the merchant admin and settle it (POST /admin/payments/${payment.id}/settle)`,
      );
      return this.walletUrl(payment.id, 'pending');
    }
    if (outcome.status === 'unknown') {
      // The card may be cancelled already: the payment stays `cancelled`, so no approval
      // 재통보 can credit it (settleNotify), and the admin list flags it (`needsReview`).
      await recordPaymentEvent(this.db, event);
      this.logger.error(
        `payment ${payment.id}: net cancel of ${tid} got no clear answer (${outcome.resultCode ?? 'no code'}); left cancelled — check the card in the merchant admin, then settle it (POST /admin/payments/${payment.id}/settle: credit or cancelled)`,
      );
      return this.walletUrl(payment.id, 'pending');
    }
    await this.db.transaction(async (tx) => {
      await tx
        .update(schema.payments)
        // Why the payment ended, not the PG's "취소 성공": the payer and the admin list read it as the reason.
        .set({ resultMessage: NET_CANCEL_REASON, updatedAt: new Date() })
        .where(and(eq(schema.payments.id, payment.id), eq(schema.payments.status, 'cancelled')));
      await recordPaymentEvent(tx, event);
    });
    return this.walletUrl(payment.id, 'cancelled');
  }

  // --- StopUrl -------------------------------------------------------------------------

  /**
   * `GET|POST /payments/smartro/stop?m=<moid>`: the payer closed the window. Only a payment no
   * approval has claimed is closed (`failed`); one the ReturnUrl already took keeps going.
   */
  async handleStop(request: CallbackRequest): Promise<string> {
    let paymentId: string | null = null;
    try {
      const payment = await this.callbackPayment(request.moid ?? field(request.fields, 'Moid'));
      if (!payment) return this.walletUrl(null, 'failed');
      paymentId = payment.id;
      // The `stop` event only with the close: a stop of a payment already claimed or settled
      // changes nothing, and so stores nothing.
      const closed = await this.markFailed(
        payment.id,
        resultMessageOf(field(request.fields, 'ResultMsg')),
        'unclaimed',
        callbackEvent(payment.id, 'stop', request.fields),
      );
      return closed ? this.walletUrl(payment.id, 'stopped') : this.currentResult(payment.id);
    } catch (error) {
      this.logger.error(
        `StopUrl of payment ${paymentId ?? '(unknown)'} failed: ${describeFailure(error)}`,
      );
      return this.walletUrl(paymentId, 'pending');
    }
  }

  // --- 재통보 --------------------------------------------------------------------------

  /**
   * `POST /payments/smartro/notify`. `OK` (the only body SmartroPay stops re-sending on) once
   * the notice is handled or safely ignorable; a 403 for a sender that is not one of the mode's
   * SmartroPay servers, and a 400 for a notice whose SignValue does not verify (neither is from
   * SmartroPay); a 5xx when our side failed, so it comes again.
   *
   * `ip` is the sender (`request.ip`). The SignValue covers only Tid and ResultCode — not Moid,
   * Amt or StateCd — so the address is checked first, and a credit also needs the payment to have
   * been claimed by our ReturnUrl (settleNotify).
   */
  async handleNotify(fields: CallbackFields, ip: string | undefined): Promise<string> {
    const smartro = this.config.smartro;
    if (!smartro) throw new AppError('NOT_FOUND', { message: 'SmartroPay is not configured' });
    if (smartro.notifyIps !== null && !isAllowedNotifyAddress(ip, smartro.notifyIps)) {
      // An address is not personal data here: whoever posts a notice is a server, or someone
      // forging one.
      this.logger.error(`재통보 refused: ${ip ?? 'no address'} is not a SmartroPay server`);
      // Verbatim on this @RawResponse() route, and without "OK" in it.
      throw new HttpException('FORBIDDEN', HttpStatus.FORBIDDEN);
    }
    // 신통보 names first; the 구통보 names (TID, OID, MID) in case the merchant admin sends those.
    const tid = field(fields, 'Tid', 'TID');
    const resultCode = field(fields, 'ResultCode');
    const sign = field(fields, 'SignValue');
    if (
      tid === undefined ||
      resultCode === undefined ||
      sign === undefined ||
      !verifySignValue(sign, tid, resultCode, smartro.merchantKey)
    ) {
      this.logger.warn(`재통보 refused: its SignValue does not verify (Tid ${tid ?? 'none'})`);
      // Verbatim on this @RawResponse() route, and without "OK" in it.
      throw new HttpException('SIGNATURE MISMATCH', HttpStatus.BAD_REQUEST);
    }
    try {
      return await this.settleNotify(smartro, fields, tid, resultCode);
    } catch (error) {
      // A fresh error, not the original as its cause: ApiExceptionFilter logs a 5xx with its
      // cause chain, and a driver error carries the statement's parameters.
      throw new AppError('INTERNAL', {
        message: `재통보 for Tid ${tid} failed: ${describeFailure(error)}`,
      });
    }
  }

  private async settleNotify(
    smartro: SmartroConfig,
    fields: CallbackFields,
    tid: string,
    resultCode: string,
  ): Promise<string> {
    const payment = await this.callbackPayment(field(fields, 'Moid', 'OID'));
    if (!payment) {
      this.logger.warn(`재통보 for a Moid that is not ours (Tid ${tid}); acknowledged`);
      return NOTIFY_OK;
    }
    // Every notice, settled or not: its SignValue verified, so it is SmartroPay's own.
    await recordPaymentEvent(this.db, callbackEvent(payment.id, 'notify', fields));
    const state = field(fields, 'StateCd');

    if (state === '0' && isApprovalSuccess(resultCode)) {
      // Net-cancelled (or being net-cancelled): what the net cancel came to decides.
      if (payment.status === 'cancelled') return this.noticeForCancelled(payment.id, tid);
      // Already settled — credited, refunded — the notice changes nothing.
      if (payment.status !== 'pending' && payment.status !== 'failed') {
        // Every credit stores its approval's Tid, and a payment has one approval: a credited
        // one whose approval notice names another Tid holds a wrong one — a settle credit given
        // a Tid other than the approval's — and a refund would cancel that, not this card.
        // Or the Moid had a second approval, made through another payment's ReturnUrl (netCancel):
        // a window of it authenticated and posted there — a charge with no P, which that payment
        // is flagged for.
        if (
          (payment.status === 'succeeded' || payment.status === 'refunding') &&
          payment.providerRef !== null &&
          payment.providerRef !== tid
        ) {
          const made = await this.madeThrough(tid, payment.id);
          const reading = made
            ? `payment ${made.id} ${made.holds ? 'holds' : 'recorded'} ${tid}: its ReturnUrl made it, approving a window of this payment's posted there — a second charge under this Moid (Amt ${field(fields, 'Amt') ?? 'not given'}), with no P, which the admin list flags on ${made.id} while no other SmartroPay payment holds ${tid}: settle it there (cancel ${tid} in the merchant admin and settle ${made.id} cancelled, or honour it), not here`
            : `either a settle's tid (payment_settle) is not the approval's — then a refund cancels ${payment.providerRef}, not ${tid} — or this Moid had a second approval made elsewhere (a window of it posted to another payment's ReturnUrl: look in the admin list for a payment whose reason names this Moid and ${tid}, and settle that one), and ${tid} is charged with no P: check both in the merchant admin`;
          this.logger.error(
            `재통보 approval ${tid} for payment ${payment.id}, which is ${payment.status} under ${payment.providerRef}: the approval Tid on record differs — ${reading}. Nothing changed`,
          );
        }
        return NOTIFY_OK;
      }
      // Never claimed by our ReturnUrl, so never approved through its own: under 인증/승인 분리
      // the PG approves only when WE call urlCallApproval, and that call always follows a
      // committed claim (`provider_ref` set). An approval notice for an unclaimed payment is
      // forged — or for an approval our call made through ANOTHER payment's ReturnUrl, which
      // the admin list flags on that payment (netCancel). Either way no re-send changes
      // anything, so it is acknowledged. Its `notify` event above is the record.
      if (payment.providerRef === null) {
        const made = await this.madeThrough(tid, payment.id);
        this.logger.error(
          `재통보 approval ${tid} for payment ${payment.id}, which no ReturnUrl claimed; not credited — ${made ? this.madeThroughAdvice(made, payment, tid, parseKrw(field(fields, 'Amt'))) : "check it by hand (if another payment's ReturnUrl made it, the admin list flags that payment, whose reason names this payment's Moid)"}`,
        );
        return NOTIFY_OK;
      }
      // Its claim spent on another payment's window (crossPostedApprovalOf): this approval of its
      // Moid was made elsewhere. Judged again under the credit's lock (approvalNoticeHold), for a
      // claim spent while this notice was on its way.
      const spent = await crossPostedApprovalOf(this.db, payment);
      if (spent) {
        await this.logSpentClaimNotice(payment, tid, spent);
        return NOTIFY_OK;
      }
      const mid = field(fields, 'Mid', 'MID');
      if (mid !== smartro.mid || parseKrw(field(fields, 'Amt')) !== payment.priceKrw) {
        this.logger.error(
          `재통보 approval ${tid} does not match payment ${payment.id} (${mid === smartro.mid ? 'Amt' : 'Mid'}); not credited — check the card in the merchant admin, cancel it there, then settle this payment cancelled (POST /admin/payments/${payment.id}/settle; a settle credit is refused: approval_mismatch)`,
        );
        return NOTIFY_OK;
      }
      // `failed` too (a claimed one): the PG's approval is authoritative over a failure recorded
      // on our side (an admin who settled it failed, the merchant admin not showing it yet).
      // Unless a cancel 재통보 of the card is on record, or its claim went to another payment's
      // window (approvalNoticeHold).
      const { held, holdBack } = approvalNoticeHold();
      let credit: CreditOutcome;
      try {
        credit = await this.wallet.creditPayment({
          paymentId: payment.id,
          userId: payment.userId,
          amountP: payment.amountP,
          from: ['pending', 'failed'],
          providerRef: tid,
          method: field(fields, 'PayMethod')?.slice(0, METHOD_MAX) ?? null,
          resultMessage: resultMessageOf(field(fields, 'ResultMsg')),
          holdBack,
        });
      } catch (error) {
        if (!isPgError(error, PG_UNIQUE_VIOLATION, PROVIDER_REF_UNIQUE)) throw error;
        // The Tid is already another payment's reference: crediting it here would count one
        // PG transaction twice. No re-send can change that, so OK rather than a 5xx the PG
        // would repeat until its retries run out. That payment's ReturnUrl may have made it — a
        // window of this one posted there (netCancel) — and then it is settled there, while this
        // payment's own approval is another, still to be checked.
        const made = await this.madeThrough(tid, payment.id);
        const own = paymentIdToMoid(payment.id);
        const holder = made?.holds ? made.id : 'that payment';
        const settleThis = `check both in the merchant admin, then settle this one cancelled or failed (POST /admin/payments/${payment.id}/settle; a settle credit is refused: approval_mismatch)`;
        const reading =
          made?.holds && made.moid === own
            ? `${holder}'s approval answered ${tid} naming this payment's Moid: its ReturnUrl made it, approving a window of this payment's posted there (the admin list flags ${holder}, and its reason names it) — settle ${holder}, not this one, and check this payment's own approval separately in the merchant admin`
            : `if ${holder}'s ReturnUrl made it (a window of this payment's posted there: its reason names this Moid, or no answer reached it), settle ${holder}, not this one, and check this payment's own approval separately; otherwise ${settleThis}`;
        this.logger.error(
          `재통보 approval ${tid} for payment ${payment.id} is already recorded on another payment${made?.holds ? ` (${made.id})` : ''}; not credited — ${reading}`,
        );
        return NOTIFY_OK;
      }
      if (credit.credited) {
        this.logger.log(`payment ${payment.id} credited by the 재통보 (${tid})`);
      } else if (credit.heldBack && held.by === 'cross-post' && held.crossPost) {
        await this.logSpentClaimNotice(payment, tid, held.crossPost);
      } else if (credit.heldBack && held.by === 'full') {
        // That notice is recorded before it is judged (under this same lock), so its judgement
        // normally follows and closes the payment. It may also have run already and closed
        // nothing — judged against the Tid a net cancel had reserved the payment with, say —
        // leaving the payment as it is: pending or failed and claimed, which needsReview flags.
        this.logger.warn(
          `재통보 approval ${tid} for payment ${payment.id}, which is ${String(credit.status)}: a full cancel 재통보 of the card is on record; not credited — that notice closes it cancelled unless it already ran and did not; if it stays ${String(credit.status)}, check the card in the merchant admin and settle it (POST /admin/payments/${payment.id}/settle)`,
        );
      } else if (credit.heldBack) {
        this.logger.error(
          `재통보 approval ${tid} for payment ${payment.id}, which is ${String(credit.status)}: a partial cancel 재통보 of the card is on record; not credited — check the card in the merchant admin, settle it cancelled (POST /admin/payments/${payment.id}/settle; a settle credit is refused: partial_cancel), then adjust the balance by hand (POST /admin/users/:id/balance-adjust)`,
        );
      } else if (credit.status === 'cancelled') {
        // A net cancel reserved the payment between our read and the credit: the same rule as
        // for a payment found `cancelled` above, on the status as it is now.
        return this.noticeForCancelled(payment.id, tid);
      } else if (credit.status === 'succeeded') {
        // The ReturnUrl credited it between our read and the credit.
        await this.creditedUnderAnotherTid(payment, tid, '재통보 approval');
      }
      return NOTIFY_OK;
    }

    if (state === '1' || state === '2') {
      return this.settleCancelNotice(payment, fields, { tid, resultCode, state });
    }
    return NOTIFY_OK;
  }

  /**
   * A cancel 재통보 (StateCd 1 전취소, 2 후취소), judged on the payment as locked — the lock a
   * net cancel's refusal takes too, so of the two exactly one decides. It moves no balance.
   *
   * It is the PG's word that the card was cancelled only when cancelNoticeKind reads it as a
   * FULL cancel: a ResultCode that says cancelled for the payment's method, and neither an Otid
   * nor an Amt of another transaction. A cancel that failed is recorded (the `notify` event) and
   * moves nothing; so is a PARTIAL cancel (made in the merchant admin — this service never makes
   * one), which a person reconciles. A full one, when it cancelled the payment's approval
   * (cancelsApprovalOf), by the status then:
   * - `refunding`: `refunded`. The P was clawed back when the refund began.
   * - `cancelled` with no confirmed net cancel: confirmed (`net_cancel` {outcome:'cancelled',
   *   notice:true}), so its approval 재통보 stays a no-op and the admin list stops flagging it.
   *   One confirmed already (a net cancel, an earlier notice, a settle): nothing more.
   * - `pending` or `failed` that our ReturnUrl claimed: `cancelled`, confirmed the same way — the
   *   approval's answer was lost and the card was cancelled in the merchant admin — so no
   *   approval 재통보 re-sent afterwards can credit P for a cancelled card (it credits `failed`
   *   too). An unclaimed one was never approved (see the approval branch): recorded only. So is
   *   a `failed` one whose claim approved another payment's window (crossPostedApprovalOf, a
   *   partial cancel too): no approval of its Moid is its own, and closed, it would no longer be
   *   flagged for the charge it holds.
   * - `succeeded`: cancelled outside this service; nothing moves, and this shouts. An admin
   *   refund of it then finishes on this notice (hasCancelNotice), whatever its cancel hears.
   */
  private async settleCancelNotice(
    payment: PaymentRow,
    fields: CallbackFields,
    notice: { tid: string; resultCode: string; state: string },
  ): Promise<string> {
    const { tid, resultCode, state } = notice;
    const cancel: CancelNotice = {
      stateCd: state,
      resultCode,
      payMethod: field(fields, 'PayMethod'),
      tid,
      otid: field(fields, 'Otid', 'OTID'),
      amt: field(fields, 'Amt'),
    };
    const confirmation: PaymentEventInput = {
      paymentId: payment.id,
      type: 'net_cancel',
      resultCode,
      resultMessage: field(fields, 'ResultMsg'),
      payload: { outcome: 'cancelled', notice: true },
    };
    const judged = await this.db.transaction(async (tx): Promise<JudgedCancelNotice> => {
      const [locked] = await tx
        .select()
        .from(schema.payments)
        .where(eq(schema.payments.id, payment.id))
        .limit(1)
        .for('update');
      if (!locked) return { verdict: 'settled', amount: payment.priceKrw };
      // Against the approval's amount: a net-cancelled payment's approval may have been for
      // another amount than its price (that is why it was net-cancelled — also when the PG
      // refused that cancel and the payment is `pending` again), and a full cancel of it
      // carries that amount.
      const amount = await approvedAmountOf(tx, locked);
      const crossPost = await crossPostedApprovalOf(tx, locked);
      const verdict = await this.cancelNoticeVerdict(
        tx,
        locked,
        cancel,
        { amount, crossPost },
        confirmation,
      );
      return { verdict, status: locked.status, providerRef: locked.providerRef, amount, crossPost };
    });
    const { verdict, amount } = judged;

    const where = `재통보 StateCd ${state}, ${tid}`;
    switch (verdict) {
      case 'no-cancel':
        this.logger.warn(
          `재통보 StateCd ${state} for payment ${payment.id} (${tid}) answers ${resultCode}, which is no cancel; recorded, nothing changed`,
        );
        break;
      case 'refunded':
        this.logger.log(`refund of payment ${payment.id} confirmed by the 재통보`);
        break;
      case 'confirmed':
        this.logger.log(`net cancel of payment ${payment.id} confirmed by the 재통보`);
        break;
      case 'cancelled':
        this.logger.warn(
          `payment ${payment.id} was cancelled at the PG before it was credited (${where}); now cancelled, nothing credited`,
        );
        break;
      case 'external':
        // Cancelled outside this service (the merchant admin). Whether to claw the P back is an
        // open owner question (ADR-0042), so nothing moves: the event is recorded and this shouts.
        this.logger.error(
          `payment ${payment.id} was cancelled at the PG (${where}) but its P was not clawed back; refund it in the admin payments list (the refund finishes on this notice whatever the PG answers its cancel) or decide the claw-back by hand`,
        );
        break;
      case 'partial':
        // Only ever made by hand in the merchant admin: full cancels are all this service does
        // (owner decision 5), so no state here describes a card that is partly cancelled.
        this.logger.error(
          `payment ${payment.id}: the PG reports a partial cancel (${where}, Otid ${cancel.otid ?? 'none'}, Amt ${cancel.amt ?? 'none'} of ${String(amount)}); nothing changed — this service cancels in full only: check the card in the merchant admin and reconcile the payment and its P by hand: ${partialCancelFix(payment.id, judged)}`,
        );
        break;
      case 'unclaimed':
        this.logger.warn(
          `cancel 재통보 for payment ${payment.id}, which no ReturnUrl claimed (${where}); recorded, nothing changed`,
        );
        break;
      case 'other-approval':
        this.otherApprovalCancelled(payment.id, judged, where);
        break;
      case 'cross-post': {
        const spent = judged.crossPost;
        const made = await this.madeThrough(cancel.otid ?? tid, payment.id);
        this.logger.error(
          `cancel 재통보 for payment ${payment.id} (${where}), whose one approval approved another payment's window (${spent?.tid ?? 'its claim'} of Moid ${spent?.moid ?? 'unknown'}): it cancels no approval of this payment's own but one of its Moid made elsewhere — ${made ? `through payment ${made.id}'s ReturnUrl, which the admin list flags for it: settle that one (cancelled)` : "through another payment's ReturnUrl (look in the admin list for one whose reason names this Moid) or by the payer's own call"}; recorded, nothing changed — this does not cancel ${spent?.tid ?? 'its approval'}, which ${payment.id} answers for (the admin list flags it until a settle checks it)`,
        );
        break;
      }
      case 'settled':
        break;
    }
    return NOTIFY_OK;
  }

  /**
   * settleCancelNotice's decision on the payment as locked (`amount`: approvedAmountOf;
   * `crossPost`: crossPostedApprovalOf).
   */
  private async cancelNoticeVerdict(
    tx: Tx,
    locked: PaymentRow,
    cancel: CancelNotice,
    approval: { amount: number; crossPost: CrossPostedApproval | undefined },
    confirmation: PaymentEventInput,
  ): Promise<CancelNoticeVerdict | 'no-cancel'> {
    const kind = cancelNoticeKind(cancel, { method: locked.method, priceKrw: approval.amount });
    if (kind === 'none') return 'no-cancel';
    // Its claim approved another payment's window: whatever this cancels, it is not an approval
    // of this payment's own (crossPostedApprovalOf).
    if (approval.crossPost) return 'cross-post';
    if (kind === 'partial') return 'partial';
    const at = await clockTimestamp(tx);
    const ours = cancelsApprovalOf(locked, cancel.tid);
    switch (locked.status) {
      case 'refunding':
        if (!ours) return 'other-approval';
        return (await markRefunded(tx, locked.id, at)) ? 'refunded' : 'settled';
      case 'cancelled':
        // Before the naming check: a notice re-sent for a payment a notice or a settle
        // closed (its `provider_ref` the authentication's Tid) has nothing left to do.
        if ((await netCancelOutcome(tx, locked.id)) === 'cancelled') return 'settled';
        if (!ours) return 'other-approval';
        await recordPaymentEvent(tx, confirmation);
        return 'confirmed';
      case 'pending':
      case 'failed': {
        if (!ours) return 'unclaimed';
        const rows = await tx
          .update(schema.payments)
          .set({ status: 'cancelled', resultMessage: NOTICE_CANCEL_REASON, updatedAt: at })
          .where(
            and(
              eq(schema.payments.id, locked.id),
              inArray(schema.payments.status, ['pending', 'failed']),
              isNotNull(schema.payments.providerRef),
            ),
          )
          .returning({ id: schema.payments.id });
        if (rows.length === 0) return 'settled';
        await recordPaymentEvent(tx, confirmation);
        return 'cancelled';
      }
      case 'succeeded':
        return ours ? 'external' : 'other-approval';
      default:
        return 'settled';
    }
  }

  /**
   * A full cancel 재통보 that names another Tid than the payment's `provider_ref`. A payment has
   * one approval, and every credit stores that approval's Tid — so on a credited payment
   * (`succeeded`, `refunding`) this is the mark of a Tid on record that is not the approval's (a
   * settle credit given the wrong `tid`): the card may be cancelled while its P stays, or the
   * refund cancels a Tid the PG does not know. That shouts; a `cancelled` one only warns (a net
   * cancel stores the approval's own Tid from its answer).
   */
  private otherApprovalCancelled(paymentId: string, judged: JudgedCancelNotice, where: string) {
    const ref = String(judged.providerRef ?? null);
    const head = `cancel 재통보 for payment ${paymentId} names another approval than ${ref} (${where}); recorded, nothing changed`;
    switch (judged.status) {
      case 'succeeded':
        this.logger.error(
          `${head} — the payment is succeeded under ${ref}: if the merchant admin shows its card cancelled, the Tid on record is not its approval's (check the settle's tid), its P was not clawed back and a refund would cancel ${ref}: correct the balance by hand (POST /admin/users/:id/balance-adjust)`,
        );
        return;
      case 'refunding':
        this.logger.error(
          `${head} — the payment is refunding, its cancel asked of ${ref}: if the merchant admin shows its card cancelled, the Tid on record is not its approval's (check the settle's tid): settle it refunded (POST /admin/payments/${paymentId}/settle)`,
        );
        return;
      default:
        this.logger.warn(head);
    }
  }

  /**
   * An approval 재통보 for a payment that is `cancelled`: what its net cancel came to decides
   * (netCancelOutcome — a confirmed one, else the latest).
   * - none yet: the cancel is in flight (reserved, the PG not answered) or its process died —
   *   a 5xx, so SmartroPay sends the notice again (an admin settles one that stays that way);
   * - `cancelled`: the card was cancelled, and the notice changes nothing;
   * - `unknown`: the card may be cancelled, so it is not credited either — acknowledged, and
   *   left to an admin (the admin list flags it);
   * - `refused` with the payment still `cancelled`: a newer cancel is in flight — a 5xx.
   */
  private async noticeForCancelled(paymentId: string, tid: string): Promise<string> {
    const outcome = await netCancelOutcome(this.db, paymentId);
    if (outcome === 'cancelled') return NOTIFY_OK;
    if (outcome === 'unknown') {
      this.logger.error(
        `재통보 approval ${tid} for payment ${paymentId}, whose net cancel got no clear answer; not credited — check the card in the merchant admin and settle it (POST /admin/payments/${paymentId}/settle: credit or cancelled)`,
      );
      return NOTIFY_OK;
    }
    throw new Error(`net cancel of payment ${paymentId} in flight`);
  }

  // --- shared --------------------------------------------------------------------------

  /** The SmartroPay payment a Moid names, or undefined (not a Moid we issue, or not ours). */
  private async callbackPayment(moid: string | undefined): Promise<PaymentRow | undefined> {
    const paymentId = moid === undefined ? null : moidToPaymentId(moid);
    if (paymentId === null) return undefined;
    const [row] = await this.db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.id, paymentId))
      .limit(1);
    return row?.provider === 'smartro' ? row : undefined;
  }

  /**
   * The payment an approval belongs to when it is not `paymentId`: another SmartroPay payment
   * whose reference `tid` already is (`holdsTid`), else another payment `moid` names (netCancel).
   */
  private async otherPaymentOf(
    paymentId: string,
    moid: string | undefined,
    tid: string,
  ): Promise<OtherPayment | undefined> {
    const namedId = moid === undefined ? null : moidToPaymentId(moid);
    // At most two rows: the unique index lets one payment hold the Tid, and a Moid names one.
    const rows = await this.db
      .select({
        id: schema.payments.id,
        userId: schema.payments.userId,
        provider: schema.payments.provider,
        status: schema.payments.status,
        providerRef: schema.payments.providerRef,
      })
      .from(schema.payments)
      .where(
        and(
          ne(schema.payments.id, paymentId),
          or(
            namedId === null ? undefined : eq(schema.payments.id, namedId),
            and(eq(schema.payments.provider, 'smartro'), eq(schema.payments.providerRef, tid)),
          ),
        ),
      )
      .limit(2);
    const holder = rows.find((row) => row.provider === 'smartro' && row.providerRef === tid);
    if (holder) return { ...holder, holdsTid: true };
    const [named] = rows;
    return named && { ...named, holdsTid: false };
  }

  /**
   * netCancel's payment an approval only NAMES: closed `failed` while it is a `pending`
   * SmartroPay payment of the payer's own account that no ReturnUrl claimed — no reason, no
   * event; the error log is the link to the payment that made the approval. Another account's
   * is left as it is: a payer can type any Moid into a window of their own (EncryptData does
   * not cover it), and the close would end its owner's open window. Otherwise, or when that
   * close lost the race to its own claim, it is read again for the log's advice
   * (crossPostAdvice) — with, claimed and `failed`, whether its own claim approved yet another
   * payment's window (crossPostedApprovalOf), and, `cancelled`, whether its own net cancel is
   * confirmed. Never throws: the request's own answer does not wait on this; what it cannot
   * read picks the more careful advice.
   */
  private async closeNamedPayment(owner: OtherPayment, userId: string): Promise<NamedPayment> {
    const nothingOpen = { spent: false, unconfirmed: false };
    if (owner.provider !== 'smartro') {
      const { status, providerRef } = owner;
      return { state: `${owner.provider}, ${status}`, status, providerRef, ...nothingOpen };
    }
    const sameAccount = owner.userId === userId;
    let trouble = '';
    if (owner.status === 'pending' && owner.providerRef === null && sameAccount) {
      try {
        if (await this.markFailed(owner.id, null, 'unclaimed')) {
          const state = 'unclaimed, now failed';
          return { state, status: 'failed', providerRef: null, ...nothingOpen };
        }
      } catch (error) {
        trouble = `; closing it failed: ${describeFailure(error)}`;
      }
    }
    let { status, providerRef } = owner;
    try {
      const [row] = await this.db
        .select({ status: schema.payments.status, providerRef: schema.payments.providerRef })
        .from(schema.payments)
        .where(eq(schema.payments.id, owner.id))
        .limit(1);
      if (row) ({ status, providerRef } = row);
    } catch (error) {
      trouble += `; reading it again failed: ${describeFailure(error)}`;
    }
    let spent = false;
    let unconfirmed = false;
    let detail = '';
    try {
      if (status === 'failed' && providerRef !== null) {
        const crossPost = await crossPostedApprovalOf(this.db, {
          id: owner.id,
          status,
          providerRef,
        });
        spent = crossPost !== undefined;
        if (crossPost)
          detail = `, its own claim spent on ${crossPost.tid} of Moid ${crossPost.moid}`;
      } else if (status === 'cancelled') {
        unconfirmed = (await netCancelOutcome(this.db, owner.id)) !== 'cancelled';
        detail = unconfirmed ? ', its net cancel unconfirmed' : ', its net cancel confirmed';
      }
    } catch (error) {
      // Unread: a cancelled one is taken as open to a settle (settle it first), a claimed failed
      // one as able to take the approval (settle it first, never honour).
      unconfirmed = status === 'cancelled';
      trouble += `; reading its approvals failed: ${describeFailure(error)}`;
    }
    const claim = providerRef === null ? 'unclaimed' : `claimed: ${providerRef}`;
    const account = sameAccount ? '' : ", another account's";
    const state = `${status}, ${claim}${detail}${account}${trouble}`;
    return { state, status, providerRef, spent, unconfirmed };
  }

  /**
   * netCancel's error log for an approval that only NAMES another payment: where the merchant
   * admin files it and what it charged, and what an admin may do about it by how the named
   * payment stands — the flag on this payment (`needsReview`) is the reminder, this is the how.
   * - Another provider's payment, a SmartroPay one closed unclaimed (a claim needs `pending`),
   *   or a claimed `failed` one whose own claim approved yet another payment's window (`spent`:
   *   its approval 재통보 is not credited, a cancel 재통보 does not close it): nothing of ours
   *   credits the approval, and a cancel 재통보 of it changes nothing (callbackPayment finds no
   *   other provider's payment, and the others only record it) — cancel it, or honour it on the
   *   same account.
   * - A `cancelled` one whose own net cancel is unconfirmed: open to a settle, whose credit takes
   *   its own approval only (approvalsOnRecord passes over a 재통보 of this one) — settle it
   *   first, then cancel or honour.
   * - Anything else may yet take it: a `pending` one's or a claimed `failed` one's approval
   *   재통보 credits it with that Tid (which ends this payment's flag), and while it is claimed
   *   and `pending` or `failed` a cancel 재통보 of the Tid is matched to it by Moid alone
   *   (A-PG-22) — also one recorded before its own window claimed it (recordedCancelNotices) —
   *   and holds back or closes its own payment; a settled one only records it
   *   (cancelsApprovalOf wants its own Tid). So the advice is by how it stands when an admin
   *   acts, and only while this payment is flagged: wait while it is `pending`; a claimed
   *   `failed` one is settled first — checked in the merchant admin, whether or not the list
   *   flags it yet (it does 2 minutes after its last change: its own approval's failure may be
   *   younger) — then only a cancel, never an honour the 재통보 could double; for one settled,
   *   or closed unclaimed meanwhile, a cancel or an honour.
   * Never an honour on another account: whose card it was, a payer typing another account's
   * Moid into their own window, is not this account's to be paid. An honour is the P the
   * approval's Amt buys: the other payment's price, or this one's for a Moid typed into this
   * payment's own window. `meanwhile`: this payment's status when it could not fail — settled
   * meanwhile by a 재통보 of its own Moid — so nothing flags the approval.
   */
  private crossPostAdvice(
    payment: PaymentRow,
    owner: OtherPayment,
    named: NamedPayment,
    tid: string,
    amount: number | null,
    meanwhile: string | undefined,
  ): string {
    const b = payment.id;
    const a = owner.id;
    const names = `payment ${b}: approval ${tid} names payment ${a} (${named.state}), which does not hold it; not cancelled`;
    const filed = `The merchant admin files it under Moid ${paymentIdToMoid(a)}, not ${b}'s (its reason says so), charged ${chargedText(amount)}`;
    if (meanwhile !== undefined) {
      return `${names} — but ${b} was ${meanwhile} before it could fail (a 재통보 of its own Moid settled it meanwhile), so nothing flags ${tid}: it is charged with no P. ${filed}: check both approvals of that Moid there, and once ${a} is settled, cancel ${tid} there or honour it by hand`;
    }
    const head = `${names}, this payment fails and the admin list flags it while no SmartroPay payment holds ${tid}. ${filed}`;
    const cancelIt = `cancel ${tid} there and settle ${b} cancelled (POST /admin/payments/${b}/settle; a settle credit is refused: approval_mismatch)`;
    const honour =
      owner.userId === payment.userId
        ? ` — or, to honour it, adjust the balance of that account by hand (POST /admin/users/${payment.userId}/balance-adjust) by the P a charge of ${chargedText(amount)} buys, and settle ${b} failed`
        : ` — ${a} is another account's, so it is never honoured on that account`;
    if (
      owner.provider !== 'smartro' ||
      (named.providerRef === null && named.status !== 'pending') ||
      named.spent
    ) {
      const spent = named.spent
        ? ` (${a}'s own claim approved yet another payment's window, so no 재통보 of its Moid credits or closes it)`
        : '';
      return `${head}. No flow of ours credits it${spent} — the card is charged with no P: ${cancelIt}${honour}`;
    }
    if (named.status === 'cancelled' && named.unconfirmed) {
      return `${head}. ${a} is cancelled with its own net cancel unconfirmed (the admin list flags it), and a settle of it may still credit it: settle ${a} first (check its own approval in the merchant admin) — then ${cancelIt}${honour} (a 재통보 of ${tid} changes nothing on ${a}, whatever it logs there)`;
    }
    return `${head}. While ${a} is pending, or claimed and failed, its approval 재통보 may yet credit ${a} with ${tid} (that ends the flag), and while ${a} is claimed and pending or failed a cancel 재통보 of ${tid} is matched to it by Moid alone (A-PG-22) — also one recorded before its own window claims it — and holds back or closes ${a} whatever its own approval did. So act only while ${b} is flagged, by how ${a} stands then (check both approvals of that Moid in the merchant admin): pending — wait; claimed and failed — settle ${a} first, whether or not the admin list flags it yet (it does 2 minutes after its last change, and its own approval may be charged: check it in the merchant admin), and only then ${cancelIt}, and never honour it by hand, which the 재통보 may still double; cancelled with its own net cancel unconfirmed — settle ${a} first, then ${cancelIt}${honour}; unclaimed and failed, succeeded, refunding, refunded or cancelled and confirmed — ${cancelIt}${honour} (a cancel 재통보 of ${tid} changes nothing on such a ${a}, whatever it logs there)`;
  }

  /**
   * Another SmartroPay payment whose own ReturnUrl made approval `tid` (a window of `exceptId`'s
   * posted there, netCancel), for a log to name: one that holds `tid` as its claim, else one
   * whose approval call's answer (or the inquiry's) recorded it as a success — with the Moid that
   * answer named (none when no answer reached it). Undefined when there is none, and when reading
   * fails: a log line is all it is for, and it then gives the reading without the name.
   */
  private async madeThrough(tid: string, exceptId: string): Promise<MadeThrough | undefined> {
    const payload = schema.paymentEvents.payload;
    const answered = and(
      inArray(schema.paymentEvents.type, ['approval', 'approval_inquiry']),
      inArray(schema.paymentEvents.resultCode, [...APPROVAL_SUCCESS_CODES]),
    );
    try {
      const [holder] = await this.db
        .select({ id: schema.payments.id, userId: schema.payments.userId })
        .from(schema.payments)
        .where(
          and(
            eq(schema.payments.provider, 'smartro'),
            eq(schema.payments.providerRef, tid),
            ne(schema.payments.id, exceptId),
          ),
        )
        .limit(1);
      if (holder) {
        // Its answer for `tid`; one that named no Tid was for the claim's.
        const [answer] = await this.db
          .select({ moid: sql<string | null>`${payload}->>'Moid'` })
          .from(schema.paymentEvents)
          .where(
            and(
              eq(schema.paymentEvents.paymentId, holder.id),
              answered,
              sql`coalesce(${payload}->>'Tid', ${tid}) = ${tid}`,
            ),
          )
          .orderBy(asc(schema.paymentEvents.id))
          .limit(1);
        return { ...holder, holds: true, moid: answer?.moid ?? undefined };
      }
      const [answer] = await this.db
        .select({
          id: schema.payments.id,
          userId: schema.payments.userId,
          moid: sql<string | null>`${payload}->>'Moid'`,
        })
        .from(schema.paymentEvents)
        .innerJoin(schema.payments, eq(schema.payments.id, schema.paymentEvents.paymentId))
        .where(
          and(
            ne(schema.paymentEvents.paymentId, exceptId),
            eq(schema.payments.provider, 'smartro'),
            answered,
            sql`${payload}->>'Tid' = ${tid}`,
          ),
        )
        .orderBy(asc(schema.paymentEvents.id))
        .limit(1);
      if (!answer) return undefined;
      const { moid, ...made } = answer;
      return { ...made, holds: false, moid: moid ?? undefined };
    } catch {
      return undefined;
    }
  }

  /**
   * What to do about an approval 재통보 for a payment no ReturnUrl claimed that another payment's
   * ReturnUrl made (`made`, madeThrough): a window of this payment's posted there. That payment
   * holds the claim — and, answered, the reason naming this Moid — so the charge is settled
   * through it: cancelled, or honoured on the same account. Never a credit of it (this charge is
   * this payment's Moid's — a credit with a typed tid would pay it to that payment), nor a
   * `failed` settle alone (the card stays charged with no P).
   */
  private madeThroughAdvice(
    made: MadeThrough,
    payment: PaymentRow,
    tid: string,
    amount: number | null,
  ): string {
    const honour =
      made.userId === payment.userId
        ? ` — or honour it by hand on that account (POST /admin/users/${payment.userId}/balance-adjust: the P a charge of ${chargedText(amount)} buys) and settle ${made.id} failed`
        : '';
    const reason =
      made.moid === undefined
        ? `no answer reached it, so its reason does not name ${tid}`
        : 'its reason names it';
    return `payment ${made.id} ${made.holds ? 'holds it as its claim' : 'recorded it as its approval'}: its ReturnUrl made this approval, of a window of this payment's posted there (${reason}), and the admin list flags ${made.id} while it stays unsettled — settle that one, not this: cancel ${tid} in the merchant admin (under this payment's Moid) and settle ${made.id} cancelled${honour}; never settle ${made.id} credit (the charge is this Moid's) or failed alone (the card stays charged with no P)`;
  }

  /**
   * An approval 재통보 of a payment whose one approval approved another payment's window
   * (`spent`, crossPostedApprovalOf): not credited, for no approval of its Moid is its own. It
   * was made through yet another payment's ReturnUrl (madeThrough), which the admin list flags
   * for it, or by the payer's own call. Credited, it would end this payment's flag while `spent`
   * is charged with no P. Whether the admin list flags THIS payment for it is said too:
   * needsReview's third hint skips a 재통보 of an approval another payment's own call made
   * (approvalsMadeElsewhere) and counts any other — also after a settle checked this payment for
   * `spent`, when the flag is back under a reason that still names `spent`: the log is where the
   * admin finds the Tid it is for.
   */
  private async logSpentClaimNotice(
    payment: PaymentRow,
    tid: string,
    spent: CrossPostedApproval,
  ): Promise<void> {
    const made = await this.madeThrough(tid, payment.id);
    const where = made
      ? `through payment ${made.id}'s ReturnUrl, which the admin list flags for it: settle it there`
      : "through another payment's ReturnUrl (look in the admin list for one whose reason names this payment's Moid and this Tid) or by the payer's own call";
    let flag: string;
    try {
      flag = (await approvalsMadeElsewhere(this.db, payment.id, [tid])).has(tid)
        ? `The admin list does not flag ${payment.id} for ${tid}`
        : `The admin list flags ${payment.id} for ${tid} — also when a settle checked ${payment.id} already: that flag is for ${tid}, filed under this payment's Moid in the merchant admin, not for ${spent.tid}, which its reason names (never settle ${spent.tid} a second time); once ${tid} is cancelled there, settled where it was made or honoured by hand, settle ${payment.id} failed`;
    } catch (error) {
      flag = `Whether the admin list flags ${payment.id} for ${tid} could not be read (${describeFailure(error)}): if it is flagged again after a settle, the flag is for ${tid}, not for ${spent.tid}`;
    }
    this.logger.error(
      `재통보 approval ${tid} for payment ${payment.id}, whose one approval approved another payment's window (${spent.tid} of Moid ${spent.moid}, which the admin list flags it for until a settle checks it); not credited — no approval of its own Moid is its own: this one was made ${where}. Credited here, it would end ${payment.id}'s flag while ${spent.tid} is charged with no P. ${flag}`,
    );
  }

  /**
   * `pending` → `failed`, with `event` recorded in the same transaction when given — and only
   * when the row did change. `unclaimed`: only while no approval holds it (the window came back
   * empty, a stop, or its authentication was approved through another payment's ReturnUrl —
   * netCancel). `claimed`: the approval this request made was refused, or is another payment's.
   */
  private async markFailed(
    paymentId: string,
    resultMessage: string | null,
    which: 'unclaimed' | 'claimed',
    event?: PaymentEventInput,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .update(schema.payments)
        .set({ status: 'failed', resultMessage, updatedAt: new Date() })
        .where(
          and(
            eq(schema.payments.id, paymentId),
            eq(schema.payments.status, 'pending'),
            which === 'unclaimed' ? isNull(schema.payments.providerRef) : undefined,
          ),
        )
        .returning({ id: schema.payments.id });
      if (rows.length === 0) return false;
      if (event) await recordPaymentEvent(tx, event);
      return true;
    });
  }

  /**
   * After a credit of approval `tid` was refused because the payment was credited meanwhile
   * (by the ReturnUrl or the approval 재통보, whichever came second). Under `tid` itself that
   * is this same approval, and nothing is owed. Under another Tid the payment's Moid had two
   * approvals — a window of it approved through another payment's ReturnUrl (netCancel) whose
   * 재통보 credited it first, say — and `tid` is charged with no P, which nothing flags
   * (needsReview skips a credited payment: no settle takes one, so nothing would clear it). So
   * this shouts. Never throws: the answer does not wait on it.
   */
  private async creditedUnderAnotherTid(
    payment: PaymentRow,
    tid: string,
    what: string,
  ): Promise<void> {
    try {
      const [row] = await this.db
        .select({ providerRef: schema.payments.providerRef })
        .from(schema.payments)
        .where(eq(schema.payments.id, payment.id))
        .limit(1);
      if (!row || row.providerRef === null || row.providerRef === tid) return;
      this.logger.error(
        `${what} ${tid} for payment ${payment.id}, which was credited meanwhile under ${row.providerRef}: its Moid has two approvals, and ${tid} is charged with no P — check both in the merchant admin, then cancel ${tid} there (a cancel 재통보 of it changes nothing on this payment) or honour it by hand (POST /admin/users/${payment.userId}/balance-adjust)`,
      );
    } catch (error) {
      this.logger.error(
        `${what} ${tid} for payment ${payment.id}, which was credited meanwhile: reading its Tid failed (${describeFailure(error)}) — check that it is ${tid} in the merchant admin`,
      );
    }
  }

  /** The payment's status as it stands now, or undefined when the row is gone. */
  private async currentStatus(paymentId: string): Promise<PaymentStatus | undefined> {
    const [row] = await this.db
      .select({ status: schema.payments.status })
      .from(schema.payments)
      .where(eq(schema.payments.id, paymentId))
      .limit(1);
    return row?.status;
  }

  /** The browser's result for the payment as it stands now (someone else moved it). */
  private async currentResult(paymentId: string): Promise<string> {
    const status = await this.currentStatus(paymentId);
    return this.walletUrl(paymentId, status ? await this.resultOf(paymentId, status) : 'failed');
  }

  /**
   * The browser's `result` for a payment already past `pending` (RESULT_BY_STATUS) — except a
   * `cancelled` one whose cancel nobody has confirmed (netCancelOutcome is not `cancelled`: the
   * net cancel got no clear answer, or has not had one yet). Its card may still be charged and an
   * admin may yet credit it, so every redirect says `pending` for it, as the ReturnUrl that left
   * it so did (`Payment.cancelConfirmed` false) — a re-posted form or a late StopUrl too.
   */
  private async resultOf(paymentId: string, status: PaymentStatus): Promise<PaymentReturnResult> {
    if (status === 'cancelled' && (await netCancelOutcome(this.db, paymentId)) !== 'cancelled') {
      return 'pending';
    }
    return RESULT_BY_STATUS[status];
  }
}
