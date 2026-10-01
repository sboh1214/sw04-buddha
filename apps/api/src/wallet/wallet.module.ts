import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { SmartroCallbackController } from '../payments/smartro/smartro-callback.controller.js';
import { SmartroPayService } from '../payments/smartro/smartro-pay.service.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { ChargePackageService } from './charge-package.service.js';
import { CouponService } from './coupon.service.js';
import {
  ChargePackagesController,
  CouponsController,
  MeWalletController,
  PaymentProviderController,
  PaymentsController,
} from './wallet.controller.js';
import { WalletService } from './wallet.service.js';

/**
 * Wallet (PLAN 5.1, M2) and the charge flows on top of it. The providers come from
 * PaymentsModule (ADR-0042): PAYMENT_PROVIDER picks the immediate mock charge or the SmartroPay
 * window, whose service and callbacks live here because they credit through WalletService.
 */
@Module({
  imports: [DbModule, AuthModule, PaymentsModule, RealtimeModule],
  controllers: [
    ChargePackagesController,
    PaymentProviderController,
    PaymentsController,
    SmartroCallbackController,
    CouponsController,
    MeWalletController,
  ],
  providers: [WalletService, ChargePackageService, CouponService, SmartroPayService],
  exports: [WalletService, ChargePackageService, CouponService],
})
export class WalletModule {}
