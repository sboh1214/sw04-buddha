import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { RedisModule } from '../infra/redis/redis.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { MeNotificationsController } from './notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

/**
 * 앱 내 알림함 (#53, ADR-0157): `GET /me/notifications`, `GET /me/notifications/unread-count`,
 * `POST /me/notifications/:id/read` and `POST /me/notifications/read-all`; 알림 수신 설정 (#56,
 * ADR-0162): `GET /me/notifications/settings` and `PUT /me/notifications/settings/:category`. A
 * module of its own: it reads and marks the member's inbox, which @buddha/db's write path fills in
 * the producers' event transactions, and reads and sets the member's 수신 설정
 * (`notification_inboxes.categories_off`, which the producers' gate in @buddha/db reads);
 * RealtimeModule publishes the `user:notification` signal a read mark causes.
 */
@Module({
  imports: [DbModule, RedisModule, AuthModule, RealtimeModule],
  controllers: [MeNotificationsController],
  providers: [NotificationsService],
})
export class NotificationsModule {}
