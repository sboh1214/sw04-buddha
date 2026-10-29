import { Logger } from '@nestjs/common';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { verifyJWT } from 'better-auth/crypto';
import { type Db, schema } from '@buddha/db';
import {
  AUTH_USER_NAME,
  DEFAULT_RATE_LIMITS,
  NO_EMAIL_DOMAIN,
  SET_PASSWORD_PATH,
  expectedAccountIdSchema,
  isNoEmailAddress,
  type RateLimits,
} from '@buddha/shared';
import { type Env, enabledOAuthProviders, webOrigins } from '../config/env.js';
import { type Mailer } from '../mail/mailer.js';
import { authRateLimitFor, type AuthRateLimiter } from '../rate-limit/auth-rate-limit.js';
import { emailTracker } from '../rate-limit/email-tracker.js';
import { type EmailContent, MAIL_TEMPLATES } from '../mail/templates.js';
import { otherAccountRefusal } from './expected-account.js';

/** Injection token for the better-auth instance (see auth.module.ts). */
export const AUTH = Symbol('AUTH');

/** better-auth is mounted at BETTER_AUTH_URL + AUTH_BASE_PATH (PLAN 7: /api/auth/*). */
export const AUTH_BASE_PATH = '/api/auth';

/** `account.providerId` of the email+password login method. */
export const CREDENTIAL_PROVIDER_ID = 'credential';

/**
 * Where a verification link lands when the client did not ask for a specific page: the page that
 * asks a freshly verified user for their first password (ADR-0024, `SET_PASSWORD_PATH` of
 * @buddha/shared, which also builds the link that carries the sign-up's `next`, #58).
 */
const DEFAULT_VERIFY_CALLBACK = SET_PASSWORD_PATH;

/**
 * Endpoints that must never accept one of our synthetic no-email addresses. The hook also
 * runs on server-side `auth.api.*` calls, which is all `/sign-up/email` is left to guard
 * now that `disabledPaths` 404s it over HTTP.
 */
const SIGN_IN_PATH = '/sign-in/email';

/** better-auth's own name-and-photo update, refused over HTTP (`disabledPaths` below). */
const UPDATE_USER_PATH = '/update-user';
/** better-auth's read of a linked provider's profile (name, photo), refused the same way. */
const ACCOUNT_INFO_PATH = '/account-info';
/** better-auth's hand-out of a linked provider's stored access token, refused the same way. */
const GET_ACCESS_TOKEN_PATH = '/get-access-token';
/** better-auth's refresh of a linked provider's stored tokens, refused the same way. */
const REFRESH_TOKEN_PATH = '/refresh-token';

/**
 * What the `account` hooks below write on every login account row: none of the provider's tokens
 * (오너 결정 2026-10-19 (2차) 3 for the ID token, (4차) 1 for the access and refresh tokens and their
 * expiry, ADR-0072 7-30). better-auth uses them for nothing but the routes `disabledPaths` refuses.
 */
const NO_PROVIDER_TOKENS = {
  idToken: null,
  accessToken: null,
  refreshToken: null,
  accessTokenExpiresAt: null,
  refreshTokenExpiresAt: null,
} as const;
const PROVIDER_TOKEN_FIELDS = Object.keys(
  NO_PROVIDER_TOKENS,
) as (keyof typeof NO_PROVIDER_TOKENS)[];

/**
 * What the service asks each provider for (오너 결정 2026-10-19 (2차) 3, ADR-0072 7-40): the
 * member identifier and the email address, and not the name or the profile photo it does not
 * keep. better-auth's defaults add Google's `profile` (a name and a photo in the ID token) and
 * Kakao's `profile_nickname` and `profile_image`; `disableDefaultScope` drops them. Google's
 * `openid` brings the ID token better-auth reads the member (`sub`) and the address from, and
 * `email` the address and `email_verified`. Naver takes no scope from the request — its developer
 * console decides what it hands over (ADR-0072 결과 3).
 */
