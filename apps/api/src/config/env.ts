import { BlockList, isIP } from 'node:net';
import path from 'node:path';
import {
  DISPUTE_WINDOW_SECONDS_DEFAULT,
  paymentProviderSchema,
  smartroModeSchema,
} from '@buddha/shared';
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

/**
 * The SmartroPay credentials `PAYMENT_PROVIDER=smartro` cannot run without. The merchant key
 * signs every request (EncryptData, HashData) and its first 32 characters are the AES-256 key of
 * the cancel payload, hence the minimum length.
 */
export const SMARTRO_REQUIRED_KEYS = [
  'SMARTRO_MID',
  'SMARTRO_MERCHANT_KEY',
  'SMARTRO_CANCEL_PASSWORD',
] as const;
export const SMARTRO_MID_MAX_LENGTH = 10;
export const SMARTRO_MERCHANT_KEY_MIN_LENGTH = 32;

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
     * addresses/CIDRs. Default false: the Next.js rewrite does not add a trustworthy
     * X-Forwarded-For (Next fills it as `client-supplied ?? socket address`, so a caller can
     * set it), and PLAN 7.5's per-address limit reads `request.ip` — see ADR-0034. A proxy
     * that must NOT be trusted but still sits in front of this API belongs in
     * RATE_LIMIT_UNCOUNTED_PEERS instead.
     */
    TRUST_PROXY: z.string().default('false'),
    /**
     * Peers whose requests are NOT counted against PLAN 7.5's per-address limit: proxies in
     * front of this API whose forwarded headers are not trusted (TRUST_PROXY) and which
     * therefore cannot name a client — the web server's Next rewrite when it runs on another
     * host. Comma-separated addresses or CIDRs (IPv4 or IPv6); loopback is always one. Without
     * it, a split web/API deployment counts every visitor as the web host and the whole site
     * shares one 100/min window (rate-limit.tracker.ts, ADR-0034 추기).
     */
    RATE_LIMIT_UNCOUNTED_PEERS: optionalString,
    /**
     * pino level for this process (apps/api/src/logger.ts). Same key, same values and the same
     * defaults as apps/worker: `debug` in development, `info` in production, `silent` under
     * test. Unset, the default for NODE_ENV applies.
     */
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
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

    // --- Payments (ADR-0042) ---
    /**
     * Which provider takes NEW charges: `mock` succeeds immediately with no money moving (the
     * default, and what CI and e2e run), `smartro` opens the SmartroPay payment window. A refund
     * uses the provider recorded on the payment row, so switching keeps old payments refundable.
     */
    PAYMENT_PROVIDER: optionalString.pipe(paymentProviderSchema.default('mock')),
    /** SmartroPay environment: `STG` (test hosts) or `REAL`. Picks the SDK and approval hosts. */
    SMARTRO_MODE: optionalString.pipe(smartroModeSchema.default('STG')),
    /** Merchant id (≤ 10 characters). Required with PAYMENT_PROVIDER=smartro. */
    SMARTRO_MID: optionalString,
    /** Merchant key (≥ 32 characters): signs requests, keys the cancel payload. Secret. */
    SMARTRO_MERCHANT_KEY: optionalString,
    /** Cancel password set in the merchant admin; sent (encrypted) with every cancel. Secret. */
    SMARTRO_CANCEL_PASSWORD: optionalString,
    /**
     * Overrides the approval/cancel host (`https://tapproval.smartropay.co.kr` for STG,
     * `https://approval.smartropay.co.kr` for REAL) — for a local fake PG only, so production
     * refuses it: pointed elsewhere, the approval and the cancel would go to whoever answers there.
     */
    SMARTRO_APPROVAL_BASE_URL: optionalString.pipe(z.url({ protocol: /^https?$/ }).optional()),

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
    // Same reason as WEB_ORIGIN below: a bad entry must fail at `loadEnv()` under its own name.
    try {
      uncountedPeers(env);
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        path: ['RATE_LIMIT_UNCOUNTED_PEERS'],
        message: error instanceof Error ? error.message : String(error),
      });
    }
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
    // Shapes are checked whenever set, whichever provider is active: a bad value is bad anywhere.
    if (env.SMARTRO_MID !== undefined && env.SMARTRO_MID.length > SMARTRO_MID_MAX_LENGTH) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMARTRO_MID'],
        message: `must be at most ${String(SMARTRO_MID_MAX_LENGTH)} characters`,
      });
    }
    if (
      env.SMARTRO_MERCHANT_KEY !== undefined &&
      env.SMARTRO_MERCHANT_KEY.length < SMARTRO_MERCHANT_KEY_MIN_LENGTH
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMARTRO_MERCHANT_KEY'],
        message: `must be at least ${String(SMARTRO_MERCHANT_KEY_MIN_LENGTH)} characters`,
      });
    }
    if (env.PAYMENT_PROVIDER === 'smartro') {
      for (const key of SMARTRO_REQUIRED_KEYS) {
        if (!env[key]) {
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'required when PAYMENT_PROVIDER=smartro',
          });
        }
      }
    }
    // Only for a value `z.url()` accepted: a bad one already has its issue (the superRefine still
    // runs and sees the raw string), and one value must not raise two.
    const approvalProtocol =
      env.SMARTRO_APPROVAL_BASE_URL === undefined
        ? undefined
        : URL.parse(env.SMARTRO_APPROVAL_BASE_URL)?.protocol;
    if (
      env.NODE_ENV === 'production' &&
      (approvalProtocol === 'http:' || approvalProtocol === 'https:')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMARTRO_APPROVAL_BASE_URL'],
        message: 'is for a local fake PG and must not be set in production',
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

/**
 * RATE_LIMIT_UNCOUNTED_PEERS as a `node:net` BlockList (`check(address, family)` answers whether
 * a peer is on it). Built here, from the validated string, rather than stored in `Env`: the
 * schema is parsed twice (main.ts and ConfigModule) and @nestjs/config drops non-primitive
 * values when it copies the result into `process.env`. Throws naming the offending entry;
 * the schema's `superRefine` turns that into the `[RATE_LIMIT_UNCOUNTED_PEERS]` line.
 *
 * The family is passed explicitly on every add and every check: `BlockList` defaults to IPv4
 * and answers `false` — not an error — for an IPv6 address checked as IPv4, so a ULA peer on a
 * container network would have been counted with nothing to say so.
 */
export function uncountedPeers(env: Pick<Env, 'RATE_LIMIT_UNCOUNTED_PEERS'>): BlockList {
  const list = new BlockList();
  for (const entry of (env.RATE_LIMIT_UNCOUNTED_PEERS ?? '').split(',')) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const [mapped, prefix, ...rest] = trimmed.split('/');
    // `::ffff:a.b.c.d` is IPv4 in an IPv6 coat — how a dual-stack listener reports an IPv4 peer,
    // and so what an operator copies out of a request log. As IPv6 it would be added under the
    // wrong family AND the wrong width: `::ffff:172.18.0.0/16` is `::/16`, which matches every
    // IPv4 address there is. Stripped, so the entry means what it looks like.
    const address =
      mapped?.startsWith('::ffff:') && ipFamily(mapped.slice(7)) === 'ipv4'
        ? mapped.slice(7)
        : mapped;
    const family = ipFamily(address ?? '');
    if (family === undefined || rest.length > 0) {
      throw new Error(`RATE_LIMIT_UNCOUNTED_PEERS entry "${trimmed}" is not an IP address or CIDR`);
    }
    if (prefix === undefined) {
      list.addAddress(address ?? '', family);
      continue;
    }
    const bits = Number(prefix);
    const maxBits = family === 'ipv4' ? 32 : 128;
    if (!/^\d{1,3}$/.test(prefix) || bits > maxBits) {
      throw new Error(
        `RATE_LIMIT_UNCOUNTED_PEERS entry "${trimmed}" has no prefix length in 0..${String(maxBits)}`,
      );
    }
    list.addSubnet(address ?? '', bits, family);
  }
  return list;
}

/** `BlockList`'s family label for an address, or `undefined` when it is not an address. */
export function ipFamily(address: string): 'ipv4' | 'ipv6' | undefined {
  const version = isIP(address);
  return version === 4 ? 'ipv4' : version === 6 ? 'ipv6' : undefined;
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
