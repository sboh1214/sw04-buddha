import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { MediaModule } from '../media/media.module.js';
import { MeClosureController } from './account-closure.controller.js';
import { AccountClosureService } from './account-closure.service.js';

/**
 * 탈퇴 (#140, ADR-0086): `GET` and `POST /me/closure`. A module of its own: the closure reaches
 * across the account's rows — the ledger, the profile, the media store (MediaModule's
 * OBJECT_STORAGE, for the profile image), sign-in, and the two-person requests about the member
 * (ApprovalsModule) — and owns none of them.
 */
@Module({
  imports: [DbModule, AuthModule, MediaModule, ApprovalsModule],
  controllers: [MeClosureController],
  providers: [AccountClosureService],
})
export class AccountClosureModule {}
