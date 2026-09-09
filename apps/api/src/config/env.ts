import path from 'node:path';
import { DISPUTE_WINDOW_SECONDS_DEFAULT } from '@buddha/shared';
import { config as loadDotenv } from 'dotenv';
import * as z from 'zod';

/**
 * .env candidates, first match wins per key: apps/api/.env (local override), then the
 * repo-root .env (PLAN 15). Resolved from this module so they are the same files from
 * src/ (`nest start --watch`) and dist/ (`node dist/main.js`), whatever the cwd is.
 */
export const envFilePaths = [
  path.resolve(import.meta.dirname, '../../.env'),
  path.resolve(import.meta.dirname, '../../../../.env'),
];

/**
 * Optional string: an unset key and an empty value (`GOOGLE_CLIENT_ID=` in .env.example)
 * both become `undefined`, so "leave empty to disable" works.
 */
const optionalString = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  });

/**
 * RFC 5322 mailbox: a bare `addr@host`, or the `<addr@host>` of `Name <addr@host>`. Only the
 * address is checked — the display name may be quoted or Korean, and nodemailer MIME-encodes
 * it — and it is checked with zod's own email format rather than a hand-rolled one.
 *
 * Worth validating at bootstrap because nodemailer degrades silently: a value with no
 * parseable address (`SMTP_FROM=foo`) yields a message with no usable From header, which a
 * real provider refuses, and better-auth swallows the resulting send failure on sign-up
 * (ADR-0023). Without this the API starts happily with a permanently dead mail pipeline.
 */
const mailbox = z.string().refine(
  (value) => {
    const trimmed = value.trim();
    const address = /<([^<>]*)>$/.exec(trimmed)?.[1] ?? trimmed;
    return z.email().safeParse(address.trim()).success;
  },
  { error: 'must be an email address or `Name <address>`' },
);

export const OAUTH_PROVIDERS = ['google', 'kakao', 'naver'] as const;
export type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

/**
 * Environment schema for apps/api. Validated once at bootstrap by
 * `ConfigModule.forRoot({ validationSchema: envSchema })` (Standard Schema);
 * an invalid environment aborts startup with a readable error.
 *
 * `ConfigService.get(key, { infer: true })` returns the parsed value (numbers are numbers,
 * empty optional strings are undefined): @nestjs/config merges the schema output over the
 * raw values.
 */
/**
 * Whether a cookie `Domain` would be sent to `host` — RFC 6265 domain-matching, which is either
 * equality or `host` being a sub-domain of it.
 *
 * Compared LABEL-WISE, and that is the whole care in it: a plain `endsWith` makes `example.com`
 * cover `badexample.com`, which is the mistake this kind of check usually ships with. Both sides
 * are lower-cased because a hostname is case-insensitive and the schema does not normalise.
 */
