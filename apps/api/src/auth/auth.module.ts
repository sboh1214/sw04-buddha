import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type Db } from '@buddha/db';
import { AuthModule as BetterAuthModule } from '@thallesp/nestjs-better-auth';
import { type Env } from '../config/env.js';
import { DbModule } from '../infra/db/db.module.js';
import { DB } from '../infra/db/db.provider.js';
import { RedisModule } from '../infra/redis/redis.module.js';
import { MailModule } from '../mail/mail.module.js';
import { MAILER } from '../mail/mail.provider.js';
import { type Mailer } from '../mail/mailer.js';
import { AdminGuard } from './admin.guard.js';
import { AUTH, type Auth, createAuth } from './auth.js';
import { SessionGuard } from './session.guard.js';

/** Keys of Env that better-auth reads; mirrors the schema in config/env.ts. */
const AUTH_ENV_KEYS = [
  'NODE_ENV',
  'API_HOST',
  'API_PORT',
  'TRUST_PROXY',
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
] as const satisfies readonly (keyof Env)[];

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
  inject: [ConfigService, DB, MAILER],
  useFactory: (config: ConfigService<Env, true>, db: Db, mailer: Mailer): Auth =>
    createAuth({ env: envFromConfig(config), db, mailer }),
};

/** Owns the single better-auth instance so the HTTP mount and the guards share it. */
@Module({
  imports: [DbModule, MailModule],
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
      // Express, harmless here). Its parser throws a bare SyntaxError on malformed JSON,
      // which ApiExceptionFilter maps to 400 VALIDATION_ERROR.
      useFactory: (auth: Auth) => ({ auth, disableTrustedOriginsCors: true }),
      disableGlobalAuthGuard: true,
    }),
  ],
  providers: [SessionGuard, AdminGuard],
  exports: [AuthInstanceModule, SessionGuard, AdminGuard],
})
export class AuthModule {}
