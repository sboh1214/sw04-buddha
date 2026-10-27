import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema, type Db } from '@buddha/db';
import { AUTH_USER_NAME, isNoEmailAddress, setPasswordCallbackURL } from '@buddha/shared';
import { AppError } from '../common/errors/app-error.js';
import { DB } from '../infra/db/db.provider.js';
import { AUTH, type Auth, CREDENTIAL_PROVIDER_ID } from './auth.js';

/**
 * Sign-up (ADR-0024, PLAN 17 Q7): create the user with NO password and mail the
 * verification link. The password is chosen after the link is clicked
 * (`POST /api/v1/me/password`), so the account is worthless to anyone who registers an
 * address they do not own — the account-pre-hijacking class of attack disappears.
 *
 * better-auth has no password-less sign-up, so the user is created through `signUpEmail` with
 * a throwaway secret that never reaches the database: the `account.create.before` hook in
 * auth.ts cancels the credential insert for `/sign-up/email`. The delete below is the
 * backstop for the day that hook stops matching (it is keyed on a route string, and a
 * better-auth upgrade could rename the path) — it should always be a no-op, so it says so
 * when it is not. The response never says whether the address was new (no enumeration).
 */
@Injectable()
export class RegistrationService {
  private readonly logger = new Logger(RegistrationService.name);

  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    @Inject(DB) private readonly db: Db,
  ) {}

  /**
   * `next` (already a path on this origin, `nextPathSchema`) is where the visitor was before
   * signing up (#58, ADR-0069 decision 1 #57-9). It rides in the link's `callbackURL`, so
   * /set-password — wherever the link is opened — sends the account on there, and the onboarding
   * gate from there to its steps and back.
   */
  async register(email: string, next?: string): Promise<void> {
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
        // better-auth requires a name; the account keeps none (AUTH_USER_NAME, the user hooks).
        name: AUTH_USER_NAME,
        callbackURL: setPasswordCallbackURL(next),
      },
    });
    const removed = await this.db
      .delete(schema.account)
      .where(
        and(
          eq(schema.account.userId, user.id),
          eq(schema.account.providerId, CREDENTIAL_PROVIDER_ID),
        ),
      );
    if (removed.rowCount) {
      this.logger.error(
        'the account.create.before hook did not cancel the sign-up credential; a crash between' +
          ' signUpEmail and this delete would strand the account with an unknown password',
      );
    }
  }
}
