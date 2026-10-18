import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DbModule } from '../infra/db/db.module.js';
import { SmsModule } from '../sms/sms.module.js';
import { PhoneVerificationController } from './phone-verification.controller.js';
import { PhoneVerificationService } from './phone-verification.service.js';

/**
 * 본인확인 (#183, ADR-0070): `POST /me/phone-verification/code`, `POST
 * /me/phone-verification/confirm` and `PUT /me/real-name`, over `phone_verifications` and
 * `phone_verification_codes`. Exports the service so the features that need a verified account
 * (#58, #70) ask it — or `isPhoneVerified` (@buddha/db) inside their own transaction.
 */
@Module({
  imports: [DbModule, AuthModule, SmsModule],
  controllers: [PhoneVerificationController],
  providers: [PhoneVerificationService],
  exports: [PhoneVerificationService],
})
export class PhoneVerificationModule {}
