import { type Mailer } from '../mail/mailer.js';
import { MAIL_TEMPLATES } from '../mail/templates.js';
import { SmsSendError, type SmsSender, type VerificationCodeSms } from './sms-sender.js';

/** The domain the development sender mails to: Mailpit takes any, nothing else is asked to. */
export const DEV_SMS_MAIL_DOMAIN = 'sms.buddha.local';

/** Where the development sender mails a text for `phone` (digits): `sms-01012345678@…`. */
export function devSmsAddress(phone: string): string {
  return `sms-${phone}@${DEV_SMS_MAIL_DOMAIN}`;
}

/**
 * SMS_PROVIDER=dev (ADR-0070): texts nobody. Each code is mailed through the API's own mailer
 * (Mailpit locally) to `devSmsAddress(number)`, so a developer reads it in the Mailpit inbox and
 * the e2e suite finds it the way it finds the sign-up mail. The mail is a registered template
 * (MAIL_TEMPLATES.devVerificationCode), so its words are held to the mail guard. A failed mail is
 * a failed send. The env schema refuses this sender under NODE_ENV=production.
 */
export function createDevSmsSender(mailer: Mailer): SmsSender {
  return {
    async sendVerificationCode(sms: VerificationCodeSms): Promise<void> {
      try {
        await mailer.send({
          to: devSmsAddress(sms.to),
          ...MAIL_TEMPLATES.devVerificationCode({
            code: sms.code,
            expiresInMinutes: sms.expiresInMinutes,
          }),
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : 'error';
        // Development only: a mail the server did not take is read as no send at all, so a
        // developer whose Mailpit is down can retry at once.
        throw new SmsSendError('refused', `dev sender: the mail to Mailpit failed (${name})`);
      }
    },
  };
}
