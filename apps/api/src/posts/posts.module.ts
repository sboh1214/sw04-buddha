import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { PostsController } from './posts.controller.js';
import { PostsService } from './posts.service.js';

/**
 * 근거 글 (#46, ADR-0073): the community list, a post page and the author's writes. The images a
 * post shows are MediaModule's (`/media`); a post only takes them by id, in its own transaction.
 */
@Module({
  // DbModule and AuthModule also serve the guards (SessionGuard, OnboardedGuard).
  imports: [DbModule, AuthModule],
  controllers: [PostsController],
  providers: [PostsService],
  exports: [PostsService],
})
export class PostsModule {}
