import path from 'node:path';
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
     * Socket.IO). Comma-separated. Defaults to the origin of BETTER_AUTH_URL.
     */
    WEB_ORIGIN: optionalString,

    // --- OAuth providers: a provider is enabled only when BOTH keys are set ---
    GOOGLE_CLIENT_ID: optionalString,
    GOOGLE_CLIENT_SECRET: optionalString,
    KAKAO_CLIENT_ID: optionalString,
    KAKAO_CLIENT_SECRET: optionalString,
    NAVER_CLIENT_ID: optionalString,
    NAVER_CLIENT_SECRET: optionalString,

    // --- Transactional email (Mailpit locally; no auth, no TLS) ---
    SMTP_HOST: z.string().min(1).default('localhost'),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
    /** From header: a bare address or `Name <address>`. */
    SMTP_FROM: z.string().min(3).default('noreply@buddha.local'),
  })
  .superRefine((env, ctx) => {
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
 * Origins allowed to call the API from a browser: better-auth `trustedOrigins` and the
 * CORS allow-list. WEB_ORIGIN when set, otherwise the origin of BETTER_AUTH_URL.
 */
export function webOrigins(env: Env): string[] {
  const configured = env.WEB_ORIGIN?.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  if (configured && configured.length > 0) return configured;
  return [new URL(env.BETTER_AUTH_URL).origin];
}
