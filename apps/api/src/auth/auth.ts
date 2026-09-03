import { Logger } from '@nestjs/common';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { type Db, schema } from '@buddha/db';
import { type Env, enabledOAuthProviders, webOrigins } from '../config/env.js';
import { type Mailer } from '../mail/mailer.js';
import {
  changeEmailConfirmationEmail,
  passwordResetEmail,
  verificationEmail,
} from '../mail/templates.js';

/** Injection token for the better-auth instance (see auth.module.ts). */
export const AUTH = Symbol('AUTH');

/** better-auth is mounted at BETTER_AUTH_URL + AUTH_BASE_PATH (PLAN 7: /api/auth/*). */
export const AUTH_BASE_PATH = '/api/auth';

/**
 * PLAN 10.3: Kakao/Naver may withhold the email. better-auth refuses an OAuth sign-in
 * without an email (EMAIL_NOT_FOUND), so the provider's `mapProfileToUser` substitutes a
 * synthetic, unverified address. Such users cannot use email/password until they set a
 * real address (change-email flow below).
 */
export function noEmailFallback(provider: 'kakao' | 'naver', providerAccountId: string): string {
  return `${provider}_${providerAccountId}@noemail.buddha.local`;
}

export interface CreateAuthOptions {
  env: Env;
  db: Db;
  mailer: Mailer;
  logger?: Pick<Logger, 'warn'>;
}

/**
 * Builds the better-auth instance (PLAN 10). Pure factory: no env loading, no Nest, so
 * tests and scripts can build one with another db/mailer.
 */
export function createAuth({ env, db, mailer, logger = new Logger('Auth') }: CreateAuthOptions) {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error('BETTER_AUTH_SECRET is required to create the auth instance');
  const providers = enabledOAuthProviders(env);

  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    basePath: AUTH_BASE_PATH,
    secret,
    // The BETTER_AUTH_URL origin is trusted implicitly (CSRF check on the Origin header);
    // WEB_ORIGIN adds the web origin(s) explicitly (redirectTo/callbackURL validation).
    trustedOrigins: webOrigins(env),
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),

    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      // PLAN 17 Q1 default: the verification mail is sent but not required.
      requireEmailVerification: false,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await mailer.send({ to: user.email, ...passwordResetEmail({ url }) });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      // Verification is optional (PLAN 17 Q1): a mail outage must not fail the sign-up,
      // so this callback logs and swallows; users can request the mail again later.
      sendVerificationEmail: async ({ user, url }) => {
        try {
          await mailer.send({ to: user.email, ...verificationEmail({ url }) });
        } catch (error) {
          logger.warn(`verification mail to ${user.email} failed: ${String(error)}`);
        }
      },
    },

    socialProviders: {
      ...(providers.google ? { google: providers.google } : {}),
      ...(providers.kakao
        ? {
            kakao: {
              ...providers.kakao,
              // The built-in provider maps kakao_account.email, which is undefined when
              // the user withheld consent (email_needs_agreement). mapProfileToUser is
              // spread last by the provider, so these fields win.
              mapProfileToUser: (profile) => ({
                email: profile.kakao_account?.email ?? noEmailFallback('kakao', String(profile.id)),
                // Same conjunction as the built-in provider: Kakao reports is_email_valid=false
                // when the address has since been taken over by another Kakao account.
                emailVerified:
                  !!profile.kakao_account?.email &&
                  !!profile.kakao_account.is_email_valid &&
                  !!profile.kakao_account.is_email_verified,
              }),
            },
          }
        : {}),
      ...(providers.naver
        ? {
            naver: {
              ...providers.naver,
              // The built-in provider always reports emailVerified=false for Naver.
              mapProfileToUser: (profile) => ({
                email: profile.response.email ?? noEmailFallback('naver', profile.response.id),
                emailVerified: false,
              }),
            },
          }
        : {}),
    },

    account: {
      accountLinking: {
        enabled: true,
        // PLAN 10.3: Kakao/Naver emails may differ from (or be absent on) the local user.
        allowDifferentEmails: true,
        // linkSocial() is refused for a provider that is neither trusted nor reporting a
        // verified email; Naver never does and Kakao often not.
        trustedProviders: ['google', 'kakao', 'naver'],
        // Never merge an OAuth identity into an existing user by email match on sign-in:
        // with Kakao/Naver trusted that would be an account-takeover vector. Users link
        // providers from the settings screen while logged in (PLAN 10.3).
        disableImplicitLinking: true,
        // Default false: unlinking the last remaining login method is refused with
        // FAILED_TO_UNLINK_LAST_ACCOUNT (PLAN M1 AC).
        allowUnlinkingAll: false,
      },
    },

    user: {
      changeEmail: {
        enabled: true,
        // A user whose current email is unverified (noemail fallback) may set a real one
        // directly; the new address then receives a verification mail. Verified users go
        // through the confirmation mail to the current address.
        updateEmailWithoutVerification: true,
        sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
          await mailer.send({
            to: user.email,
            ...changeEmailConfirmationEmail({ url, newEmail }),
          });
        },
      },
    },

    // profiles + balances rows are created by the Postgres trigger on "user"
    // (packages/db/drizzle/0002_user_profile_trigger.sql), not by databaseHooks:
    // better-auth runs `user.create.after` after the insert has committed, never inside it.

    // better-auth's built-in limiter keeps state in process memory (PLAN 16 forbids that).
    // TODO(M6): @nestjs/throttler with Redis storage covers /api/auth/* as well (PLAN 7.5).
    rateLimit: { enabled: false },

    advanced: {
      cookiePrefix: 'buddha',
      // better-auth silently skips the Origin/CSRF check when NODE_ENV=test; keep it on so
      // integration tests exercise the same protection as production.
      disableOriginCheck: false,
    },
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;
/** `{ session, user }` as returned by auth.api.getSession(). */
export type SessionData = Auth['$Infer']['Session'];
export type SessionUser = SessionData['user'];
