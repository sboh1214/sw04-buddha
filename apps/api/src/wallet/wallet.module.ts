import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { MockPaymentProvider } from '../payments/mock-payment.provider.js';
import { PAYMENT_PROVIDER } from '../payments/payment-provider.js';
import { MeWalletController, PaymentsController } from './wallet.controller.js';
import { WalletService } from './wallet.service.js';

/**
 * Wallet (PLAN 5.1, M2). The provider is bound by token so a real gateway replaces this one
 * binding (PLAN 16); the MVP always resolves to the mock.
 */
@Module({
  imports: [DbModule, AuthModule],
  controllers: [PaymentsController, MeWalletController],
  providers: [WalletService, { provide: PAYMENT_PROVIDER, useClass: MockPaymentProvider }],
  exports: [WalletService],
})
export class WalletModule {}
