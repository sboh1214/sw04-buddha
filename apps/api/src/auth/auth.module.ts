import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Db } from '@buddha/db';
import { type RateLimits } from '@buddha/shared';
import { AuthModule as BetterAuthModule } from '@thallesp/nestjs-better-auth';
import { type Redis } from 'ioredis';
import { type Env } from '../config/env.js';
import { DbModule } from '../infra/db/db.module.js';
import { DB } from '../infra/db/db.provider.js';
import { RedisModule } from '../infra/redis/redis.module.js';
import { REDIS } from '../infra/redis/redis.provider.js';
import { MailModule } from '../mail/mail.module.js';
import { MAILER } from '../mail/mail.provider.js';
import { type Mailer } from '../mail/mailer.js';
import { authRateLimiter } from '../rate-limit/auth-rate-limit.js';
import { RATE_LIMITS, RateLimitsModule } from '../rate-limit/rate-limit.limits.js';
import { AdminGuard } from './admin.guard.js';
import { AUTH, type Auth, createAuth } from './auth.js';
import { PasswordService } from './password.service.js';
import { RegisterController } from './register.controller.js';
import { RegistrationService } from './registration.service.js';
import { SessionGuard } from './session.guard.js';

/** Keys of Env that better-auth reads; mirrors the schema in config/env.ts. */
const AUTH_ENV_KEYS = [
  'NODE_ENV',
  'API_HOST',
  'API_PORT',
  'TRUST_PROXY',
  'RATE_LIMIT_UNCOUNTED_PEERS',
  'LOG_LEVEL',
  'DATABASE_URL',
  'REDIS_URL',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_URL',
  'WEB_ORIGIN',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'KAKAO_CLIENT_ID',
  'KAKAO_CLIENT_SECRET',
  'NAVER_CLIENT_ID',
  'NAVER_CLIENT_SECRET',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_FROM',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_SECURE',
  'AUTH_COOKIE_DOMAIN',
  'PAYMENT_PROVIDER',
] as const satisfies readonly (keyof Env)[];

/**
 * Every key of `Env` is projected, and this line is what keeps that true.
 *
 * `envFromConfig` below builds a `Partial<Env>` and CASTS it, so a key missing from the list is
 * not a type error — it is `undefined` at runtime, in a value the auth instance reads as
 * configuration. `AUTH_COOKIE_DOMAIN` was added to the schema and to `createAuth` and dropped
 * here, so the session cookie would have stayed host-only in exactly the deployment the setting
 * exists for, with nothing failing and nothing logged. `satisfies` above only checks that each
 * entry IS a key; this checks that no key is MISSING, so the next one cannot slip through.
 */
type UnprojectedEnvKey = Exclude<keyof Env, (typeof AUTH_ENV_KEYS)[number]>;
type AssertNoUnprojectedEnvKey<T extends never> = T;
export type _EveryEnvKeyIsProjected = AssertNoUnprojectedEnvKey<UnprojectedEnvKey>;

/** Rebuilds the validated Env from ConfigService (typed values, not raw strings). */
function envFromConfig(config: ConfigService<Env, true>): Env {
  const env: Partial<Env> = {};
  for (const key of AUTH_ENV_KEYS) {
    (env as Record<string, unknown>)[key] = config.get(key, { infer: true });
  }
  return env as Env;
}

const authProvider: Provider<Auth> = {
  provide: AUTH,
  inject: [ConfigService, DB, MAILER, REDIS, RATE_LIMITS],
  useFactory: (
    config: ConfigService<Env, true>,
    db: Db,
    mailer: Mailer,
    redis: Redis,
    limits: RateLimits,
  ): Auth =>
    createAuth({
      env: envFromConfig(config),
      db,
      mailer,
      // PLAN 7.5 for /api/auth/*, half of it: middie serves those routes before Nest routing
      // exists, so no guard sees them, and better-auth's own `hooks.before` is the only place
      // that has the PARSED BODY — the address the mail and sign-in buckets key on. The other
      // half, the per-CALLER address bucket, is the raw Fastify hook registered ahead of
      // middie that counts the whole API (rate-limit/address-limit.ts).
      rateLimiter: authRateLimiter(redis),
      rateLimits: limits,
    }),
};

/** Owns the single better-auth instance so the HTTP mount and the guards share it. */
@Module({
  imports: [DbModule, MailModule, RedisModule, RateLimitsModule],
  providers: [authProvider],
  exports: [AUTH],
})
export class AuthInstanceModule {}

/**
 * Mounts better-auth on /api/auth/* (PLAN 10.1) through @thallesp/nestjs-better-auth
 * (ADR-0018: works on Nest 12 although its peer range says ^11).
 *
 * On Fastify the library registers `toNodeHandler(auth)` as @fastify/middie middleware,
 * which runs before Nest routing, the global prefix, URI versioning and body parsing
 * (better-auth reads the raw request stream). So /api/auth/* is served exactly as
 * better-auth expects, /api/v1/auth/* is a 404, and main.ts must keep `bodyParser: false`.
 *
 * - disableGlobalAuthGuard: PLAN 7.1 has public routes; SessionGuard is applied per
 *   controller instead of the library's APP_GUARD.
 * - disableTrustedOriginsCors: the browser reaches the API through the Next.js rewrite
 *   (same origin), so no CORS headers are emitted for REST (ADR-0017).
 */
@Module({
  imports: [
    AuthInstanceModule,
    DbModule,
    RedisModule,
    BetterAuthModule.forRootAsync({
      imports: [AuthInstanceModule],
      inject: [AUTH],
      // The library replaces Fastify's JSON/urlencoded parsers with its own (needed on
      // Express, harmless here). Its JSON parser throws a bare SyntaxError on malformed JSON,
      // which ApiExceptionFilter maps to 400 VALIDATION_ERROR. The urlencoded one is switched
      // off: this API speaks JSON only, and an HTML form is exactly what a cross-site request
      // forgery submits (SessionGuard.refuseForeignOrigin). Left on, it also 500s on every
      // form body today because its `qs` peer dependency is not installed — protection by
      // accident, which any dependency pulling in `qs` would silently remove.
      useFactory: (auth: Auth) => ({
        auth,
        disableTrustedOriginsCors: true,
        bodyParser: { urlencoded: { enabled: false } },
      }),
      disableGlobalAuthGuard: true,
    }),
  ],
  controllers: [RegisterController],
  providers: [SessionGuard, AdminGuard, RegistrationService, PasswordService],
  exports: [AuthInstanceModule, SessionGuard, AdminGuard, PasswordService],
})
export class AuthModule {}
