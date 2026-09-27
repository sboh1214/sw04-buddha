import { HttpException, HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { schema, type Db } from '@buddha/db';
import {
  CARD_MIN_PRICE_KRW,
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
import { and, eq, isNull, ne, or } from 'drizzle-orm';
import { assertExpectedAccount } from '../../auth/expected-account.js';
import { AppError } from '../../common/errors/app-error.js';
import { findPgError, isPgError, PG_UNIQUE_VIOLATION } from '../../common/errors/pg-error.js';
import { DB } from '../../infra/db/db.provider.js';
import { type CreditOutcome, type PaymentRow, WalletService } from '../../wallet/wallet.service.js';
import { type PaymentEventInput, recordPaymentEvent, resultMessageOf } from '../payment-events.js';
import { type CancelOutcome } from '../payment-provider.js';
import { PaymentProviderRegistry } from '../payment-provider.registry.js';
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
  ediDate,
  encryptData,
  goodsName,
  isAllowedNotifyAddress,
  isApprovalSuccess,
  mallUserId,
  smartroCallbackUrl,
  smartroScriptUrls,
  verifySignValue,
} from './smartro-protocol.js';

/** UNIQUE (provider, provider_ref) WHERE provider_ref IS NOT NULL (migration 0015). */
const PROVIDER_REF_UNIQUE = 'payments_provider_provider_ref_unique';

/** BuyerEmail: at most 60 characters; a longer address is left out rather than cut. */
const BUYER_EMAIL_MAX = 60;
/** `payments.method` is varchar(16). */
const METHOD_MAX = 16;

/** CancelMsg of a net cancel: an approval we could not verify or could not credit. */
const NET_CANCEL_REASON = '가맹점 승인 처리 실패로 인한 자동 취소';

/** What SmartroPay needs in its body to stop re-sending a 재통보. */
export const NOTIFY_OK = 'OK';

/**
 * The fields a callback's `payment_events` row keeps: what SmartroPay's ReturnUrl, StopUrl and
 * 재통보 posts carry (신통보 names, and the 구통보 TID/OID/MID). The ReturnUrl and StopUrl are
 * public and the table is append-only, so nothing else a caller posts is ever stored.
 */
const CALLBACK_EVENT_FIELDS = [
  'Tid',
  'TID',
  'Otid',
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

/** A KRW amount as SmartroPay writes it (digits only), or null. */
function parseKrw(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,12}$/.test(value)) return null;
  const amount = Number(value);
  return amount > 0 ? amount : null;
}

