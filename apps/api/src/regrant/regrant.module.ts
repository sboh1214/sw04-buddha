import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { RedisModule } from '../infra/redis/redis.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { ReleaseSettingsModule } from '../release-settings/release-settings.module.js';
import { AdminRegrantsController, MeRegrantController } from './regrant.controller.js';
import { RegrantService } from './regrant.service.js';

/**
 * 제한적 재지급 (#74, ADR-0155): `GET` and `POST /me/regrant` and the admins' `GET /admin/regrants`.
 * The six release settings come through ReleaseSettingsModule's registry token, read inside the
 * request's transaction by @buddha/db; RealtimeModule publishes the `user:balance` a grant causes.
 * Guards are instantiated in the module that declares the controller, so DbModule and RedisModule
 * are imported for AdminGuard and OnboardedGuard.
 */
@Module({
  imports: [DbModule, RedisModule, AuthModule, RealtimeModule, ReleaseSettingsModule],
  controllers: [MeRegrantController, AdminRegrantsController],
  providers: [RegrantService],
})
export class RegrantModule {}
