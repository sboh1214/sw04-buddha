import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { MeController } from './me.controller.js';
import { MeService } from './me.service.js';
import { NicknameService } from './nickname.service.js';

@Module({
  // IdentityModule: `Me.startGrant` says when the account's number already got its start Coin,
  // which takes the number's keyed hash. Not StartGrantModule: it would register the release
  // settings' admin routes earlier and reorder the OpenAPI document.
  imports: [DbModule, AuthModule, IdentityModule],
  controllers: [MeController],
  providers: [MeService, NicknameService],
  // The onboarding (#58) answers with `Me` and sets the nickname through the same rules.
  exports: [MeService, NicknameService],
})
export class MeModule {}
