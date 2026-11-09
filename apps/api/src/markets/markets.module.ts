import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { RedisModule } from '../infra/redis/redis.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { ReleaseSettingsModule } from '../release-settings/release-settings.module.js';
import {
  AdminMarketCancelQueueController,
  AdminMarketCancelsController,
} from './admin-market-cancels.controller.js';
import {
  AdminMarketDisputeQueueController,
  AdminMarketDisputesController,
} from './admin-market-disputes.controller.js';
import { AdminMarketJudgementDelaysController } from './admin-market-judgement-delays.controller.js';
import {
  AdminMarketJudgementQueueController,
  AdminMarketJudgementsController,
} from './admin-market-judgements.controller.js';
import {
  AdminMarketPauseDecisionQueueController,
  AdminMarketPausesController,
} from './admin-market-pauses.controller.js';
import { AdminMarketReviewsController } from './admin-market-reviews.controller.js';
import {
  AdminMarketSupplementQueueController,
  AdminMarketSupplementsController,
} from './admin-market-supplements.controller.js';
import { AdminMarketsController } from './admin-markets.controller.js';
import { MarketAdminService } from './market-admin.service.js';
import { MarketCancelService } from './market-cancel.service.js';
import { MarketDisputeService } from './market-dispute.service.js';
import { MarketDisputesController, MeDisputesController } from './market-disputes.controller.js';
import { MarketJudgementDelayService } from './market-judgement-delay.service.js';
import { MarketJudgementService } from './market-judgement.service.js';
import { MarketPauseService } from './market-pause.service.js';
import { MarketSupplementService } from './market-supplement.service.js';
import { MarketService } from './market.service.js';
import { CategoriesController, MarketsController } from './markets.controller.js';
import { RelatedMarketsService } from './related-markets.service.js';

/**
 * Markets (PLAN 5.2, 7.1, 7.3, M3): public reads and the admin CRUD / transitions, and the links
 * between markets that a detail lists as 관련 시장 (#65, RelatedMarketsService).
 * Guards are instantiated by the module that declares the controller, so DbModule and
 * RedisModule are imported for AdminGuard (role lookup through the Redis cache). JobsModule
 * is the M5 producer the transitions hand their open/close/resolve jobs to; ReleaseSettingsModule
 * reads the lead-close gap `market.lead_close_gap` the open-items check and a supplement's close or
 * announcement change hold a market to (#22, ADR-0098), and the dispute window
 * `market.dispute_window` a judgement's approval fixes the deadline with (#152, ADR-0103).
 * ApprovalsModule is the two-person rule (#171) the review takes its `market_review` requests
 * through (#78, ADR-0099), and AdminMarketReviewsController the 검수 대기 queue; the rule supplement
 * (#80, ADR-0101) takes its `market_supplement` requests through it too (MarketSupplementService),
 * with its routes and its 규칙 보충 대기 queue, the pause (#114, ADR-0102) its
 * `market_pause_decision` requests — 재개 and 조기 마감 of a paused market (MarketPauseService) —
 * with its routes and its 일시 중단 결정 대기 queue, and the judgement (#152, ADR-0103) its
 * `market_judgement` registrations (MarketJudgementService) with its routes and its 판정 승인 대기
 * queue, and the cancel of a SCHEDULED market (#20, ADR-0117) its `market_cancel` requests
 * (MarketCancelService) with its routes and its 시장 취소 대기 queue. 판정 이의 (#175, ADR-0104;
 * MarketDisputeService) are no approval kind: a member's
 * submission (MarketDisputesController) and own reads and 철회 (MeDisputesController,
 * `/me/disputes`), one admin's 기각·수용 (AdminMarketDisputesController) and the 이의 접수 list.
 * Nor is 판정 지연 기록 (#142, ADR-0106; MarketJudgementDelayService): one admin records a delayed
 * market's reason and next review time (AdminMarketJudgementDelaysController).
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
    AdminMarketSupplementsController,
    AdminMarketSupplementQueueController,
    AdminMarketPausesController,
    AdminMarketPauseDecisionQueueController,
    AdminMarketCancelsController,
    AdminMarketCancelQueueController,
    AdminMarketJudgementsController,
    AdminMarketJudgementQueueController,
    AdminMarketJudgementDelaysController,
    MarketDisputesController,
    MeDisputesController,
    AdminMarketDisputesController,
    AdminMarketDisputeQueueController,
  ],
  providers: [
    MarketService,
    MarketAdminService,
    MarketSupplementService,
    MarketPauseService,
    MarketCancelService,
    MarketJudgementService,
    MarketJudgementDelayService,
    MarketDisputeService,
    RelatedMarketsService,
  ],
  // MarketAdminService for the proposals (#77): a 채택 makes its draft through `createIn`.
  exports: [MarketService, MarketAdminService],
})
export class MarketsModule {}
