import { Module } from '@nestjs/common';
import { MailModule } from '../mail/mail.module.js';
import { SMS_SENDER } from './sms-sender.js';
import { smsSenderProvider } from './sms.provider.js';

/** The SMS sender of 본인확인 (ADR-0070). The mail module is for the development sender. */
@Module({
  imports: [MailModule],
  providers: [smsSenderProvider],
  exports: [SMS_SENDER],
})
export class SmsModule {}
