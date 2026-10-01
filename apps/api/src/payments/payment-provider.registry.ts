import { Inject, Injectable } from '@nestjs/common';
import { MockPaymentProvider } from './mock-payment.provider.js';
import { type PaymentProvider } from './payment-provider.js';
import { PAYMENTS_CONFIG, type PaymentsConfig } from './payments-config.js';
import { SMARTRO_CLIENT, type SmartroClient } from './smartro/smartro-client.js';
import { SmartroPaymentProvider } from './smartro/smartro-payment.provider.js';

/**
 * Every provider this deployment can talk to, by the name `payments.provider` stores (ADR-0042).
 *
 * The CONFIGURED one (PAYMENT_PROVIDER) decides which charge flow is open; everything that acts
 * on an existing payment — a refund, a net cancel — looks the payment's own provider up here,
 * so a mock payment stays refundable after the switch to SmartroPay and the other way round.
 * SmartroPay is registered whenever its credentials are set — all three, since config/env.ts
 * refuses only some of them whichever provider is active.
 */
@Injectable()
export class PaymentProviderRegistry {
  private readonly byName = new Map<string, PaymentProvider>();
  readonly configured: PaymentProvider;

  constructor(
    @Inject(PAYMENTS_CONFIG) config: PaymentsConfig,
    mock: MockPaymentProvider,
    @Inject(SMARTRO_CLIENT) smartroClient: SmartroClient,
  ) {
    this.byName.set(mock.name, mock);
    if (config.smartro) {
      const smartro = new SmartroPaymentProvider(config.smartro, smartroClient);
      this.byName.set(smartro.name, smartro);
    }
    const configured = this.byName.get(config.provider);
    // config/env.ts refuses PAYMENT_PROVIDER=smartro without its credentials, so this is a
    // wiring bug (an override that forgot them), and it fails the boot rather than a charge.
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
