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
 * Environment schema for apps/api. Validated once at bootstrap by
 * `ConfigModule.forRoot({ validationSchema: envSchema })` (Standard Schema);
 * an invalid environment aborts startup with a readable error.
 *
 * Only variables the API actually reads are required. Auth-related variables
 * are optional until M1 wires better-auth.
 */
export const envSchema = z.object({
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

  // M1+
  BETTER_AUTH_SECRET: z.string().min(1).optional(),
  BETTER_AUTH_URL: z.url().optional(),
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
