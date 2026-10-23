import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { RedisModule } from '../infra/redis/redis.module.js';
import { AdminRetentionPurgesController } from './admin-retention-purges.controller.js';
import { RetentionPurgesService } from './retention-purges.service.js';

/**
 * 개인정보 보존기간 (#184, ADR-0087): the admins' read of the purge records,
 * `GET /admin/retention-purges`. The purge itself is the worker's (`retention.purge`), and the
 * periods are release settings (ReleaseSettingsModule). Guards are instantiated in the module that
 * declares the controller, so DbModule and RedisModule are imported for AdminGuard.
 */
@Module({
  imports: [DbModule, RedisModule, AuthModule],
  controllers: [AdminRetentionPurgesController],
  providers: [RetentionPurgesService],
})
export class RetentionModule {}
