import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { RedisModule } from '../infra/redis/redis.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import {
  AdminOperationsController,
  AdminSettlementRetriesController,
} from './admin-operations.controller.js';
import { AdminOperationsService } from './admin-operations.service.js';
import { SettlementRetryService } from './settlement-retry.service.js';

/**
 * 운영 대기열 (#145, ADR-0163): the three queue lists under `/admin/operations` and the operator's
 * 정산 다시 시도 (`POST /admin/markets/:id/settlement-retries`). RealtimeModule publishes a settled
 * retry's events and JobsModule asks for the bot recall after it, as the worker does. DbModule
 * and RedisModule are imported for AdminGuard and OnboardedGuard, which are instantiated in the
 * module that declares the controller.
 */
@Module({
  imports: [DbModule, RedisModule, AuthModule, JobsModule, RealtimeModule],
  controllers: [AdminOperationsController, AdminSettlementRetriesController],
  providers: [AdminOperationsService, SettlementRetryService],
})
export class OperationsModule {}
