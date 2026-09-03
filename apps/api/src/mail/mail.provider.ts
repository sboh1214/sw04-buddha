import { type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Env } from '../config/env.js';
import { createMailer, type Mailer } from './mailer.js';

/** Injection token for the SMTP mailer. Tests override it with an in-memory Mailer. */
export const MAILER = Symbol('MAILER');

export const mailerProvider: Provider<Mailer> = {
  provide: MAILER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>): Mailer => {
    const user = config.get('SMTP_USER', { infer: true });
    const pass = config.get('SMTP_PASS', { infer: true });
    // nodemailer connects lazily (one SMTP session per sendMail), so bootstrap never
    // blocks on Mailpit/SES being up.
    return createMailer({
      host: config.get('SMTP_HOST', { infer: true }),
      port: config.get('SMTP_PORT', { infer: true }),
      from: config.get('SMTP_FROM', { infer: true }),
      secure: config.get('SMTP_SECURE', { infer: true }),
      auth: user && pass ? { user, pass } : undefined,
    });
  },
};
