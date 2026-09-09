import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { RedisModule } from '../infra/redis/redis.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { AdminMarketsController } from './admin-markets.controller.js';
import { MarketAdminService } from './market-admin.service.js';
import { MarketService } from './market.service.js';
import { CategoriesController, MarketsController, QuotesController } from './markets.controller.js';
import { QuoteService } from './quote.service.js';

/**
 * Markets (PLAN 5.2, 7.1, 7.3, M3): public reads, quotes and the admin CRUD / transitions.
 * Guards are instantiated by the module that declares the controller, so DbModule and
 * RedisModule are imported for AdminGuard (role lookup through the Redis cache). JobsModule
 * is the M5 producer the transitions hand their delayed close/finalize jobs to; the dispute
 * window (TEST_DISPUTE_WINDOW_SECONDS) comes from the global ConfigModule.
 */
@Module({
  imports: [DbModule, RedisModule, AuthModule, RealtimeModule, JobsModule],
  controllers: [MarketsController, CategoriesController, QuotesController, AdminMarketsController],
  providers: [MarketService, MarketAdminService, QuoteService],
  exports: [MarketService],
})
export class MarketsModule {}
