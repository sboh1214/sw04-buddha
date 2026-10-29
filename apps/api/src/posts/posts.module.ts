import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { LinkReviewModule } from '../link-review/link-review.module.js';
import { WriteLimitsModule } from '../write-limits/write-limits.module.js';
import { MarketPostsController, PostsController } from './posts.controller.js';
import { PostsService } from './posts.service.js';

/**
 * 근거 글 (#46, ADR-0073): the community list, a post page and the author's writes, and a market's
 * 토론 (#47: `GET /markets/:id/posts`, the list narrowed to the market with its count). The images a
 * post shows are MediaModule's (`/media`); a post only takes them by id, in its own transaction.
 */
@Module({
  // DbModule and AuthModule also serve the guards (SessionGuard, OnboardedGuard); the write limits
  // and the repeated-link rules (#187) count every post and edit.
  imports: [DbModule, AuthModule, WriteLimitsModule, LinkReviewModule],
  controllers: [PostsController, MarketPostsController],
  providers: [PostsService],
  exports: [PostsService],
})
export class PostsModule {}
