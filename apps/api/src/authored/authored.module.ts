import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { ProfilesModule } from '../profiles/profiles.module.js';
import { MyAuthoredController, ProfileAuthoredController } from './authored.controller.js';
import { AuthoredService } from './authored.service.js';

/**
 * 작성자별 글·댓글 목록 (#51, ADR-0080): a member's posts and comments on the public profile and on
 * MY '내 글'. The profile finds the member (ProfilesModule, `memberIdOf`); the items are read here,
 * as the post and comment reads make them.
 */
@Module({
  // DbModule and AuthModule also serve SessionGuard.
  imports: [DbModule, AuthModule, ProfilesModule],
  controllers: [ProfileAuthoredController, MyAuthoredController],
  providers: [AuthoredService],
})
export class AuthoredModule {}
