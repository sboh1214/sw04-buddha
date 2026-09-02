import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as z from 'zod';

/**
 * Environment schema. The worker shares the same `.env` keys as `apps/api`
 * (PLAN 15). Unknown keys are ignored.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates an environment-like object. Throws an Error whose message lists
 * every problem, so callers can decide how to report it.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment variables:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/**
 * Loads `.env` files into `process.env` without overriding variables that are
 * already set (that is how `process.loadEnvFile` behaves). Lookup order:
 *   1. `apps/worker/.env`   (app-local override, optional)
 *   2. `<repo root>/.env`   (shared with apps/api, see PLAN 15)
 * Paths are resolved relative to this module so they work from both `src/`
 * (tsx) and `dist/` (compiled output).
 */
function loadDotEnvFiles(): void {
  const candidates = [
    new URL('../.env', import.meta.url),
    new URL('../../../.env', import.meta.url),
  ];
  for (const candidate of candidates) {
    const path = fileURLToPath(candidate);
    if (existsSync(path)) {
      process.loadEnvFile(path);
    }
  }
}

let cached: Env | undefined;

/**
 * Returns the validated environment (loaded once, lazily). On validation
 * failure the process exits with code 1: the worker cannot do anything useful
 * without its configuration, and the logger itself depends on it.
 */
export function getEnv(): Env {
  if (cached) return cached;
  loadDotEnvFiles();
  try {
    cached = parseEnv(process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
  return cached;
}
