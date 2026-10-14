import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
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
 * Wallet (PLAN 5.1, M2) and the charge on top of it. The providers come from PaymentsModule
 * (ADR-0042), and so does the switch that closes paid Coin while it is off (ADR-0049).
 */
@Module({
  imports: [DbModule, AuthModule, PaymentsModule, RealtimeModule],
  controllers: [
    ChargePackagesController,
    PaymentProviderController,
    PaymentsController,
    CouponsController,
    MeWalletController,
  ],
  providers: [WalletService, ChargePackageService, CouponService],
  exports: [WalletService, ChargePackageService, CouponService],
})
export class WalletModule {}
