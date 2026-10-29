import { Module } from '@nestjs/common';
import { DbModule } from '../infra/db/db.module.js';
import { LinkReviewService } from './link-review.service.js';

/**
 * 반복 링크 탐지 (#187, ADR-0083): the links posts and comments take and the repetition rules. No
 * routes here — the writes' services (PostsService, CommentsService) call it in their
 * transactions, and the review list's admin route is AdminLinkFlagsModule's.
 */
@Module({
  imports: [DbModule],
  providers: [LinkReviewService],
  exports: [LinkReviewService],
})
export class LinkReviewModule {}
