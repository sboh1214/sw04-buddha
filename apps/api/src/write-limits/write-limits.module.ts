import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { WriteLimitsService } from './write-limits.service.js';

/**
 * 작성 빈도 제한 (#187, ADR-0083): the count every post, comment, edit and image upload passes. No
 * routes: the writes' own services (PostsService, CommentsService, MediaService,
 * ProfileImageService) call it in their transactions. IdentityModule is the keyed hash of the
 * verified number the limits count by (ADR-0069 decision 7).
 */
@Module({
  imports: [DbModule, IdentityModule],
  providers: [WriteLimitsService],
  exports: [WriteLimitsService],
})
export class WriteLimitsModule {}