export function domainCovers(cookieDomain: string, host: string): boolean {
  const domain = cookieDomain.toLowerCase();
  const target = host.toLowerCase();
  return target === domain || target.endsWith(`.${domain}`);
}

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    /** Bind address. `localhost` = IPv4 + IPv6 loopback; containers use 0.0.0.0. */
    API_HOST: z.string().min(1).default('localhost'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    /**
     * Proxies allowed to set X-Forwarded-*: "true", "false", or a comma-separated list of
     * addresses/CIDRs. Default false: the Next.js rewrite does not add X-Forwarded-For.
     */
    TRUST_PROXY: z.string().default('false'),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),

    // --- better-auth (PLAN 10) ---
    /**
     * Signs session cookies and tokens. Required outside NODE_ENV=test (tests use a fixed
     * value); at least 32 characters in production (`openssl rand -base64 32`).
     */
    BETTER_AUTH_SECRET: optionalString,
    /**
     * Public origin the browser uses, i.e. the web origin: better-auth builds callback and
     * email links from it and the Next.js rewrite forwards /api/auth/* to this server.
     */
    BETTER_AUTH_URL: z.url().default('http://localhost:3000'),
    /**
     * Web origin(s) trusted for CSRF, redirectTo/callbackURL validation (better-auth
     * trustedOrigins) and CORS (ADR-0017: the browser talks to the API origin directly for
     * Socket.IO). Comma-separated absolute URLs; each is reduced to its origin the way a
     * browser serialises the `Origin` header (`webOrigins`), so a trailing slash, a path or an
     * upper-case host in the value is harmless. Defaults to the origin of BETTER_AUTH_URL.
     * SessionGuard compares the `Origin` of every cookie-authenticated mutation against this
     * list, so list origins, not better-auth wildcard patterns — a pattern fails at startup.
     */
    WEB_ORIGIN: optionalString,
    /**
     * The registrable domain the session cookie is scoped to, e.g. `example.com` for a
     * production split of `app.example.com` (web) and `api.example.com` (API). Unset — and so
     * unset locally, where the two differ only by port — the cookie stays HOST-ONLY, which is
     * the safer default and the behaviour every environment has today.
     *
     * ADR-0017 stated the requirement for the Socket.IO handshake as same-SITE, which is
     * necessary and not sufficient: `app.` and `api.` of one domain are same-site for
     * SameSite=Lax, but a cookie minted with no `Domain` is sent back to its exact host alone
     * (RFC 6265 §5.1.3), and the login cookie is minted through the WEB host because the Next
     * rewrite proxies `/api/auth/*` server-side. The socket dials the API host directly (a
     * rewrite does not proxy a WebSocket upgrade), so without this every signed-in user got an
     * anonymous handshake: no `user:<id>` room, and the balance chip and 내 포지션 silently
     * stopped moving with nothing logged.
     *
     * The cost is real and is why this is opt-in and never derived: a cookie carrying `Domain`
     * is sent to EVERY subdomain of that domain, so it must name a domain whose subdomains are
     * all ours. A hostname, never a URL or a leading dot — better-auth would otherwise silently
     * default it to the `BETTER_AUTH_URL` host, which is the web host and reaches no API host
     * at all.
     */
    AUTH_COOKIE_DOMAIN: optionalString,

    // --- OAuth providers: a provider is enabled only when BOTH keys are set ---
    GOOGLE_CLIENT_ID: optionalString,
    GOOGLE_CLIENT_SECRET: optionalString,
    KAKAO_CLIENT_ID: optionalString,
    KAKAO_CLIENT_SECRET: optionalString,
    NAVER_CLIENT_ID: optionalString,
    NAVER_CLIENT_SECRET: optionalString,

    // --- Transactional email: Mailpit locally (no auth, no TLS); AWS SES in production
    //     (PLAN 17 Q3 decision 2026-09-03): SMTP credentials + STARTTLS on 587 or TLS on 465.
    SMTP_HOST: z.string().min(1).default('localhost'),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
    /** From header: a bare address or `Name <address>` (SES: a verified identity). */
    SMTP_FROM: mailbox.default('noreply@buddha.local'),
    /** SMTP credentials (SES "SMTP credentials"); both or neither. */
    SMTP_USER: optionalString,
    SMTP_PASS: optionalString,
    /** true = implicit TLS (465). false = plain (Mailpit) or STARTTLS, required with credentials. */
    SMTP_SECURE: z.stringbool().default(false),

    // --- settlement (PLAN 5.5, M5) ---
    /**
     * Seconds between a proposed result and its automatic finalization:
     * `dispute_until = resolved_at + this` (PLAN 5.5: 24 hours). Named TEST_* by PLAN M5 AC 2
     * because the only reason to change it is an e2e that cannot wait a day; production leaves
     * it at the default. Whole seconds, at least one — the worker's finalize job is delayed by
     * exactly this, and the web's 이의 제기 button reads the resulting `disputeUntil`.
     */
    TEST_DISPUTE_WINDOW_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .default(DISPUTE_WINDOW_SECONDS_DEFAULT),
  })
  .superRefine((env, ctx) => {
    // Validated here, not only where it is consumed, so `loadEnv()` fails with the readable
    // `[WEB_ORIGIN]` line the header promises instead of a DI-factory exception later.
    for (const entry of (env.WEB_ORIGIN ?? '').split(',')) {
      const trimmed = entry.trim();
      if (trimmed.length === 0) continue;
      try {
        canonicalOrigin(trimmed);
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          path: ['WEB_ORIGIN'],
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // A URL or a leading dot here would be accepted by better-auth and silently scope the
    // cookie to nothing that exists, which is exactly the failure this variable is here to
    // fix: no error anywhere, and realtime dead for every signed-in user.
    const cookieDomain = env.AUTH_COOKIE_DOMAIN;
    // `URL.parse` rather than `new URL`: a superRefine runs even when a FIELD of the object
    // failed, so `BETTER_AUTH_URL: 'not-a-url'` (and `''`) reaches this body as the raw string
    // and `new URL` threw a bare TypeError straight through `safeParse` — replacing the readable
    // boot error that names BETTER_AUTH_URL with a stack trace that names nothing. Unresolvable
    // means the cross-check is SKIPPED, which is right: `z.url()` has already filed the issue
    // that says what is actually wrong, and one value must not raise two.
    const authHost = URL.parse(env.BETTER_AUTH_URL)?.hostname;
    if (cookieDomain !== undefined) {
      if (
        !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(cookieDomain)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['AUTH_COOKIE_DOMAIN'],
          message: `AUTH_COOKIE_DOMAIN must be a bare hostname such as "example.com", not "${cookieDomain}"`,
        });
      } else if (authHost !== undefined && !domainCovers(cookieDomain, authHost)) {
        // Shape alone was never the question. A well-formed hostname that the auth host is not
        // under is exactly as dead as a URL or a leading dot: RFC 6265 domain-matching requires
        // the cookie's Domain to be the host or a parent of it, so the browser DROPS the
        // Set-Cookie and the session never persists — with nothing logged anywhere, which is the
        // failure this variable exists to make loud.
        //
        // Compared label-wise, so `example.com` does not cover `badexample.com`; equality counts,
        // so a host-only-equivalent value is allowed.
        //
        // TWO GAPS, on purpose. (1) This sees the WEB host only. `AUTH_COOKIE_DOMAIN` exists
        // because the cookie is minted through the web host while the socket dials the API host
        // (ADR-0017 추기), and `envSchema` does not carry the public API origin — so
        // `AUTH_COOKIE_DOMAIN=app.example.com` still boots and still leaves api.example.com
        // uncovered, which is the very failure class the variable was added for. (2) A public
        // suffix such as `co.kr` covers `buddha.co.kr` by this test and is discarded by the
        // browser all the same; catching that needs a public-suffix list, which is not a
        // dependency worth pulling into boot validation. This check is one-directional: what it
        // rejects is certainly dead, what it passes is not thereby certainly alive.
        ctx.addIssue({
          code: 'custom',
          path: ['AUTH_COOKIE_DOMAIN'],
          message: `AUTH_COOKIE_DOMAIN "${cookieDomain}" does not cover the BETTER_AUTH_URL host "${authHost}" — a browser would drop the cookie. Note this checks the web host only; it cannot see the API host.`,
        });
      }
    }
    if (env.NODE_ENV !== 'test' && !env.BETTER_AUTH_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['BETTER_AUTH_SECRET'],
        message: 'required unless NODE_ENV=test (generate one with `openssl rand -base64 32`)',
      });
    }
    if (env.NODE_ENV === 'production' && (env.BETTER_AUTH_SECRET?.length ?? 0) < 32) {
      ctx.addIssue({
        code: 'custom',
        path: ['BETTER_AUTH_SECRET'],
        message: 'must be at least 32 characters in production',
      });
    }
    if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASS)) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_USER'],
        message: 'SMTP_USER and SMTP_PASS must be set together',
      });
    }
    for (const provider of OAUTH_PROVIDERS) {
      const prefix = provider.toUpperCase();
      const id = env[`${prefix}_CLIENT_ID` as `${Uppercase<OAuthProvider>}_CLIENT_ID`];
      const secret = env[`${prefix}_CLIENT_SECRET` as `${Uppercase<OAuthProvider>}_CLIENT_SECRET`];
      if (Boolean(id) !== Boolean(secret)) {
        ctx.addIssue({
          code: 'custom',
          path: [id ? `${prefix}_CLIENT_SECRET` : `${prefix}_CLIENT_ID`],
          message: `${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET must be set together (or both empty)`,
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Loads the .env files into process.env (existing variables always win) and validates
 * the result. Used by main.ts for the values Fastify needs before the Nest app exists
 * (host, port, trustProxy); ConfigModule validates the same schema again for DI.
 */
export function loadEnv(): Env {
  loadDotenv({ path: envFilePaths, quiet: true });
  return envSchema.parse(process.env);
}

/** Translates TRUST_PROXY into Fastify's `trustProxy` option. */
export function parseTrustProxy(value: string): boolean | string[] {
  const normalized = value.trim().toLowerCase();
  if (normalized === '' || normalized === 'false') return false;
  if (normalized === 'true') return true;
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Credentials of the providers that have both keys set; the others stay disabled
 * (PLAN 13 M1 AC: without keys only the configured providers are wired).
 */
export function enabledOAuthProviders(env: Env): Partial<Record<OAuthProvider, OAuthCredentials>> {
  const pairs: Record<OAuthProvider, [string | undefined, string | undefined]> = {
    google: [env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET],
    kakao: [env.KAKAO_CLIENT_ID, env.KAKAO_CLIENT_SECRET],
    naver: [env.NAVER_CLIENT_ID, env.NAVER_CLIENT_SECRET],
  };
  const result: Partial<Record<OAuthProvider, OAuthCredentials>> = {};
  for (const provider of OAUTH_PROVIDERS) {
    const [clientId, clientSecret] = pairs[provider];
    if (clientId && clientSecret) result[provider] = { clientId, clientSecret };
  }
  return result;
}

/**
 * Origins allowed to call the API from a browser: better-auth `trustedOrigins`, the CORS
 * allow-list and SessionGuard's CSRF check. WEB_ORIGIN when set, otherwise the origin of
 * BETTER_AUTH_URL.
 *
 * Every entry is canonicalised with `new URL(entry).origin` — lower-case scheme and host, no
 * path, no trailing slash, no default port — because that is how browsers serialise the
 * `Origin` header and SessionGuard matches it exactly. `https://App.example.com/` in .env would
 * otherwise refuse every cookie-authenticated mutation with 403. An entry that is not an
 * absolute URL (a better-auth wildcard pattern included) throws, so a bad value fails the
 * process at startup — `createAuth` and the SessionGuard constructor both call this — instead
 * of failing every write at runtime.
 */
export function webOrigins(env: Pick<Env, 'WEB_ORIGIN' | 'BETTER_AUTH_URL'>): string[] {
  const configured = (env.WEB_ORIGIN ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (configured.length === 0) return [new URL(env.BETTER_AUTH_URL).origin];
  return [...new Set(configured.map(canonicalOrigin))];
}

/**
 * `new URL(entry).origin`, or a throw naming the entry. Stricter than the URL parser alone:
 * only http(s) origins can appear in a browser's `Origin` header (`mailto:`, `myapp://` and the
 * misspelling `localhost:3000` all parse to the literal origin "null", which must never enter
 * the trusted set — it would admit `Origin: null` requests), and better-auth's wildcard
 * patterns (`https://*.example.com`) parse fine in Node but SessionGuard cannot match them.
 */
export function canonicalOrigin(entry: string): string {
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    throw new Error(`WEB_ORIGIN entry "${entry}" is not an absolute URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`WEB_ORIGIN entry "${entry}" must be an http(s) origin`);
  }
  // `?` cannot occur in a hostname (it starts the query), so only `*` needs a check here.
  if (url.hostname.includes('*') || url.hostname.length === 0) {
    throw new Error(
      `WEB_ORIGIN entry "${entry}" must be one origin, not a pattern (SessionGuard matches exactly)`,
    );
  }
  return url.origin;
}
