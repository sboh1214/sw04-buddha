import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { RedisModule } from '../infra/redis/redis.module.js';
import { MediaModule } from '../media/media.module.js';
import {
  AdminMediaController,
  AdminModerationController,
  AdminReportsController,
} from './admin-moderation.controller.js';
import { ModerationReadsService } from './moderation-reads.service.js';
import { ModerationService } from './moderation.service.js';
import {
  CommentReportsController,
  MyModerationController,
  PostReportsController,
  ProfileReportsController,
} from './reports.controller.js';
import { ReportsService } from './reports.service.js';

/**
 * 신고와 운영 처리 (#50, ADR-0081): the members' reports and their MY page of reports and actions
 * received, and the operators' queue, moderation pages and actions. The posts', comments' and
 * profiles' own reads show what an action changed (`hidden_at`, the profile) without this module;
 * MY 내 글 reads a hiding's reason itself (AuthoredService).
 */
@Module({
  // DbModule and AuthModule also serve the guards (SessionGuard, OnboardedGuard, AdminGuard — which
  // caches roles in Redis); IdentityModule is the keyed hash of the verified number a person's
  // reports are counted by (ADR-0069 decision 7); MediaModule's store serves operators' images.
  imports: [DbModule, RedisModule, AuthModule, IdentityModule, MediaModule],
  controllers: [
    PostReportsController,
    CommentReportsController,
    ProfileReportsController,
    MyModerationController,
    AdminReportsController,
    AdminModerationController,
    AdminMediaController,
  ],
  providers: [ReportsService, ModerationService, ModerationReadsService],
})
export class ModerationModule {}