export const OAUTH_SCOPES = {
  google: ['openid', 'email'],
  kakao: ['account_email'],
} as const;
const CHANGE_EMAIL_PATH = '/change-email';
/** better-auth's change of password (MY 설정's password card, which also ends the other sessions). */
const CHANGE_PASSWORD_PATH = '/change-password';
/** better-auth's link of a social login to the session's account (MY 설정's 로그인 수단 card). */
const LINK_SOCIAL_PATH = '/link-social';

/**
 * The better-auth routes a MY 설정 card writes through for the session's account, whose own body
 * names no account: a change of password (and, with `revokeOtherSessions`, every other session of
 * the account ended), the start of a change of address (a confirmation mailed to the account's
 * address), a social login linked to the account. Each takes the account the card was drawn for
 * (`expectedAccountId`), as every owner write of the API does (A-PG-24, ADR-0090·ADR-0091), and
 * `hooks.before` refuses it when the cookie is another account's (`assertScreenAccount`,
 * ADR-0092): in the render between the tab's session naming B and SessionCacheGuard's reset, A's
 * card still stands while the cookie is already B's, and what was typed on A's card would be done
 * to B — B's password changed and B's other sessions ended (when the current password typed is
 * B's too, as one person's two accounts often share one), a confirmation mailed to B's address
 * naming the address typed for A, the provider A picked linked to B.
 *
 * Not `/unlink-account`: it names the login method by its row id, which better-auth looks up among
 * the cookie's account's rows only — a row A's card drew names none of B's, and the answer is a 400
 * that unlinks nothing: FAILED_TO_UNLINK_LAST_ACCOUNT when B has a single login method (checked
 * before the lookup, `allowUnlinkingAll` is off), ACCOUNT_NOT_FOUND when B has more. (A session of
 * B's older than better-auth's `freshAge` is refused before both, SESSION_NOT_FRESH, as any unlink.)
 * Not `/send-verification-email`: with a session it mails the session's account's own address and
 * refuses any other (EMAIL_MISMATCH) — the address on A's card is A's (screen-account.test.ts
 * pins both).
 */
const SCREEN_ACCOUNT_PATHS = new Set([CHANGE_PASSWORD_PATH, CHANGE_EMAIL_PATH, LINK_SOCIAL_PATH]);

/**
 * A request to one of SCREEN_ACCOUNT_PATHS goes on only for the account it names: the cookie's
 * (`sessionUserId`). The field is read from the raw body — a hook runs before the endpoint's schema,
 * which strips a key it does not know — and missing or malformed is the 400 the API's own routes
 * give (`VALIDATION_ERROR` naming the field); another account is the 403 they give
 * (`otherAccountRefusal`). better-auth answers either unwrapped, `{ code, message, details }`.
 */
export function assertScreenAccount(sessionUserId: string, body: unknown): void {
  const named =
    typeof body === 'object' && body !== null
      ? (body as { expectedAccountId?: unknown }).expectedAccountId
      : undefined;
  const parsed = expectedAccountIdSchema.safeParse(named);
  if (!parsed.success) {
    throw new APIError('BAD_REQUEST', {
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: parsed.error.issues.map((issue) => ({
        path: ['expectedAccountId', ...issue.path],
        message: issue.message,
      })),
    });
  }
  if (parsed.data === sessionUserId) return;
  throw new APIError('FORBIDDEN', { code: 'FORBIDDEN', ...otherAccountRefusal() });
}

/**
 * The session token of the request's cookie when its signature is valid — the same read
 * better-auth's `getSession` starts with — or a falsy value when there is no cookie (null) or a
 * forged one (false). Lets the screen-account check tell a request with no session from a signed
 * cookie whose session could not be read (`hooks.before`).
 */
function signedSessionToken(ctx: {
  getSignedCookie: (key: string, secret: string) => Promise<string | null | false>;
  context: { authCookies: { sessionToken: { name: string } }; secret: string };
}): Promise<string | null | false> {
  return ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
}

