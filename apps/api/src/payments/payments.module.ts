import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PAID_COIN_SALES_ENABLED } from '@buddha/shared';
import { type Env } from '../config/env.js';
import { MockPaymentProvider } from './mock-payment.provider.js';
import { PAID_COIN_SALES, PaidCoinSalesGuard } from './paid-coin-sales.guard.js';
import { PAYMENT_PROVIDER } from './payment-provider.js';
import { PaymentProviderRegistry } from './payment-provider.registry.js';
import { PAYMENTS_CONFIG, type PaymentsConfig, paymentsConfigFromEnv } from './payments-config.js';

const paymentsConfigProvider: Provider<PaymentsConfig> = {
  provide: PAYMENTS_CONFIG,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): PaymentsConfig =>
    paymentsConfigFromEnv({
      PAYMENT_PROVIDER: config.get('PAYMENT_PROVIDER', { infer: true }),
    }),
};

/**
 * The payment providers (ADR-0042): configuration, the registry by name and PAYMENT_PROVIDER —
 * the configured one, which `WalletService.charge` uses and the suites spy on — and the switch
 * that closes paid Coin while it is off (PAID_COIN_SALES, ADR-0049).
 */
@Module({
  providers: [
    paymentsConfigProvider,
    { provide: PAID_COIN_SALES, useValue: PAID_COIN_SALES_ENABLED },
    PaidCoinSalesGuard,
    MockPaymentProvider,
    PaymentProviderRegistry,
    {
      provide: PAYMENT_PROVIDER,
      inject: [PaymentProviderRegistry],
      useFactory: (registry: PaymentProviderRegistry) => registry.configured,
    },
  ],
  exports: [
    PAYMENTS_CONFIG,
    PAID_COIN_SALES,
    PaidCoinSalesGuard,
    PaymentProviderRegistry,
    PAYMENT_PROVIDER,
  ],
})
export class PaymentsModule {}
