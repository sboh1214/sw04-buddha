import * as z from 'zod';
import { paymentProviderSchema } from './enums.js';
import { expectedAccountIdSchema } from './expected-account.js';

/**
 * Payment-provider contracts shared by the API and the web (ADR-0042). The SmartroPay
 * integration that first filled this file is gone (ADR-0049): what stays is the seam a provider
 * slots into — which one takes new charges, and the admin refund every provider supports.
 */

/** An admin refund is allowed only this many days after the approval (owner decision 5). */
export const PAYMENT_REFUND_WINDOW_DAYS = 7;

/** `RefundPaymentBody.reason`: stored in admin_actions; a PG's cancel message takes a prefix. */
export const REFUND_REASON_MAX_LENGTH = 500;

/** `GET /payments/provider`: which charge flow the web offers (`mock`: the immediate charge). */
export const paymentProviderInfoSchema = z
  .object({ provider: paymentProviderSchema })
  .meta({ id: 'PaymentProviderInfo' });
export type PaymentProviderInfo = z.infer<typeof paymentProviderInfoSchema>;

/**
 * `POST /admin/payments/:id/refund`: why the admin is refunding (required, audited), as the admin
 * on screen (`expectedAccountId`, ADR-0092 — Q-PG-8 ①, owner decision 2026-10-26 «이 PR에서 더함»).
 */
export const refundPaymentBodySchema = z
  .object({
    reason: z.string().trim().min(1).max(REFUND_REASON_MAX_LENGTH),
    expectedAccountId: expectedAccountIdSchema,
  })
  .meta({ id: 'RefundPaymentBody' });
export type RefundPaymentBody = z.infer<typeof refundPaymentBodySchema>;
