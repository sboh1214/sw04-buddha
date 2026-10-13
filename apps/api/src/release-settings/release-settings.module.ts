import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { RedisModule } from '../infra/redis/redis.module.js';
import { AdminReleaseSettingsController } from './admin-release-settings.controller.js';
import { releaseSettingsRegistryProvider } from './release-settings.registry.js';
import { ReleaseSettingsService } from './release-settings.service.js';

/**
 * Release settings (#170). Exports the service so the modules that consume an item (#70, #74,
 * #119, …) read it through `ReleaseSettingsService.get`. Guards are instantiated in the module that
 * declares the controller, so DbModule and RedisModule are imported for AdminGuard.
 */
@Module({
  imports: [DbModule, RedisModule, AuthModule],
  controllers: [AdminReleaseSettingsController],
  providers: [releaseSettingsRegistryProvider, ReleaseSettingsService],
  exports: [ReleaseSettingsService],
})
export class ReleaseSettingsModule {}
