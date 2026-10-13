import { Inject, Injectable } from '@nestjs/common';
import { MockPaymentProvider } from './mock-payment.provider.js';
import { type PaymentProvider } from './payment-provider.js';
import { PAYMENTS_CONFIG, type PaymentsConfig } from './payments-config.js';

/**
 * Every provider this deployment can talk to, by the name `payments.provider` stores (ADR-0042).
 *
 * The CONFIGURED one (PAYMENT_PROVIDER) decides which charge flow is open; everything that acts
 * on an existing payment — a refund — looks the payment's own provider up here, so a payment
 * stays refundable after the configured provider changes. The mock is the only one until the
 * next PG (ADR-0049).
 */
@Injectable()
export class PaymentProviderRegistry {
  private readonly byName = new Map<string, PaymentProvider>();
  readonly configured: PaymentProvider;

  constructor(@Inject(PAYMENTS_CONFIG) config: PaymentsConfig, mock: MockPaymentProvider) {
    this.byName.set(mock.name, mock);
    const configured = this.byName.get(config.provider);
    // config/env.ts accepts registered names only, so this is a wiring bug (an override naming
    // a provider nothing registers), and it fails the boot rather than a charge.
    if (!configured) {
      throw new Error(`PAYMENT_PROVIDER=${config.provider} is not configured`);
    }
    this.configured = configured;
  }

  /** The provider that took a payment, or undefined when this deployment cannot reach it. */
  get(name: string): PaymentProvider | undefined {
    return this.byName.get(name);
  }
}
