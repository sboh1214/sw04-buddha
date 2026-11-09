import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { RedisModule } from '../infra/redis/redis.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { PaymentRefundService } from './payment-refund.service.js';
import { ReconciliationController } from './reconciliation.controller.js';
import { ReconciliationService } from './reconciliation.service.js';
import { ReconciliationCorrectionsController } from './reconciliation-corrections.controller.js';
import { ReconciliationCorrectionService } from './reconciliation-corrections.service.js';

/**
 * PLAN 12 admin surface. Guards are instantiated in the module that declares the controller,
 * so DbModule and RedisModule must be resolvable here as well (AdminGuard reads the role from
 * Postgres through a Redis cache).
 */
@Module({
  imports: [
    DbModule,
    RedisModule,
    AuthModule,
    WalletModule,
    PaymentsModule,
    RealtimeModule,
    ApprovalsModule,
  ],
  controllers: [AdminController, ReconciliationController, ReconciliationCorrectionsController],
  providers: [
    AdminService,
    PaymentRefundService,
    ReconciliationService,
    ReconciliationCorrectionService,
  ],
})
export class AdminModule {}
