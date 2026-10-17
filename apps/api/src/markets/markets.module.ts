import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { RedisModule } from '../infra/redis/redis.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { AdminMarketsController } from './admin-markets.controller.js';
import { MarketAdminService } from './market-admin.service.js';
import { MarketService } from './market.service.js';
import { CategoriesController, MarketsController } from './markets.controller.js';
import { RelatedMarketsService } from './related-markets.service.js';

/**
 * Markets (PLAN 5.2, 7.1, 7.3, M3): public reads and the admin CRUD / transitions, and the links
 * between markets that a detail lists as 관련 시장 (#65, RelatedMarketsService).
 * Guards are instantiated by the module that declares the controller, so DbModule and
 * RedisModule are imported for AdminGuard (role lookup through the Redis cache). JobsModule
 * is the M5 producer the transitions hand their close/finalize jobs to.
 */
@Module({
  imports: [DbModule, RedisModule, AuthModule, RealtimeModule, JobsModule],
  controllers: [MarketsController, CategoriesController, AdminMarketsController],
  providers: [MarketService, MarketAdminService, RelatedMarketsService],
  exports: [MarketService],
})
export class MarketsModule {}
