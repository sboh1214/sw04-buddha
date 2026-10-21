import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { RedisModule } from '../infra/redis/redis.module.js';
import { AdminLinkFlagsController } from './admin-link-flags.controller.js';
import { LinkReviewModule } from './link-review.module.js';

/**
 * The repeated-link review list for operators (#187, ADR-0083): `GET /admin/link-flags`. A module
 * of its own, apart from LinkReviewModule which the posts and comments import, so the route stands
 * where AppModule puts this module in the document — and so it can move into #50's moderation area
 * whole when that is built (ADR-0083).
 */
@Module({
  // Guards are instantiated in the module that declares the controller: DbModule, RedisModule and
  // AuthModule serve SessionGuard, AdminGuard and OnboardedGuard.
  imports: [DbModule, RedisModule, AuthModule, LinkReviewModule],
  controllers: [AdminLinkFlagsController],
})
export class AdminLinkFlagsModule {}
