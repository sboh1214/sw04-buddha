import { Logger } from '@nestjs/common';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { type Db, schema } from '@buddha/db';
import { NO_EMAIL_DOMAIN, isNoEmailAddress } from '@buddha/shared';
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

/** `account.providerId` of the email+password login method. */
export const CREDENTIAL_PROVIDER_ID = 'credential';

/** Page that asks a freshly verified user for their first password (ADR-0024). */
export const SET_PASSWORD_PATH = '/set-password';

/** Where a verification link lands when the client did not ask for a specific page. */
const DEFAULT_VERIFY_CALLBACK = SET_PASSWORD_PATH;

/** Endpoints that must never accept one of our synthetic no-email addresses. */
const EMAIL_INPUT_PATHS = new Set([
  '/sign-up/email',
  '/sign-in/email',
  '/change-email',
  '/send-verification-email',
  '/request-password-reset',
  '/forget-password',
]);

/**
 * PLAN 10.3: Kakao/Naver may withhold the email. better-auth refuses an OAuth sign-in
 * without an email (EMAIL_NOT_FOUND), so the provider's `mapProfileToUser` substitutes a
 * synthetic, unverified address (PLAN 17 Q5 decision 2026-09-03: the provider email is
 * recorded when given; the user registers a real address later through the verified
 * change-email flow below). No mail is ever sent to these addresses, and the before-hook
 * keeps anyone from claiming one through the credential endpoints.
 */
export function noEmailFallback(provider: 'kakao' | 'naver', providerAccountId: string): string {
  return `${provider}_${providerAccountId}@${NO_EMAIL_DOMAIN}`;
}

export interface CreateAuthOptions {
  env: Env;
  db: Db;
  mailer: Mailer;
  logger?: Pick<Logger, 'warn' | 'error'>;
}

/** The part of a sign-up request body the hooks read, when the body is still readable. */
interface SignUpBody {
  callbackURL?: unknown;
}

/**
 * Builds the better-auth instance (PLAN 10). Pure factory: no env loading, no Nest, so
 * tests and scripts can build one with another db/mailer.
 */
