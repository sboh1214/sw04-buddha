import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { MeModule } from '../me/me.module.js';
import { MediaModule } from '../media/media.module.js';
import { ProfileImageController } from './profile-image.controller.js';
import { ProfileImageService } from './profile-image.service.js';

/**
 * 프로필 이미지 (#141, ADR-0079): `PUT /me/profile-image` and `POST /me/profile-image/delete`. The
 * images go into MediaModule's store (OBJECT_STORAGE) through its body parser and gate, and are read
 * through its `GET /media/:mediaId`; the answers are MeModule's `Me`. A module of its own rather
 * than MeModule's routes, so MeModule need not import MediaModule — which would move the media
 * routes up the OpenAPI document — and it stands last in AppModule, after both.
 */
@Module({
  // DbModule and AuthModule also serve the guards (SessionGuard, OnboardedGuard).
  imports: [DbModule, AuthModule, MediaModule, MeModule],
  controllers: [ProfileImageController],
  providers: [ProfileImageService],
})
export class ProfileImageModule {}
