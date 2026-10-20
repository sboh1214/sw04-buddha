import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { RedisModule } from '../infra/redis/redis.module.js';
import { MediaModule } from '../media/media.module.js';
import { AdminNoticesController, NoticesController } from './notices.controller.js';
import { NoticesService } from './notices.service.js';

/**
 * 운영 공지 (#138): the public pinned list and notice page, and the admins' writes, pins, unpins,
 * records and earlier versions. A notice's images are uploaded and served by MediaModule
 * (`/media`), as a post's — a notice only takes them by id, in its own transaction — and its
 * MediaService serves the admin screens a notice's images, pinned or not.
 */
@Module({
  // Guards are instantiated in the module that declares the controller: DbModule and AuthModule
  // serve SessionGuard and OnboardedGuard, RedisModule AdminGuard's role cache.
  imports: [DbModule, RedisModule, AuthModule, MediaModule],
  controllers: [NoticesController, AdminNoticesController],
  providers: [NoticesService],
})
export class NoticesModule {}
