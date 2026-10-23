import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { RedisModule } from '../infra/redis/redis.module.js';
import { AdminLinkFlagsController } from './admin-link-flags.controller.js';
import { LinkReviewModule } from './link-review.module.js';

/**
 * The repeated-link review list for operators (#187, ADR-0083): `GET /admin/link-flags`. A module
 * of its own, apart from LinkReviewModule which the posts and comments import, so the route stands
 * where AppModule puts this module in the document. Its screen is a page of #50's moderation area
 * (ADR-0083 7-12); the routes kept their path and module when the stack was put back together.
 */
@Module({
  // Guards are instantiated in the module that declares the controller: DbModule, RedisModule and
  // AuthModule serve SessionGuard, AdminGuard and OnboardedGuard.
  imports: [DbModule, RedisModule, AuthModule, LinkReviewModule],
  controllers: [AdminLinkFlagsController],
})
export class AdminLinkFlagsModule {}
