/**
 * vitest `setupFiles` entry (runs in every worker before the test files): points the app
 * at the docker `test` profile and gives better-auth a fixed secret.
 *
 * Integration suites read ONLY TEST_* (never DATABASE_URL), so a test run can never touch
 * the dev database. ConfigModule loads .env files afterwards, but values already present in
 * process.env win, which is why this must run first.
 */
import { config as loadDotenv } from 'dotenv';
import { envFilePaths } from '../config/env.js';

loadDotenv({ path: envFilePaths, quiet: true });

export const hasTestInfra =
  Boolean(process.env.TEST_DATABASE_URL) &&
  Boolean(process.env.TEST_DATABASE_MIGRATE_URL) &&
  Boolean(process.env.TEST_REDIS_URL);

if (hasTestInfra) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.REDIS_URL = process.env.TEST_REDIS_URL;
}
process.env.NODE_ENV = 'test';
process.env.BETTER_AUTH_SECRET ??= 'vitest-only-secret-0123456789abcdef0123456789';
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';
process.env.WEB_ORIGIN ??= 'http://localhost:3000';
// Unreachable on purpose: tests replace MAILER with the in-memory mailer.
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = '9';
// The immediate mock charge, whatever a developer's .env says (PAYMENT_PROVIDER=smartro there
// would turn every charge suite into 404s): SmartroPay suites switch it on per app, with a fake
// PG, through `createTestApp({ smartro })`.
process.env.PAYMENT_PROVIDER = 'mock';
