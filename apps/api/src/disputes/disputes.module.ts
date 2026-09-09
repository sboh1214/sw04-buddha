import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { RedisModule } from '../infra/redis/redis.module.js';
import { AdminDisputesController } from './admin-disputes.controller.js';
import { DisputeService } from './dispute.service.js';
import { DisputesController, MyDisputesController } from './disputes.controller.js';

/**
 * Disputes (PLAN 5.5, 7.2, 7.3; M5): filing during `resolving`, the caller's own list, the
 * admin list and review. Guards are instantiated by the module that declares the controller,
 * so DbModule and RedisModule are imported for AdminGuard (role lookup through the Redis
 * cache) and AuthModule for SessionGuard. No RealtimeModule: a dispute publishes nothing —
 * the market's status only moves when the admin changes the result (PLAN 12).
 */
@Module({
  imports: [DbModule, RedisModule, AuthModule],
  controllers: [DisputesController, MyDisputesController, AdminDisputesController],
  providers: [DisputeService],
})
export class DisputesModule {}
