import { type PaymentStatus } from '@buddha/shared';

/** Injection token for the configured PaymentProvider. */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export interface ChargeRequest {
  /** Our payment id; a real PG receives it as the merchant order id. */
  paymentId: string;
  userId: string;
  /** P to be credited on success. */
  amountP: bigint;
  /** KRW to charge — what a real gateway actually collects (ADR-0026 discounts). */
  priceKrw: number;
}

export interface ChargeOutcome {
  /** 'succeeded' credits the balance; 'failed' records the attempt and credits nothing. */
  status: Extract<PaymentStatus, 'succeeded' | 'failed'>;
  /** Provider-side reference (`payments.provider_ref`). */
  providerRef: string;
  /** Present when the provider refused; surfaced to the client as VALIDATION_ERROR. */
  failureReason?: string;
}

/**
 * The seam a real payment gateway will slot into (PLAN 16). Everything the wallet needs from
 * a provider is here: a name for `payments.provider` and one call that either succeeds with a
 * reference or fails with a reason. A redirect/webhook provider will add its own module and
 * keep this interface for the immediate-capture path.
 */
export interface PaymentProvider {
  /** Stored in `payments.provider` (PAYMENT_PROVIDERS in @buddha/shared). */
  readonly name: string;
  charge(request: ChargeRequest): Promise<ChargeOutcome>;
}
