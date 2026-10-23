import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { RedisModule } from '../infra/redis/redis.module.js';
import { MediaModule } from '../media/media.module.js';
import { AdminAccountRestrictionsController } from './account-restrictions.controller.js';
import { AccountRestrictionService } from './account-restrictions.service.js';
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
 * MY 내 글 reads a hiding's reason itself (AuthoredService). The writing restriction (#185) and the
 * account restriction (#139 — every step approved by another admin, AccountRestrictionService)
 * are actions of the same record.
 */
@Module({
  // DbModule and AuthModule also serve the guards (SessionGuard, OnboardedGuard, AdminGuard — which
  // caches roles in Redis); IdentityModule is the keyed hash of the verified number a person's
  // reports are counted by (ADR-0069 decision 7); MediaModule's store serves operators' images;
  // ApprovalsModule is the two-person rule every account restriction step goes through (#139).
  imports: [DbModule, RedisModule, AuthModule, IdentityModule, MediaModule, ApprovalsModule],
  controllers: [
    PostReportsController,
    CommentReportsController,
    ProfileReportsController,
    MyModerationController,
    AdminReportsController,
    AdminModerationController,
    AdminAccountRestrictionsController,
    AdminMediaController,
  ],
  providers: [ReportsService, ModerationService, ModerationReadsService, AccountRestrictionService],
})
export class ModerationModule {}
