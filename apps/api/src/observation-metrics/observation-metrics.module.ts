import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { RedisModule } from '../infra/redis/redis.module.js';
import { AdminObservationMetricsController } from './admin-observation-metrics.controller.js';
import { ObservationMetricsService } from './observation-metrics.service.js';

/**
 * 관측 지표 (#96, ADR-0169): `GET /admin/observation-metrics`, the weekly observation metrics read
 * from the fills, profiles, settlement records, posts, comments, reports and role-change records.
 * No table, job or cache of its own (95-8). DbModule and RedisModule are imported for AdminGuard
 * and OnboardedGuard, which are instantiated in the module that declares the controller.
 */
@Module({
  imports: [DbModule, RedisModule, AuthModule],
  controllers: [AdminObservationMetricsController],
  providers: [ObservationMetricsService],
})
export class ObservationMetricsModule {}
