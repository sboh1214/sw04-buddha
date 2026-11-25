import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { RedisModule } from '../infra/redis/redis.module.js';
import { SignupAllowlistController } from './signup-allowlist.controller.js';
import { SignupAllowlistService } from './signup-allowlist.service.js';

/**
 * 가입 허용 목록 (#330, ADR-0174): the admins' list, its writes and its clear's approval. The
 * confirmation that reads it is PhoneVerificationModule's. Guards are instantiated in the module
 * that declares the controller, so DbModule and RedisModule are imported for AdminGuard as well.
 */
@Module({
  imports: [DbModule, RedisModule, AuthModule, ApprovalsModule, IdentityModule],
  controllers: [SignupAllowlistController],
  providers: [SignupAllowlistService],
})
export class SignupAllowlistModule {}
