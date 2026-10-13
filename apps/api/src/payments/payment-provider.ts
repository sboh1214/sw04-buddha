import { type PaymentStatus } from '@buddha/shared';

/** Injection token for the configured PaymentProvider (PAYMENT_PROVIDER in the env). */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export interface ChargeRequest {
  /** Our payment id; a real PG receives it as the merchant order id. */
  paymentId: string;
  userId: string;
  /** Coin to be credited on success. */
  amountCoin: bigint;
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

export interface CancelRequest {
  paymentId: string;
  /** The provider's transaction id (`payments.provider_ref`). */
  providerRef: string;
  /** KRW to give back: always the whole amount collected — a full cancel (owner decision 5). */
  priceKrw: number;
  /** Why; a PG's cancel message may take only a prefix. */
  reason: string;
  /**
   * The PG's PayMethod of the approval (`payments.method`; CARD, NAVER, …), when known: a PG's
   * cancel answer may read differently per method.
   */
  method?: string | null;
}

export interface CancelOutcome {
  /**
   * `cancelled`: the provider confirmed (also its "already cancelled" — a retry of a cancel whose
   * answer was lost). `refused`: it answered and said a definite no. `unknown`: no readable
   * answer arrived, or one that leaves the card's state open, so it may or may not be cancelled.
   */
  status: 'cancelled' | 'refused' | 'unknown';
  resultCode?: string;
  resultMessage?: string;
  /** The provider's answer for `payment_events`, secrets already removed; absent for the mock. */
  payload?: Record<string, unknown>;
}

/**
 * The seam every payment gateway slots into (PLAN 16, ADR-0042). `name` goes into
 * `payments.provider`. `charge` is the immediate-capture path and only a provider that settles in
 * one call has it (the mock); a redirect provider takes its money through a payment window and
 * its callbacks instead, so the configured provider decides which charge flow is open. `cancel`
 * is what refunds need, and every provider has it: a refund goes to the provider recorded on the
 * payment row, whatever is configured today.
 */
export interface PaymentProvider {
  /** Stored in `payments.provider` (PAYMENT_PROVIDERS in @buddha/shared). */
  readonly name: string;
  charge?(request: ChargeRequest): Promise<ChargeOutcome>;
  cancel(request: CancelRequest): Promise<CancelOutcome>;
}
