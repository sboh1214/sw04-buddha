import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Env } from '../config/env.js';
import { MockPaymentProvider } from './mock-payment.provider.js';
import { PAYMENT_PROVIDER } from './payment-provider.js';
import { PaymentProviderRegistry } from './payment-provider.registry.js';
import { PAYMENTS_CONFIG, type PaymentsConfig, paymentsConfigFromEnv } from './payments-config.js';
import {
  FetchSmartroClient,
  SMARTRO_CLIENT,
  type SmartroClient,
} from './smartro/smartro-client.js';

const paymentsConfigProvider: Provider<PaymentsConfig> = {
  provide: PAYMENTS_CONFIG,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): PaymentsConfig =>
    paymentsConfigFromEnv({
      PAYMENT_PROVIDER: config.get('PAYMENT_PROVIDER', { infer: true }),
      SMARTRO_MODE: config.get('SMARTRO_MODE', { infer: true }),
      SMARTRO_MID: config.get('SMARTRO_MID', { infer: true }),
      SMARTRO_MERCHANT_KEY: config.get('SMARTRO_MERCHANT_KEY', { infer: true }),
      SMARTRO_CANCEL_PASSWORD: config.get('SMARTRO_CANCEL_PASSWORD', { infer: true }),
      SMARTRO_APPROVAL_BASE_URL: config.get('SMARTRO_APPROVAL_BASE_URL', { infer: true }),
      BETTER_AUTH_URL: config.get('BETTER_AUTH_URL', { infer: true }),
    }),
};

/**
 * The real client whenever SmartroPay is configured. Without credentials nothing may call it —
 * the registry has no SmartroPay provider and the callbacks refuse first — so the stand-in
 * throws instead of posting to a host with no Mid.
 */
const smartroClientProvider: Provider<SmartroClient> = {
  provide: SMARTRO_CLIENT,
  inject: [PAYMENTS_CONFIG],
  useFactory: (config: PaymentsConfig): SmartroClient => {
    if (config.smartro) return new FetchSmartroClient(config.smartro.approvalBaseUrl);
    const unconfigured = (): never => {
      throw new Error('SmartroPay is not configured (SMARTRO_MID / SMARTRO_MERCHANT_KEY / …)');
    };
    return { approve: unconfigured, inquire: unconfigured, cancel: unconfigured };
  },
};

/**
 * The payment providers (ADR-0042): configuration, the SmartroPay HTTP client, the registry by
 * name and PAYMENT_PROVIDER — the configured one, which `WalletService.charge` uses and the
 * suites spy on.
 */
@Module({
  providers: [
    paymentsConfigProvider,
    smartroClientProvider,
    MockPaymentProvider,
    PaymentProviderRegistry,
    {
      provide: PAYMENT_PROVIDER,
      inject: [PaymentProviderRegistry],
      useFactory: (registry: PaymentProviderRegistry) => registry.configured,
    },
  ],
  exports: [PAYMENTS_CONFIG, SMARTRO_CLIENT, PaymentProviderRegistry, PAYMENT_PROVIDER],
})
export class PaymentsModule {}
