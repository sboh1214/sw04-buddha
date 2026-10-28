import { Module } from '@nestjs/common';
import { DbModule } from '../infra/db/db.module.js';
import { ProfilesController } from './profiles.controller.js';
import { ProfilesService } from './profiles.service.js';

/**
 * 공개 프로필 (#41, ADR-0078): the public read of a member's profile. Its edits are MY 설정's, under
 * `/me` (MeModule's `PUT /me/bio` and `PATCH /me`, OnboardingModule's interest categories), behind
 * the one check point of public-item writes (me/public-items.ts).
 */
@Module({
  imports: [DbModule],
  controllers: [ProfilesController],
  providers: [ProfilesService],
  // The profile's lists (#51, AuthoredModule) find the member by the same rule.
  exports: [ProfilesService],
})
export class ProfilesModule {}
