import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { RedisModule } from '../infra/redis/redis.module.js';
import { MarketsModule } from '../markets/markets.module.js';
import { AdminProposalsController } from './admin-proposals.controller.js';
import { AdminProposalsService } from './admin-proposals.service.js';
import { ProposalRestrictions } from './proposal-restrictions.js';
import { MeProposalsController } from './proposals.controller.js';
import { ProposalsService } from './proposals.service.js';

/**
 * 시장 제안 (#77): the proposer's `/me/proposals` and the operators' `/admin/proposals`. Imports
 * IdentityModule for the keyed hash of the verified number the limits count by (ADR-0071), and
 * MarketsModule for the draft a 채택 makes (`MarketAdminService.createIn`). DbModule and
 * RedisModule for the guards: AdminGuard reads the role through the Redis cache, OnboardedGuard the
 * onboarding from Postgres. `ProposalRestrictions` asks the writing and the account restriction
 * (#185, #139) through moderation/restrictions.ts, plain functions of the transaction.
 */
@Module({
  imports: [DbModule, RedisModule, AuthModule, IdentityModule, MarketsModule],
  controllers: [MeProposalsController, AdminProposalsController],
  providers: [ProposalsService, AdminProposalsService, ProposalRestrictions],
})
export class ProposalsModule {}
