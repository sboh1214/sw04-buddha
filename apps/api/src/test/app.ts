// Helpers for HTTP-level integration tests against the real test Postgres/Redis.
import { VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { type Db } from '@buddha/db';
import { connectTestDb, type TestDb } from '@buddha/db/test';
import { AppModule } from '../app.module.js';
import { AUTH, type Auth } from '../auth/auth.js';
import { DB } from '../infra/db/db.provider.js';
import { MAILER } from '../mail/mail.provider.js';
import { createMemoryMailer, type MemoryMailer } from './memory-mailer.js';

export interface TestApp {
  app: NestFastifyApplication;
  /** The app's own buddha_app handle (DATABASE_URL was mapped to TEST_DATABASE_URL). */
  db: Db;
  auth: Auth;
  mailer: MemoryMailer;
  /** Truncates every table (owner role, via the packages/db harness). Call in beforeEach. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Boots AppModule exactly like main.ts (prefix, versioning, bodyParser: false) without
 * listening, with the in-memory mailer. Holds the packages/db test-file lock until close().
 */
export async function createTestApp(): Promise<TestApp> {
  const harness: TestDb = await connectTestDb();
  const mailer = createMemoryMailer();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAILER)
    .useValue(mailer)
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), {
    bodyParser: false,
    logger: false,
  });
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return {
    app,
    db: app.get<Db>(DB),
    auth: app.get<Auth>(AUTH),
    mailer,
    reset: () => harness.reset(),
    close: async () => {
      await app.close();
      await harness.close();
    },
  };
}

export interface TestUser {
  id: string;
  email: string;
  /** Value for the `Cookie` request header of an authenticated request. */
  cookie: string;
}

let counter = 0;

/**
 * Signs up through better-auth's server API (no HTTP) and returns the session cookie
 * exactly as a browser would send it back. The "user" trigger creates profile + balance.
 */
export async function signUpTestUser(
  auth: Auth,
  overrides: { email?: string; password?: string } = {},
): Promise<TestUser> {
  counter += 1;
  const email = overrides.email ?? `user${String(counter)}-${String(Date.now())}@test.local`;
  const { headers, response } = await auth.api.signUpEmail({
    body: { email, password: overrides.password ?? 'password-1234', name: 'tester' },
    returnHeaders: true,
  });
  const cookie = headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0]!)
    .join('; ');
  return { id: response.user.id, email, cookie };
}