/**
 * What a failure may say in a log line. Never the error's own message when it came from the
 * driver: drizzle puts the bound parameters there (a TrAuthKey on the return path), and nothing
 * the PG sent may reach a log beyond its result code (DESIGN §5.7).
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
      return this.walletUrl(payment.id, RESULT_BY_STATUS[payment.status]);
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
   * decides which of two concurrent submits approves, committed with the `return` event (DESIGN
   * §5.4 step 4) so a claimed payment always shows what claimed it. It holds the payment row
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
      if (approval) return approval;
      this.logger.warn(`payment ${paymentId}: ${type} answered without a ResultCode`);
    }
    this.logger.error(
      `payment ${paymentId}: approval outcome unknown; left pending for the 재통보 or an admin`,
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
      const failed = await this.markFailed(
        payment.id,
        resultMessageOf(approval.resultMessage),
        'claimed',
      );
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
        return this.walletUrl(payment.id, RESULT_BY_STATUS[current]);
      }
      this.logger.error(
        `payment ${payment.id}: approved (${tid}) but the credit failed (${describeFailure(error)}); net-cancelling`,
      );
      return this.netCancel(payment, tid, approval);
    }
    if (credit.credited || credit.status === 'succeeded') {
      // Credited here, or by the 재통보 that arrived while the approval ran.
      return this.walletUrl(payment.id, 'succeeded');
    }
    this.logger.error(
      `payment ${payment.id}: approved (${tid}) but it was ${credit.status ?? 'gone'} before the credit; settle it by hand`,
    );
    return this.walletUrl(payment.id, credit.status ? RESULT_BY_STATUS[credit.status] : 'pending');
  }

  /** Every check an approval must pass before its P is credited (DESIGN §5.4 step 7). */
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
   * for the amount it actually approved. `cancelled` when the PG confirms; when it does not,
   * the payment stays `pending` with a loud log, because the money may still be taken.
   *
   * Never an approval that belongs to ANOTHER payment of ours: its Moid names one, or its Tid
   * is already one's reference. A payer who replays an earlier payment's Tid and TrAuthKey here
   * gets that approval back from the inquiry, and cancelling it would cancel a card whose P was
   * credited. That payment's own flow owns the approval; this one, which nothing approved, fails.
   */
  private async netCancel(payment: PaymentRow, tid: string, approval: Approval): Promise<string> {
    const owner = await this.otherPaymentOf(payment.id, approval.moid, tid);
    if (owner !== undefined) {
      this.logger.error(
        `payment ${payment.id}: approval ${tid} belongs to payment ${owner}; not cancelled, this payment fails — check both by hand`,
      );
      const failed = await this.markFailed(payment.id, null, 'claimed');
      return failed ? this.walletUrl(payment.id, 'failed') : this.currentResult(payment.id);
    }
    // Reserve before the PG is asked: `cancelled` first, so a 재통보 credit racing this cancel
    // finds the payment settled (or, while no `net_cancel` event exists yet, asks to be sent
    // again — settleNotify) instead of crediting P for a card that is about to be cancelled.
    const reserved = await this.db
      .update(schema.payments)
      .set({ status: 'cancelled', providerRef: tid, updatedAt: new Date() })
      .where(and(eq(schema.payments.id, payment.id), eq(schema.payments.status, 'pending')))
      .returning({ id: schema.payments.id });
    if (reserved.length === 0) {
      this.logger.error(
        `payment ${payment.id}: left pending before its net cancel of ${tid}; not cancelled — reconcile it by hand`,
      );
      return this.currentResult(payment.id);
    }
    const provider = this.providers.get('smartro');
    // A throw is "no answer" too: the payment must not stay reserved as `cancelled`.
    const unknown: CancelOutcome = { status: 'unknown' };
    const outcome: CancelOutcome = provider
      ? await provider
          .cancel({
            paymentId: payment.id,
            providerRef: tid,
            priceKrw: parseKrw(approval.amt) ?? payment.priceKrw,
            reason: NET_CANCEL_REASON,
          })
          .catch(() => unknown)
      : unknown;
    await recordPaymentEvent(this.db, {
      paymentId: payment.id,
      type: 'net_cancel',
      resultCode: outcome.resultCode,
      resultMessage: outcome.resultMessage,
      payload: outcome.payload,
    });
    if (outcome.status !== 'cancelled') {
      // Not cancelled, so the money may still be taken: back to `pending`, where the 재통보
      // can still credit it and an admin sees it.
      await this.db
        .update(schema.payments)
        .set({ status: 'pending', updatedAt: new Date() })
        .where(and(eq(schema.payments.id, payment.id), eq(schema.payments.status, 'cancelled')));
      this.logger.error(
        `payment ${payment.id}: net cancel of ${tid} ${outcome.status} (${outcome.resultCode ?? 'no code'}); left pending — cancel it in the merchant admin`,
      );
      return this.walletUrl(payment.id, 'pending');
    }
    await this.db
      .update(schema.payments)
      .set({ resultMessage: resultMessageOf(outcome.resultMessage), updatedAt: new Date() })
      .where(and(eq(schema.payments.id, payment.id), eq(schema.payments.status, 'cancelled')));
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
      // Already settled — credited, refunded, net-cancelled — the notice changes nothing.
      // A net cancel between its reservation and the PG's answer (netCancel): the outcome is
      // not known yet — it may still fall back to `pending` and need this very credit — so the
      // notice is refused with a 5xx and SmartroPay sends it again.
      if (payment.status === 'cancelled' && !(await this.hasEvent(payment.id, 'net_cancel'))) {
        throw new Error(`net cancel of payment ${payment.id} in flight`);
      }
      if (payment.status !== 'pending' && payment.status !== 'failed') return NOTIFY_OK;
      // Never claimed by our ReturnUrl, so never approved: under 인증/승인 분리 the PG approves
      // only when WE call urlCallApproval, and that call always follows a committed claim
      // (`provider_ref` set). An approval notice for an unclaimed payment is not genuine,
      // whatever it says — and no re-send can change that, so it is acknowledged. Its `notify`
      // event above is the record.
      if (payment.providerRef === null) {
        this.logger.error(
          `재통보 approval ${tid} for payment ${payment.id}, which no ReturnUrl claimed; not credited — check it by hand`,
        );
        return NOTIFY_OK;
      }
      const mid = field(fields, 'Mid', 'MID');
      if (mid !== smartro.mid || parseKrw(field(fields, 'Amt')) !== payment.priceKrw) {
        this.logger.error(
          `재통보 approval ${tid} does not match payment ${payment.id} (${mid === smartro.mid ? 'Amt' : 'Mid'}); not credited — settle it by hand`,
        );
        return NOTIFY_OK;
      }
      // `failed` too (a claimed one): the PG's approval is authoritative over a failure recorded
      // on our side (an inquiry that found nothing while the approval was still on its way).
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
        });
      } catch (error) {
        if (!isPgError(error, PG_UNIQUE_VIOLATION, PROVIDER_REF_UNIQUE)) throw error;
        // The Tid is already another payment's reference: crediting it here would count one
        // PG transaction twice. No re-send can change that, so OK rather than a 5xx the PG
        // would repeat until its retries run out.
        this.logger.error(
          `재통보 approval ${tid} for payment ${payment.id} is already recorded on another payment; not credited — settle it by hand`,
        );
        return NOTIFY_OK;
      }
      if (credit.credited) this.logger.log(`payment ${payment.id} credited by the 재통보 (${tid})`);
      return NOTIFY_OK;
    }

    if ((state === '1' || state === '2') && payment.status === 'succeeded') {
      // Cancelled outside this service (the merchant admin). Whether to claw the P back is an
      // open owner question (ADR-0042), so nothing moves: the event is recorded and this shouts.
      this.logger.error(
        `payment ${payment.id} was cancelled at the PG (재통보 StateCd ${state}, ${tid}) but its P was not clawed back; settle it by hand`,
      );
    }
    return NOTIFY_OK;
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
   * Another payment than `paymentId` that `moid` names or whose reference `tid` already is:
   * the payment an approval belongs to when it is not this one.
   */
  private async otherPaymentOf(
    paymentId: string,
    moid: string | undefined,
    tid: string,
  ): Promise<string | undefined> {
    const namedId = moid === undefined ? null : moidToPaymentId(moid);
    const [row] = await this.db
      .select({ id: schema.payments.id })
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
      .limit(1);
    return row?.id;
  }

  /**
   * `pending` → `failed`, with `event` recorded in the same transaction when given — and only
   * when the row did change. `unclaimed`: only while no approval holds it (the window came back
   * empty, a stop). `claimed`: the approval this request made was refused.
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

  /** The payment's status as it stands now, or undefined when the row is gone. */
  /** Whether the payment has at least one event of `type` recorded. */
  private async hasEvent(paymentId: string, type: PaymentEventType): Promise<boolean> {
    const rows = await this.db
      .select({ id: schema.paymentEvents.id })
      .from(schema.paymentEvents)
      .where(
        and(eq(schema.paymentEvents.paymentId, paymentId), eq(schema.paymentEvents.type, type)),
      )
      .limit(1);
    return rows.length > 0;
  }

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
    return this.walletUrl(paymentId, status ? RESULT_BY_STATUS[status] : 'failed');
  }
}
