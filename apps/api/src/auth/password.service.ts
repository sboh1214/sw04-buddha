import { Inject, Injectable } from '@nestjs/common';
import { fromNodeHeaders } from 'better-auth/node';
import { type IncomingHttpHeaders } from 'node:http';
import { AppError } from '../common/errors/app-error.js';
import { isApiError } from '../common/errors/better-auth-error.js';
import { AUTH, type Auth } from './auth.js';

/**
 * First password of an account that has none: after verification (ADR-0024 sign-up) or for a
 * social-only user. better-auth's `/set-password` is server-only, so this is the one way in
 * from the browser; it refuses when a password already exists (change it with
 * `/api/auth/change-password`, which requires the current one).
 */
@Injectable()
export class PasswordService {
  constructor(@Inject(AUTH) private readonly auth: Auth) {}

  async setPassword(headers: IncomingHttpHeaders, newPassword: string): Promise<void> {
    try {
      await this.auth.api.setPassword({
        body: { newPassword },
        headers: fromNodeHeaders(headers),
      });
    } catch (error) {
      if (isApiError(error, 'PASSWORD_ALREADY_SET')) {
        throw new AppError('VALIDATION_ERROR', {
          message: 'A password is already set',
          details: [{ path: ['newPassword'], message: 'already set' }],
        });
      }
      throw error;
    }
  }
}
