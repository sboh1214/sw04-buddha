import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { RedisModule } from '../infra/redis/redis.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { PaymentRefundService } from './payment-refund.service.js';

/**
 * PLAN 12 admin surface. Guards are instantiated in the module that declares the controller,
 * so DbModule and RedisModule must be resolvable here as well (AdminGuard reads the role from
 * Postgres through a Redis cache).
 */
@Module({
  imports: [DbModule, RedisModule, AuthModule, WalletModule, PaymentsModule, RealtimeModule],
  controllers: [AdminController],
  providers: [AdminService, PaymentRefundService],
})
export class AdminModule {}
