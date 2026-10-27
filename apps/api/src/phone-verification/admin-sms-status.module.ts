import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { RedisModule } from '../infra/redis/redis.module.js';
import { AdminSmsStatusController } from './admin-sms-status.controller.js';
import { SmsStatusService } from './sms-status.service.js';

/**
 * SMS 발송 현황 (#183, owner decision 2026-10-18, second round, ADR-0070): `GET /admin/sms/status`,
 * the counts of the 본인확인 texts read from `phone_verification_codes` and
 * `phone_verification_refused_sends`. A module of its own, registered after the other admin
 * modules, so the route sits at the end of the admin surface (and of its OpenAPI tag). Guards are
 * instantiated in the module that declares the controller, so DbModule and RedisModule are
 * imported for AdminGuard.
 */
@Module({
  imports: [DbModule, RedisModule, AuthModule],
  controllers: [AdminSmsStatusController],
  providers: [SmsStatusService],
})
export class AdminSmsStatusModule {}