const EMAIL_INPUT_PATHS = new Set([
  '/sign-up/email',
  SIGN_IN_PATH,
  CHANGE_EMAIL_PATH,
  '/send-verification-email',
  '/request-password-reset',
  '/forget-password',
]);

/**
 * The `email` bucket `/change-email` charges to the ACCOUNT asking, on top of the one it
 * charges to `newEmail`. For a verified account the confirmation goes to the address the
 * account already has (`sendChangeEmailConfirmation` below), and `newEmail` is only mailed
 * later, once that link is clicked — so a key on `newEmail` alone let a caller rotate it and
 * mail their own inbox without limit (PR #8 review). The account, not its current address:
 * the two are one mailbox, and keying on the address under the `/change-email` path would land
 * on the very key a stranger charges by naming that address as THEIR `newEmail` (better-auth
 * answers an address that already exists with a silent 200), which would let anyone lock a
 * user out of changing their email. A path of its own cannot be reached from a request body.
 */
const CHANGE_EMAIL_ACCOUNT_BUCKET = `${CHANGE_EMAIL_PATH}/account`;

/**
 * The one mail-sending path with no address in its body: a GET whose whole input is a token.
 *
 * better-auth's verification links are stateless one-hour JWTs (`createEmailVerificationToken`),
 * and clicking one does not consume it. For a plain sign-up link that is harmless — it verifies
 * an address and mails nobody. The CONFIRMATION half of a change of address is different: every
 * click re-mints the verification token and mails the NEW address again, no session required
 * (the endpoint refuses only a mismatching one). So one confirmation mail in a caller's own inbox
 * was, until this, an hour of mail to somebody else's — the only path around the per-recipient
 * bound the other five carry (Q-M6-8). Counted here, on the address the link is about to mail.
 *
 * Not a single-use token instead: mail scanners prefetch links (Outlook Safe Links, Gmail's
 * proxy), and a link that the first GET consumes is a link the real click finds already spent.
 * The same 5/min bound every other mail path has is what the contract promises, and it is what
 * a replay needs to be denied.
 */
const VERIFY_EMAIL_PATH = '/verify-email';

/** What a verification link carries, as far as the limit reads it (better-auth's payload). */
interface VerificationTokenPayload {
  updateTo?: unknown;
  requestType?: unknown;
}

/**
 * The address a `/verify-email` call is about to MAIL, or `undefined` when it mails nobody.
 *
 * Verified with the same secret the endpoint verifies with, not merely decoded: a payload
 * anybody can forge would be a bucket anybody can spend for free — no account, no request, no
 * mail — and five forged tokens naming an address would refuse the genuine confirmation click
 * for that address a minute at a time. What remains is the flip side every per-recipient bound
 * has: whoever holds a GENUINE link toward X can spend X's bucket by replaying it, at the
 * price of mailing X in their own name (on `/change-email` the price is the caller's own
 * account bucket — five addresses a minute, signed in). A token that fails here fails
 * in the endpoint too (INVALID_TOKEN / TOKEN_EXPIRED), mailing nobody, so it costs nothing;
 * `verifyJWT` accepts a superset of the endpoint's HS256 — the other HMAC sizes, a missing
 * `exp` — and every member of it needs the secret, which is all a bucket key requires. The
 * VERIFICATION half (`change-email-verification`) applies the change and mails nobody either,
 * so the final click of a legitimate change is never counted — and never refused because a
 * stranger has been replaying the other half. Everything else with an `updateTo` mails it: the
 * confirmation, and the legacy single-step token of older better-auth versions.
 */
async function mailedByVerifyEmail(token: unknown, secret: string): Promise<string | undefined> {
  if (typeof token !== 'string' || token.length === 0) return undefined;
  const payload = await verifyJWT<VerificationTokenPayload>(token, secret);
  if (payload === null || payload.requestType === 'change-email-verification') return undefined;
  return emailTracker(payload.updateTo);
}

