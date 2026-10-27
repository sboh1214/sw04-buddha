import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { CommentCursors } from './comment-cursor.js';
import { CommentsController, PostCommentsController } from './comments.controller.js';
import { CommentsService } from './comments.service.js';

/**
 * 댓글·대댓글 (#48, ADR-0074): a post's comments and their authors' writes. The posts' own reads
 * (PostsModule) ask the same table whether anything hangs under a post and how many comments it
 * shows (comment-queries.ts), without this module.
 */
@Module({
  // DbModule and AuthModule also serve the guards (SessionGuard, OnboardedGuard).
  imports: [DbModule, AuthModule],
  controllers: [PostCommentsController, CommentsController],
  providers: [CommentsService, CommentCursors],
})
export class CommentsModule {}
