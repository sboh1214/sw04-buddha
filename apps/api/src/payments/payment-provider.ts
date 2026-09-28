import { type PaymentStatus } from '@buddha/shared';

/** Injection token for the configured PaymentProvider (PAYMENT_PROVIDER in the env). */
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

export interface CancelRequest {
  paymentId: string;
  /** The provider's transaction id (`payments.provider_ref`; SmartroPay's Tid). */
  providerRef: string;
  /** KRW to give back: always the whole amount collected — a full cancel (owner decision 5). */
  priceKrw: number;
  /** Why; SmartroPay's CancelMsg takes the first 100 characters. */
  reason: string;
  /**
   * The PG's PayMethod of the approval (`payments.method`; CARD, NAVER, SMILEPAY…), when known:
   * SmartroPay's cancel codes are per method (classifyCancel). Null or absent: the answer's own
   * PayMethod decides.
   */
  method?: string | null;
}

export interface CancelOutcome {
  /**
   * `cancelled`: the provider confirmed (SmartroPay 2001, or an "already cancelled" code such
   * as 2013 — a retry of a cancel whose answer was lost). `refused`: it answered and said a
   * definite no. `unknown`: no readable answer arrived, or one that leaves the card's state open
   * (a cancel still in progress at the easy-pay company), so it may or may not be cancelled.
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
 * one call has it (the mock); a redirect provider (SmartroPay) takes its money through the
 * payment window and its callbacks instead, so the configured provider decides which charge
 * flow is open. `cancel` is what refunds and net cancels need, and every provider has it: a
 * refund goes to the provider recorded on the payment row, whatever is configured today.
 */
export interface PaymentProvider {
  /** Stored in `payments.provider` (PAYMENT_PROVIDERS in @buddha/shared). */
  readonly name: string;
  charge?(request: ChargeRequest): Promise<ChargeOutcome>;
  cancel(request: CancelRequest): Promise<CancelOutcome>;
}
