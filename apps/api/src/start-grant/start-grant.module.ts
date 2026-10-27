import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { ReleaseSettingsModule } from '../release-settings/release-settings.module.js';
import { StartGrantService } from './start-grant.service.js';

/**
 * 시작 지급 (#70, ADR-0071). No controller on purpose: the grant has no externally reachable
 * route. The onboarding (#58) imports this module and calls `StartGrantService.grant` once it has
 * confirmed the three steps on the server.
 */
@Module({
  imports: [DbModule, ReleaseSettingsModule, IdentityModule, RealtimeModule],
  providers: [StartGrantService],
  exports: [StartGrantService],
})
export class StartGrantModule {}
