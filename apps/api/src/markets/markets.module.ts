import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { RedisModule } from '../infra/redis/redis.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { ReleaseSettingsModule } from '../release-settings/release-settings.module.js';
import { AdminMarketReviewsController } from './admin-market-reviews.controller.js';
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
 * is the M5 producer the transitions hand their close/finalize jobs to; ReleaseSettingsModule
 * reads the lead-close gap `market.lead_close_gap` the open-items check and an open market's close
 * edit hold a market to (#22, ADR-0098). ApprovalsModule is the two-person rule (#171) the review
 * takes its `market_review` requests through (#78, ADR-0099), and AdminMarketReviewsController the
 * 검수 대기 queue.
 */
@Module({
  imports: [
    DbModule,
    RedisModule,
    AuthModule,
    RealtimeModule,
    JobsModule,
    ReleaseSettingsModule,
    ApprovalsModule,
  ],
  controllers: [
    MarketsController,
    CategoriesController,
    AdminMarketsController,
    AdminMarketReviewsController,
  ],
  providers: [MarketService, MarketAdminService, RelatedMarketsService],
  // MarketAdminService for the proposals (#77): a 채택 makes its draft through `createIn`.
  exports: [MarketService, MarketAdminService],
})
export class MarketsModule {}