/** Counts one attempt against `path`'s bucket for `tracker`, refusing it the way PLAN 7 does. */
async function consumeOrRefuse(
  rateLimiter: AuthRateLimiter,
  path: string,
  tracker: string,
  limit: number,
): Promise<void> {
  const retryAfterSeconds = await rateLimiter.consume(path, tracker, limit);
  if (retryAfterSeconds != null) {
    throw new APIError('TOO_MANY_REQUESTS', {
      message: 'Too many requests',
      code: 'RATE_LIMITED',
      retryAfterSeconds,
    });
  }
}

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

/**
 * The `advanced` half that decides whether the session cookie carries a `Domain`.
 *
 * Exported and pure so the contract can be pinned without booting an app: what matters is not
 * that we pass the option but what better-auth DOES with it, and that is a library behaviour
 * an upgrade can change silently (auth-cookie.test.ts reads the resulting attributes back
 * through better-auth's own `getCookies`).
 *
 * `domain` is always explicit. better-auth's fallback when `crossSubDomainCookies` is enabled
 * without one is `new URL(baseURL).hostname` — the WEB host — which reaches no API host at
 * all, so the option would appear to be on while changing nothing that matters.
 */
export function crossSubDomainCookies(domain: string | undefined) {
  return domain === undefined ? {} : { crossSubDomainCookies: { enabled: true, domain } };
}

export interface CreateAuthOptions {
  env: Env;
  db: Db;
  mailer: Mailer;
  /**
   * PLAN 7.5 for the routes better-auth owns. Optional so a unit test can build an instance
   * without Redis; when it is absent those routes are simply unlimited, which is what every
   * build before M6 did.
   */
  rateLimiter?: AuthRateLimiter;
  /** The limits `rateLimiter` counts against; ignored when there is no limiter. */
  rateLimits?: RateLimits;
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
export function createAuth({
  env,
  db,
  mailer,
  rateLimiter,
  rateLimits = DEFAULT_RATE_LIMITS,
  logger = new Logger('Auth'),
}: CreateAuthOptions) {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error('BETTER_AUTH_SECRET is required to create the auth instance');
  const providers = enabledOAuthProviders(env);

  // Assigned right after betterAuth() returns; only called from request handlers, never
  // during construction (a direct self-reference would be circular for TypeScript).
  let resendVerification = async (_email: string, _callbackURL: string): Promise<void> => {
    /* replaced below */
  };

  /** Mails a registered template (MAIL_TEMPLATES) to `to`. */
  async function send(to: string, content: EmailContent) {
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
    /**
     * ADR-0024 holds only while `POST /api/v1/auth/register` is the ONLY sign-up surface.
     * better-auth's own `/sign-up/email` stores a credential password for whatever address
     * the caller names, which re-opens account pre-hijacking: an attacker signs up as the
     * victim, the victim clicks OUR verification mail (or asks for one and clicks that),
     * and from then on the attacker's password logs into the victim's account while the
     * victim's own `/set-password` fails with PASSWORD_ALREADY_SET. Nothing stops a
     * non-browser caller either: better-auth skips the Origin/CSRF check for a request
     * with no cookie, no `Sec-Fetch-*` and no Origin.
     *
     * `disabledPaths` is checked in the HTTP router's `onRequest` only, so the route 404s
     * for the outside world while `auth.api.signUpEmail` — the server-side call
     * RegistrationService makes — still works. Paths are relative to `basePath`.
     *
     * `/update-user` too (오너 결정 2026-10-19 (2차) 3, ADR-0072): all it writes is `user.name`
     * and `user.image` — better-auth's own name and photo, which this service does not keep (a
     * member's name is the nickname, `PATCH /me`) — so it is refused rather than left to answer
     * success while the hooks below keep both columns as they are. And `/account-info`, whose
     * whole answer is the linked provider's profile — the name and photo the service neither
     * asks for (`OAUTH_SCOPES`) nor keeps: read from the stored ID token (Google's, never stored
     * now) or fetched afresh with the stored access token (Kakao's, Naver's). The web never
     * called it.
     *
     * `/get-access-token` and `/refresh-token` too (오너 결정 2026-10-19 (4차) 1, ADR-0072 7-31):
     * they hand the session's account its linked provider's stored access token — the second
     * after refreshing it with the stored refresh token — and the service keeps neither (the
     * `account` hooks below). Signing in, linking and unlinking never read them back; nothing
     * else in better-auth but these two and `/account-info` does. The web never called either.
     */
    disabledPaths: [
      '/sign-up/email',
      UPDATE_USER_PATH,
      ACCOUNT_INFO_PATH,
      GET_ACCESS_TOKEN_PATH,
      REFRESH_TOKEN_PATH,
    ],
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
        await send(user.email, MAIL_TEMPLATES.passwordReset({ url }));
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
        await send(user.email, MAIL_TEMPLATES.verification({ url }));
      },
    },