export function createAuth({ env, db, mailer, logger = new Logger('Auth') }: CreateAuthOptions) {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error('BETTER_AUTH_SECRET is required to create the auth instance');
  const providers = enabledOAuthProviders(env);

  // Assigned right after betterAuth() returns; only called from request handlers, never
  // during construction (a direct self-reference would be circular for TypeScript).
  let resendVerification = async (_email: string, _callbackURL: string): Promise<void> => {
    /* replaced below */
  };

  async function send(to: string, content: { subject: string; text: string; html?: string }) {
    // Synthetic Kakao/Naver addresses cannot receive mail (and would bounce at SES).
    if (isNoEmailAddress(to)) return;
    try {
      await mailer.send({ to, ...content });
    } catch (error) {
      // better-auth calls most mail callbacks inside runInBackgroundOrAwait, which swallows
      // rejections, so this log is the only trace on those paths (see ADR-0023). The
      // rejection is still propagated for POST /send-verification-email, the one endpoint
      // that reports a send failure to the client.
      logger.error(`mail to ${to} failed: ${String(error)}`);
      throw error;
    }
  }

  const auth = betterAuth({
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
      // PLAN 17 Q1 decision (2026-09-03): verification is enforced at sign-up. Sign-up
      // creates the user, mails the link and returns no session; a duplicate email gets
      // the same generic response (no enumeration); sign-in before verification is 403
      // EMAIL_NOT_VERIFIED. The link verifies the address and signs the user in.
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await send(user.email, passwordResetEmail({ url }));
      },
      /**
       * Registering an address that already has an UNVERIFIED account just mails the link
       * again: there is no password to overwrite (ADR-0024 creates the account without one)
       * and the answer must not reveal that the address exists. Verified accounts are left
       * alone; their owner uses the login screen.
       */
      onExistingUserSignUp: async ({ user }, request) => {
        if (user.emailVerified) return;
        const body = await readJsonBody(request);
        const callbackURL =
          typeof body?.callbackURL === 'string' ? body.callbackURL : DEFAULT_VERIFY_CALLBACK;
        await resendVerification(user.email, callbackURL);
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      // Not sendOnSignIn: that mail would carry the sign-in request's callbackURL (which the
      // client cannot set without also turning the successful login into a full-page
      // redirect), so the web calls /send-verification-email itself after a 403 and can
      // report a send failure (ADR-0023).
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await send(user.email, verificationEmail({ url }));
      },
    },

    socialProviders: {
      ...(providers.google ? { google: providers.google } : {}),
      ...(providers.kakao
        ? {
            kakao: {
              ...providers.kakao,
              // The built-in provider maps kakao_account.email, which is undefined when
              // the user withheld consent (email_needs_agreement); mapProfileToUser is
              // spread last by the provider, so these fields win.
              // PLAN 17 Q6 decision (2026-09-03): an address the provider hands us counts
              // as verified even when Kakao's own is_email_verified is false.
              mapProfileToUser: (profile) => ({
                email: profile.kakao_account?.email ?? noEmailFallback('kakao', String(profile.id)),
                emailVerified: !!profile.kakao_account?.email,
              }),
            },
          }
        : {}),
      ...(providers.naver
        ? {
            naver: {
              ...providers.naver,
              // The built-in provider always reports emailVerified=false for Naver; the
              // owner's decision (PLAN 17 Q6) is to trust the provider's address instead.
              mapProfileToUser: (profile) => ({
                email: profile.response.email ?? noEmailFallback('naver', profile.response.id),
                emailVerified: !!profile.response.email,
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
        // providers from the settings screen while logged in (PLAN 10.3; owner accepted
        // this UX on 2026-09-03, PLAN 17 Q4).
        disableImplicitLinking: true,
        // Default false: unlinking the last remaining login method is refused with
        // FAILED_TO_UNLINK_LAST_ACCOUNT (PLAN M1 AC).
        allowUnlinkingAll: false,
      },
    },

    user: {
      changeEmail: {
        enabled: true,
        // PLAN 17 Q5 decision (2026-09-03): an address only changes after it is verified.
        // - current email verified: confirmation link to the current address, then a
        //   verification link to the new one (sendChangeEmailConfirmation -> verify-email)
        // - current email unverified (synthetic Kakao/Naver address or an unverified real
        //   one): a verification link to the new address; clicking it applies the change
        // A new address that already belongs to another user gets the same 200 without mail.
        updateEmailWithoutVerification: false,
        sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
          await send(user.email, changeEmailConfirmationEmail({ url, newEmail }));
        },
      },
    },

    /**
     * The synthetic no-email domain belongs to the server, not to users: nobody may sign up
     * with one, change their address to one, or trigger mail for one. Otherwise a stranger
     * could claim `kakao_<id>@noemail.buddha.local` before that Kakao user ever signs in.
     */
    hooks: {
      before: createAuthMiddleware((ctx) => {
        if (!EMAIL_INPUT_PATHS.has(ctx.path)) return Promise.resolve();
        const body = ctx.body as { email?: unknown; newEmail?: unknown } | undefined;
        for (const value of [body?.email, body?.newEmail]) {
          if (typeof value === 'string' && isNoEmailAddress(value)) {
            throw new APIError('BAD_REQUEST', {
              message: 'This email address cannot be used',
              code: 'INVALID_EMAIL',
            });
          }
        }
        return Promise.resolve();
      }),
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

  resendVerification = async (email, callbackURL) => {
    await auth.api.sendVerificationEmail({ body: { email, callbackURL } });
  };

  return auth;
}

/** Parses the JSON body of the request copy better-auth hands to a hook, if it still has one. */
async function readJsonBody(request: Request | undefined): Promise<SignUpBody | undefined> {
  if (!request) return undefined;
  try {
    return (await request.json()) as SignUpBody;
  } catch {
    return undefined;
  }
}

export type Auth = ReturnType<typeof createAuth>;
/** `{ session, user }` as returned by auth.api.getSession(). */
export type SessionData = Auth['$Infer']['Session'];
export type SessionUser = SessionData['user'];
