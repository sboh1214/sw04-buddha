import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema, type Db } from '@buddha/db';
import { isNoEmailAddress } from '@buddha/shared';
import { AppError } from '../common/errors/app-error.js';
import { DB } from '../infra/db/db.provider.js';
import { AUTH, type Auth, CREDENTIAL_PROVIDER_ID, SET_PASSWORD_PATH } from './auth.js';

/**
 * Sign-up (ADR-0024, PLAN 17 Q7): create the user with NO password and mail the
 * verification link. The password is chosen after the link is clicked
 * (`POST /api/v1/me/password`), so the account is worthless to anyone who registers an
 * address they do not own — the account-pre-hijacking class of attack disappears.
 *
 * better-auth has no password-less sign-up, so the user is created through `signUpEmail`
 * with a throwaway secret and the credential row is deleted immediately afterwards. The
 * response never says whether the address was new (no enumeration).
 */
@Injectable()
export class RegistrationService {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(DB) private readonly db: Db,
  ) {}

  async register(email: string): Promise<void> {
    const address = email.trim().toLowerCase();
    if (isNoEmailAddress(address)) {
      throw new AppError('VALIDATION_ERROR', {
        message: 'This email address cannot be used',
        details: [{ path: ['email'], message: 'reserved domain' }],
      });
    }
    // For an address that already exists better-auth answers with a synthetic user (same
    // shape, random id) and `onExistingUserSignUp` re-sends the link; the delete below then
    // matches nothing, so an existing account is never touched.
    const { user } = await this.auth.api.signUpEmail({
      body: {
        email: address,
        password: randomBytes(24).toString('base64url'),
        name: address.split('@')[0] ?? address,
        callbackURL: SET_PASSWORD_PATH,
      },
    });
    await this.db
      .delete(schema.account)
      .where(
        and(
          eq(schema.account.userId, user.id),
          eq(schema.account.providerId, CREDENTIAL_PROVIDER_ID),
        ),
      );
  }
}