    socialProviders: {
      ...(providers.google
        ? {
            google: {
              ...providers.google,
              disableDefaultScope: true,
              scope: [...OAUTH_SCOPES.google],
            },
          }
        : {}),
      ...(providers.kakao
        ? {
            kakao: {
              ...providers.kakao,
              disableDefaultScope: true,
              scope: [...OAUTH_SCOPES.kakao],
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
        // Because the first branch mails the CURRENT address, the `hooks.before` limit counts
        // the account asking as well as `newEmail` (CHANGE_EMAIL_ACCOUNT_BUCKET).
        updateEmailWithoutVerification: false,
        sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
          await send(user.email, MAIL_TEMPLATES.changeEmailConfirmation({ url, newEmail }));
        },
      },
    },

    databaseHooks: {
      /**
       * A social login's provider name and profile photo are not stored (오너 결정 2026-10-19 (2차)
       * 3, ADR-0072; #37-6 '소셜 로그인 사진은 쓰지 않는다'): better-auth copies the provider's
       * `name` and `image` into the `user` row on a social sign-up (`handleOAuthUserInfo`), and on a
       * later sign-in or link when told to (`overrideUserInfoOnSignIn`, `updateUserInfoOnLink`,
       * both off here). Every account is created with AUTH_USER_NAME and no image, whatever the
       * sign-up passed — the email sign-up's name, a provider's — and any update that names either
       * column writes the same instead (an update hook can replace values, not drop keys): an
       * upgrade or an option turned on later cannot refill them. better-auth's `/update-user`,
       * which writes nothing else, is disabled above. The provider's ID token, which carries them
       * too, is kept out of `account` below, and so are its access and refresh tokens.
       */
      user: {
        create: {
          before: (user) =>
            Promise.resolve({ data: { ...user, name: AUTH_USER_NAME, image: null } }),
        },
        update: {
          before: (data) =>
            Promise.resolve({
              data: {
                ...(data.name !== undefined ? { name: AUTH_USER_NAME } : {}),
                ...(data.image !== undefined ? { image: null } : {}),
              },
            }),
        },
      },
      /**
       * None of the provider's tokens is stored either (ADR-0072 7-30). better-auth copies them
       * into `account` as they came — on a social sign-up, on a link, and again on every later
       * sign-in (`updateAccountOnSignIn`) and token refresh:
       * - the ID token (오너 결정 2026-10-19 (2차) 3): Google's is a readable JWT whose payload
       *   carries the member's name and photo address (`name`, `picture`) whenever the `profile`
       *   scope was granted;
       * - the access and refresh tokens and their expiry (오너 결정 2026-10-19 (4차) 1): a standing
       *   key to the member's provider account, kept in plain text (`encryptOAuthTokens` is off).
       * Every account is created with none (`NO_PROVIDER_TOKENS`) and any update that names one
       * writes none (an update hook replaces values, it cannot drop keys). Nothing the service
       * serves reads them back: a sign-in or a link reads the provider's answer from the tokens
       * of the callback's own token response (Google's `getUserInfo` decodes that ID token, Kakao's
       * and Naver's ask with that access token); unlinking deletes the row and revokes nothing; no
       * provider here signs out through the ID token (`createEndSessionURL`); better-auth's own
       * sessions are its `session` rows. Only `/get-access-token`, `/refresh-token` and
       * `/account-info` read them, and `disabledPaths` refuses all three.
       */
      account: {
        create: {
          /**
           * ADR-0024: sign-up must leave NO password behind. better-auth has no password-less
           * sign-up, so RegistrationService calls `signUpEmail` with a throwaway secret;
           * cancelling the credential insert means the row is never written at all, instead
           * of being removed by a second statement that a crash or a dead connection can
           * skip. A leftover could not be repaired on retry — better-auth answers an existing
           * address with a synthetic user id, so a delete keyed on it matches nothing — and
           * the account would be stuck with a password nobody knows, failing /set-password
           * with PASSWORD_ALREADY_SET.
           *
           * Returning `false` cancels the create (better-auth `createWithHooks`), and
           * `signUpEmail` ignores what `linkAccount` returns. Scoped to `/sign-up/email`, so
           * /set-password, password reset and social linking still create their accounts — each
           * without a provider token.
           */
          before: (account, context) =>
            Promise.resolve(
              context?.path === '/sign-up/email' && account.providerId === CREDENTIAL_PROVIDER_ID
                ? false
                : { data: { ...account, ...NO_PROVIDER_TOKENS } },
            ),
        },
        update: {
          before: (data) =>
            Promise.resolve({
              data: Object.fromEntries(
                PROVIDER_TOKEN_FIELDS.filter((field) => data[field] !== undefined).map((field) => [
                  field,
                  null,
                ]),
              ),
            }),
        },
      },
    },

    /**
     * The synthetic no-email domain belongs to the server, not to users: nobody may sign up
     * with one, change their address to one, or trigger mail for one. Otherwise a stranger
     * could claim `kakao_<id>@noemail.buddha.local` before that Kakao user ever signs in.
     *
     * The `before` hook is also where the MY 설정 writes that name the account on screen
     * (SCREEN_ACCOUNT_PATHS) are refused when the cookie is another account's (ADR-0092), and
     * where the routes Nest never sees are rate limited (PLAN 7.5).
     */
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // A hook runs for server-side `auth.api.*` calls too, and those must not spend a
        // user-facing budget: `POST /api/v1/auth/register` already carries its own
        // `@RateLimit('email')` and then calls `auth.api.signUpEmail`, which would count the one
        // registration a second time — and `onExistingUserSignUp` calls
        // `auth.api.sendVerificationEmail` for a third. A call with no `request` did not come
        // from the network; whatever did is already limited at its own door.
        const overHttp = ctx.request !== undefined;
        // The session the cookie names, read at most once per request: the screen-account check
        // below and `/change-email`'s account bucket both ask for it. The session is not on
        // `ctx.context` yet in a before-hook (dispatch sets it to null); this reads the cookie
        // itself. A missing or forged cookie fails the HMAC check before any DB access, so an
        // unauthenticated flood costs a hash; a validly signed one costs a `findSession`, as the
        // endpoint's own session middleware does (the two sensitive routes read it again,
        // authoritatively). `disableRefresh`: a check must not renew a session, and a `Set-Cookie`
        // minted here would not reach the response anyway.
        let sessionRead: ReturnType<typeof getSessionFromCtx> | undefined;
        const cookieSession = () =>
          (sessionRead ??= getSessionFromCtx(ctx, { disableRefresh: true }));
        if (overHttp && SCREEN_ACCOUNT_PATHS.has(ctx.path)) {
          // First, before anything else the hook or the endpoint does (ADR-0092): a refused
          // change of address spends no budget and mails nobody, a refused change of password
          // reads no credential, hashes nothing and ends no session, a refused link mints no OAuth
          // state. No cookie, or a forged one: the endpoint's own middleware answers 401 — as the
          // API's SessionGuard answers before a body is validated — and `/change-email` counts
          // nothing.
          const session = await cookieSession();
          if (session) {
            assertScreenAccount(session.user.id, ctx.body);
          } else if (await signedSessionToken(ctx)) {
            // A validly signed cookie that named no session: either the session is gone (signed
            // out, expired), where the endpoint answers this same 401, or the read FAILED —
            // `getSessionFromCtx` turns every error of `getSession` (a dropped connection, a
            // timeout in `findSession`) into null. Falling through would let the endpoint read the
            // session again a moment later and, if that read succeeds, act on it unchecked: B's
            // password changed for A's card. So the hook answers the endpoint's 401 itself
            // (`UNAUTHORIZED`, better-auth's session middleware's), nothing done (ADR-0092 결정 3).
            throw new APIError('UNAUTHORIZED', { code: 'UNAUTHORIZED', message: 'Unauthorized' });
          }
        }
        if (ctx.path === VERIFY_EMAIL_PATH) {
          // No body to reject a synthetic address in and nothing else to check: the link is
          // the whole request. Counted on the address it mails (mailedByVerifyEmail).
          if (!overHttp || rateLimiter === undefined) return;
          const token = (ctx.query as { token?: unknown } | undefined)?.token;
          const recipient = await mailedByVerifyEmail(token, ctx.context.secret);
          if (recipient === undefined) return;
          await consumeOrRefuse(
            rateLimiter,
            ctx.path,
            recipient,
            authRateLimitFor(ctx.path, rateLimits),
          );
          return;
        }
        if (!EMAIL_INPUT_PATHS.has(ctx.path)) return;
        // The ONE field the path reads — `newEmail` on `/change-email`, `email` everywhere
        // else — and never both. A hook runs on the raw body, before the endpoint's schema
        // strips the keys it does not know, so reading both fields let a signed-in caller send
        // `{ newEmail: X, email: Y }` and spend two recipient keys per request: the account
        // bound below is five ADDRESSES a minute only if a request names one address.
        const body = ctx.body as { email?: unknown; newEmail?: unknown } | undefined;
        const value = ctx.path === CHANGE_EMAIL_PATH ? body?.newEmail : body?.email;
        if (typeof value === 'string' && isNoEmailAddress(value)) {
          throw new APIError('BAD_REQUEST', {
            message: 'This email address cannot be used',
            code: 'INVALID_EMAIL',
          });
        }
        const address = emailTracker(value);
        // PLAN 7.5 for the routes Nest never sees (rate-limit/auth-rate-limit.ts explains why
        // this is the hook and not a guard). Checked AFTER the address has been accepted as a
        // real one and BEFORE better-auth verifies a password or sends anything.
        //
        // EVERY unauthenticated path counts the attempt here, `/sign-in/email` included. On the
        // mail paths the attempt IS the harm — each one puts mail in somebody's inbox. On
        // sign-in it is the scrypt: better-auth hashes the submitted password even for an
        // address that does not exist, so an uncounted attempt is an unconditional one anybody
        // can ask for. What makes sign-in different is the after-hook below, which CLEARS the
        // bucket once the password turns out to have been right.
        if (!overHttp || rateLimiter === undefined) return;
        const limit = authRateLimitFor(ctx.path, rateLimits);
        const consume = (path: string, tracker: string) =>
          consumeOrRefuse(rateLimiter, path, tracker, limit);
        if (ctx.path === CHANGE_EMAIL_PATH) {
          // The one path that REQUIRES a session, so nothing is counted without one: a request
          // the endpoint is about to refuse 401 mails nobody, and counting it would let anyone
          // — no account, no cookie — spend five requests naming X and refuse every genuine
          // change to X for a minute (PR #8 review; the same free lockout Q-M6-8 closed for
          // forged tokens). The session is the one the screen-account check above read
          // (`cookieSession`): by here the request named that account, the one counted.
          const session = await cookieSession();
          if (!session) return;
          // The ACCOUNT first (CHANGE_EMAIL_ACCOUNT_BUCKET), then `newEmail`: a caller whose
          // own five are spent is refused before touching anyone else's recipient key, so one
          // account can name at most five addresses a minute — the bound that makes the
          // recipient key a cost rather than a free lockout. Keyed on the user id, so the
          // account's OWN address never meets the synthetic-address rejection above: an
          // unverified Kakao/Naver account's current address is one of ours, and `/change-email`
          // is exactly how it registers a real one (auth.test.ts). Two INCRs, not one
          // transaction — a refusal by the second leaves the first spent, which is the attempt
          // being counted rather than the outcome.
          await consume(CHANGE_EMAIL_ACCOUNT_BUCKET, session.user.id);
        }
        if (address !== undefined) await consume(ctx.path, address);
      }),
      /**
       * The other half of the sign-in limit: a sign-in that SUCCEEDED clears the bucket.
       *
       * `ctx.context.returned` is what the endpoint answered — and better-auth catches a thrown
       * `APIError` and puts it there before running these hooks (`api/dispatch.mjs`), so a wrong
       * password arrives as an `APIError` instance rather than as a rejection, and anything else
       * means the password was right.
       *
       * Clearing here rather than not counting in the first place is what keeps the count
       * atomic — see `AuthRateLimiter.reset`.
       */
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== SIGN_IN_PATH || ctx.request === undefined) return;
        if (ctx.context.returned instanceof APIError) return;
        const address = emailTracker((ctx.body as { email?: unknown } | undefined)?.email);
        if (address === undefined) return;
        await rateLimiter?.reset(ctx.path, address);
      }),
    },

    // profiles + balances rows are created by the Postgres trigger on "user"
    // (packages/db/drizzle/0002_user_profile_trigger.sql), not by databaseHooks:
    // better-auth runs `user.create.after` after the insert has committed, never inside it.

    // The built-in limiter stays off: it keeps state in process memory (PLAN 16 forbids that)
    // and counts by IP, which behind the Next rewrite is one socket for every visitor
    // (rate-limit.tracker.ts). M6's answer is the `hooks.before` above — same Redis, same `rl:`
    // namespace as the HTTP guard, keyed on the ADDRESS the request names (and, on
    // `/change-email`, on the account asking — first, and only when there is one).
    rateLimit: { enabled: false },

    advanced: {
      cookiePrefix: 'buddha',
      // better-auth silently skips the Origin/CSRF check when NODE_ENV=test; keep it on so
      // integration tests exercise the same protection as production.
      disableOriginCheck: false,
      /**
       * Only when `AUTH_COOKIE_DOMAIN` names one (ADR-0017 추기). Unset, the cookie carries no
       * `Domain` and is host-only, which is what every environment has today and what local
       * development needs — `localhost:3000` and `localhost:4000` are the SAME host, ports
       * being no part of a cookie's identity.
       *
       * A deployment that splits web and API across hosts needs it: the login cookie is minted
       * through the WEB host (the Next rewrite proxies `/api/auth/*` server-side) while the
       * Socket.IO client dials the API host directly, and same-site is not the same thing as
       * same-host. `domain` is passed explicitly and never left to better-auth, whose fallback
       * is `new URL(baseURL).hostname` — the web host, which reaches no API host at all. Only
       * `Domain` is added: SameSite stays `lax` and the `__Secure-` prefix (https) permits a
       * `Domain`, unlike `__Host-`.
       */
      ...crossSubDomainCookies(env.AUTH_COOKIE_DOMAIN),
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
