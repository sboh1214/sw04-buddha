import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { MeModule } from '../me/me.module.js';
import { RateLimitsModule } from '../rate-limit/rate-limit.limits.js';
import { StartGrantModule } from '../start-grant/start-grant.module.js';
import { OnboardedGuard } from './onboarded.guard.js';
import { OnboardingController } from './onboarding.controller.js';
import { OnboardingService } from './onboarding.service.js';

/**
 * 가입 직후 온보딩 (#58, ADR-0072): `POST /me/consents`, `POST /me/onboarding/nickname` (the one
 * caller of the start grant, #70), `POST /me/onboarding/interests` (the interests step) and MY
 * 설정's `PUT /me/interest-categories` (#41, ADR-0078). Exports `OnboardedGuard`, the
 * check every action #57-8 keeps from an account that has not finished (#46…#77).
 */
@Module({
  // RateLimitsModule for UNCOUNTED_PEERS: the consent's client address is the rate limit's reading.
  imports: [DbModule, AuthModule, MeModule, StartGrantModule, RateLimitsModule],
  controllers: [OnboardingController],
  providers: [OnboardingService, OnboardedGuard],
  exports: [OnboardingService, OnboardedGuard],
})
export class OnboardingModule {}
