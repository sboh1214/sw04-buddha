import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { RateLimitsModule } from '../rate-limit/rate-limit.limits.js';
import { SmsModule } from '../sms/sms.module.js';
import { PhoneVerificationController } from './phone-verification.controller.js';
import { PhoneVerificationService } from './phone-verification.service.js';

/**
 * 본인확인 (#183, ADR-0070): `POST /me/phone-verification/code`, `POST
 * /me/phone-verification/confirm` and `PUT /me/real-name`, over `phone_verifications` and
 * `phone_verification_codes`. Exports the service so the features that need a verified account
 * (#58, #70) ask it — or `isPhoneVerified` (@buddha/db) inside their own transaction. The admin's
 * send counts are AdminSmsStatusModule's.
 */
@Module({
  // RateLimitsModule for UNCOUNTED_PEERS: the client address is named by the rate limit's rule;
  // IdentityModule for the keyed hash the 가입 허용 목록 is kept in (#330, ADR-0174).
  imports: [DbModule, AuthModule, IdentityModule, SmsModule, RateLimitsModule],
  controllers: [PhoneVerificationController],
  providers: [PhoneVerificationService],
  exports: [PhoneVerificationService],
})
export class PhoneVerificationModule {}
