import { Logger, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { aligoCredentials, type Env, smsProvider } from '../config/env.js';
import { MAILER } from '../mail/mail.provider.js';
import { type Mailer } from '../mail/mailer.js';
import { createAligoSmsSender } from './aligo-sms-sender.js';
import { createDevSmsSender } from './dev-sms-sender.js';
import { SMS_SENDER, type SmsSender } from './sms-sender.js';

/**
 * The configured SmsSender (SMS_PROVIDER, config/env.ts): 알리고, or the development sender that
 * mails each code to Mailpit. 알리고 without its keys still boots — the owner's decision for a
 * deployment without them is that verification fails, not the API — and says so once here, so
 * the log explains every SMS_SEND_FAILED that follows.
 */
export const smsSenderProvider: Provider<SmsSender> = {
  provide: SMS_SENDER,
  inject: [ConfigService, MAILER],
  useFactory: (config: ConfigService<Env, true>, mailer: Mailer): SmsSender => {
    const provider = smsProvider({
      NODE_ENV: config.get('NODE_ENV', { infer: true }),
      SMS_PROVIDER: config.get('SMS_PROVIDER', { infer: true }),
    });
    if (provider === 'dev') return createDevSmsSender(mailer);
    const credentials = aligoCredentials({
      ALIGO_API_KEY: config.get('ALIGO_API_KEY', { infer: true }),
      ALIGO_USER_ID: config.get('ALIGO_USER_ID', { infer: true }),
      ALIGO_SENDER: config.get('ALIGO_SENDER', { infer: true }),
    });
    if (credentials === undefined) {
      new Logger('SmsSender').warn(
        'SMS_PROVIDER is aligo but ALIGO_API_KEY, ALIGO_USER_ID and ALIGO_SENDER are not set: ' +
          'every verification code send will fail',
      );
    }
    return createAligoSmsSender({
      credentials,
      testMode: config.get('ALIGO_TEST_MODE', { infer: true }),
    });
  },
};
