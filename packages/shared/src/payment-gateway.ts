import * as z from 'zod';
import { uuidSchema } from './api/uuid.js';

/**
 * SmartroPay 일반연동 contracts shared by the API and the web (ADR-0042). Only DTOs and pure
 * helpers live here; the signatures (EncryptData, SignValue, HashData, the AES cancel payload)
 * need `node:crypto` and stay in the API.
 */

/** SmartroPay environments: `STG` (tpay/tmpay/tapproval hosts) or `REAL`. */
export const SMARTRO_MODES = ['STG', 'REAL'] as const;
export type SmartroMode = (typeof SMARTRO_MODES)[number];
export const smartroModeSchema = z.enum(SMARTRO_MODES);

/** A card payment below this is refused by the PG (ResultCode 3041), so we never offer one. */
export const CARD_MIN_PRICE_KRW = 1_000;

/** An admin refund is allowed only this many days after the approval (owner decision 5). */
export const PAYMENT_REFUND_WINDOW_DAYS = 7;

/** `RefundPaymentBody.reason`: stored in admin_actions; the PG's CancelMsg takes a prefix. */
export const REFUND_REASON_MAX_LENGTH = 500;

/**
 * The SDK script for each build. The SDK tells a phone from a PC by user agent itself, but its
 * mode check reads the `<script src>` host, so the page loads the build matching the device.
 */
const smartroScriptUrlSchema = z.object({ pc: z.string(), mobile: z.string() });

/**
 * `GET /payments/provider`: which charge flow the web offers. `mock` keeps the one-click
 * immediate charge; `smartro` opens the SmartroPay payment window.
 */
export const paymentProviderInfoSchema = z
  .discriminatedUnion('provider', [
    z.object({ provider: z.literal('mock') }),
    z.object({
      provider: z.literal('smartro'),
      mode: smartroModeSchema,
      scriptUrl: smartroScriptUrlSchema,
    }),
  ])
  .meta({ id: 'PaymentProviderInfo' });
export type PaymentProviderInfo = z.infer<typeof paymentProviderInfoSchema>;

/**
 * The hidden `tranMgr` form the SDK submits: every value a string, named exactly as the
 * SmartroPay manual names the request parameter. `BuyerEmail` may be `''` (an account without a
 * real mailbox).
 */
export const smartroPaymentFormSchema = z.object({
  PayMethod: z.string(),
  GoodsCnt: z.string(),
  GoodsName: z.string(),
  Amt: z.string(),
  Moid: z.string(),
  Mid: z.string(),
  ReturnUrl: z.string(),
  StopUrl: z.string(),
  BuyerName: z.string(),
  BuyerTel: z.string(),
  BuyerEmail: z.string(),
  EdiDate: z.string(),
  EncryptData: z.string(),
  TaxAmt: z.string(),
  TaxFreeAmt: z.string(),
  VatAmt: z.string(),
  MallUserId: z.string(),
});
export type SmartroPaymentForm = z.infer<typeof smartroPaymentFormSchema>;

/**
 * `POST /payments/smartro/prepare`: a reserved `pending` payment and the signed form that opens
 * the payment window for it. `approvalUrl` is our ReturnUrl, the action of the PC flow's
 * `approvalForm` (the SDK's callback hands the page Tid and TrAuthKey to post there).
 */
export const smartroPrepareResultSchema = z
  .object({
    paymentId: z.uuid(),
    mode: smartroModeSchema,
    scriptUrl: smartroScriptUrlSchema,
    approvalUrl: z.string(),
    form: smartroPaymentFormSchema,
  })
  .meta({ id: 'SmartroPrepareResult' });
export type SmartroPrepareResult = z.infer<typeof smartroPrepareResultSchema>;

/**
 * The `result` query value the API appends when it 303-redirects the browser back to
 * `/wallet?payment=<id>&result=<r>` after the payment window (ReturnUrl / StopUrl).
 */
export const PAYMENT_RETURN_RESULTS = [
  'succeeded',
  'failed',
  'stopped',
  'pending',
  'cancelled',
] as const;
export type PaymentReturnResult = (typeof PAYMENT_RETURN_RESULTS)[number];
export const paymentReturnResultSchema = z.enum(PAYMENT_RETURN_RESULTS);

/** `POST /admin/payments/:id/refund`: why the admin is refunding (required, audited). */
export const refundPaymentBodySchema = z
  .object({ reason: z.string().trim().min(1).max(REFUND_REASON_MAX_LENGTH) })
  .meta({ id: 'RefundPaymentBody' });
export type RefundPaymentBody = z.infer<typeof refundPaymentBodySchema>;

export interface VatSplit {
  /** 공급가액: `amt - vatAmt`. */
  taxAmt: number;
  /** 부가세: `floor(amt / 11)`. */
  vatAmt: number;
  /** 면세 금액: always 0 — every package is taxable (과세). */
  taxFreeAmt: number;
}

/**
 * TaxAmt / VatAmt / TaxFreeAmt of a VAT-inclusive KRW amount (owner decision 3).
 *
 * The manual's `floor(Amt - Amt / 1.1)` is `floor(Amt / 11)` exactly; it is computed in integer
 * arithmetic because float division has no place near money (PLAN 0.2). The same split is sent
 * with the payment and with its cancel.
 */
export function vatSplit(amtKrw: number): VatSplit {
  if (!Number.isSafeInteger(amtKrw) || amtKrw < 0) {
    throw new RangeError(
      `vatSplit expects a non-negative integer KRW amount, got ${String(amtKrw)}`,
    );
  }
  const vatAmt = (amtKrw - (amtKrw % 11)) / 11;
  return { taxAmt: amtKrw - vatAmt, vatAmt, taxFreeAmt: 0 };
}

/** A Moid we issue: the payment uuid, lower-case, without hyphens (Moid allows no symbols). */
const MOID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * The SmartroPay Moid (merchant order id, ≤ 40 characters, no special characters) of a payment:
 * its uuid without hyphens, 32 lower-case hex digits. Throws on anything that is not a uuid —
 * the argument is always our own payment id.
 */
export function paymentIdToMoid(paymentId: string): string {
  const parsed = uuidSchema.safeParse(paymentId);
  if (!parsed.success) throw new RangeError(`not a payment id: ${paymentId}`);
  return parsed.data.replaceAll('-', '');
}

/**
 * The payment id a Moid names, or null when it is not one we could have issued. Strict: the
 * callbacks are public, so anything but exactly 32 lower-case hex digits forming a valid uuid is
 * refused before it reaches a query.
 */
export function moidToPaymentId(moid: string): string | null {
  if (!MOID_PATTERN.test(moid)) return null;
  const id = [
    moid.slice(0, 8),
    moid.slice(8, 12),
    moid.slice(12, 16),
    moid.slice(16, 20),
    moid.slice(20),
  ].join('-');
  return z.uuid().safeParse(id).success ? id : null;
}
