import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mediaStorageEnvIssues, mediaStorageEnvShape } from '@buddha/storage';
import * as z from 'zod';

/**
 * Environment schema. The worker shares the same `.env` keys as `apps/api`
 * (PLAN 15). Unknown keys are ignored.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
    /**
     * `GET /health` (health.ts) so the e2e runner and CI can wait for the worker the way they
     * wait for the API — a worker that is still connecting must not be taken for one that will
     * close and settle markets on time (PLAN M5 AC 7). 200 once the queues are attached AND
     * Postgres has answered one `select 1` (`waitForDb`, main.ts); both, because closing and
     * settling are database transactions and the API's own probe covers both too. It is a fact
     * about BOOT: a Postgres that dies afterwards leaves the flag at 200 (Q-M5-11). 0 disables
     * the server: a deployment that probes the process some other way keeps no listening socket
     * it never asked for.
     */
    WORKER_HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(4100),
    /** Bind address of the health server; 'localhost' keeps it off the network by default. */
    WORKER_HOST: z.string().min(1).default('localhost'),
    /**
     * The media store (#46, ADR-0073), the same keys as apps/api: the worker removes the uploads no
     * post took (`media.orphan_cleanup`), object and row, from the store the API wrote them to.
     */
    ...mediaStorageEnvShape,
  })
  .superRefine((env, ctx) => {
    for (const issue of mediaStorageEnvIssues(env)) {
      ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
    }
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
