import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { DbModule } from '../infra/db/db.module.js';
import {
  CommentLikesController,
  MyLikesController,
  PostLikesController,
} from './likes.controller.js';
import { LikesService } from './likes.service.js';

/**
 * 좋아요 (#49, ADR-0076): an account's likes of posts and comments, and what it liked on a post page.
 * The posts' and comments' own reads (PostsModule, CommentsModule) count the likes beside each
 * target (like-queries.ts), without this module.
 */
@Module({
  // DbModule and AuthModule also serve the guards (SessionGuard, OnboardedGuard); IdentityModule
  // is the keyed hash of the verified number a like is held once by (ADR-0069 decision 7).
  imports: [DbModule, AuthModule, IdentityModule],
  controllers: [PostLikesController, CommentLikesController, MyLikesController],
  providers: [LikesService],
})
export class LikesModule {}
