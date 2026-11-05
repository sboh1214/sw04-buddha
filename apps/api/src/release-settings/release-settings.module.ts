import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { RedisModule } from '../infra/redis/redis.module.js';
import { AdminReleaseSettingsController } from './admin-release-settings.controller.js';
import {
  RELEASE_SETTINGS_REGISTRY,
  releaseSettingsRegistryProvider,
} from './release-settings.registry.js';
import { ReleaseSettingsService } from './release-settings.service.js';

/**
 * Release settings (#170). Exports the service so the modules that consume an item (#70, #74,
 * #119, …) read it through `ReleaseSettingsService.get`, and the registry token for work that reads
 * an item inside @buddha/db (#119's `placeOrder` reads `order.accepting` in its transaction).
 * Guards are instantiated in the module that declares the controller, so DbModule and RedisModule
 * are imported for AdminGuard.
 */
@Module({
  imports: [DbModule, RedisModule, AuthModule],
  controllers: [AdminReleaseSettingsController],
  providers: [releaseSettingsRegistryProvider, ReleaseSettingsService],
  exports: [ReleaseSettingsService, RELEASE_SETTINGS_REGISTRY],
})
export class ReleaseSettingsModule {}
