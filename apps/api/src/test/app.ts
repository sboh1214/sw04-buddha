// Helpers for HTTP-level integration tests against the real test Postgres/Redis.
import { randomUUID } from 'node:crypto';
import { VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { schema, type Db } from '@buddha/db';
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

/** The `.../verify-email?token=...&callbackURL=...` link in the newest mail sent to `to`. */
export function verificationLinkFor(mailer: MemoryMailer, to: string): string {
  for (let i = mailer.messages.length - 1; i >= 0; i -= 1) {
    const message = mailer.messages[i]!;
    if (message.to !== to) continue;
    const match = /https?:\/\/\S+\/verify-email\?\S+/.exec(message.text);
    if (match) return match[0];
  }
  throw new Error(`no verification mail for ${to}`);
}

/** `token` query parameter of a verification link. */
export function tokenFromLink(link: string): string {
  const token = new URL(link).searchParams.get('token');
  if (!token) throw new Error(`no token in ${link}`);
  return token;
}

/** Inserts a charge package so a test can buy something (ADR-0026). */
/** A package as `createTestPackage` returns it: enough to build a charge body. */
export interface TestPackage {
  id: string;
  amountP: bigint;
  priceKrw: number;
}

/**
 * The `POST /payments/charge` body. It echoes the terms the catalogue card showed, so the
 * server can refuse a purchase of an offer the user never read (ADR-0026 lets an admin
 * re-price a live package), and the account the screen showed, so a tab whose session was
 * switched elsewhere cannot charge whoever the cookie now belongs to.
 */
export function chargeBody(pack: TestPackage, accountId: string): Record<string, unknown> {
  return {
    packageId: pack.id,
    expectedAmountP: pack.amountP.toString(),
    expectedPriceKrw: pack.priceKrw,
    expectedAccountId: accountId,
  };
}

/**
 * Headers for one `POST /payments/charge`: the session cookie plus a fresh `Idempotency-Key`
 * (PLAN 5.4) unless the test deliberately re-sends one.
 */
export function chargeHeaders(
  cookie: string,
  idempotencyKey: string = randomUUID(),
): Record<string, string> {
  return {
    origin: 'http://localhost:3000',
    'content-type': 'application/json',
    cookie,
    'idempotency-key': idempotencyKey,
  };
}

export async function createTestPackage(
  db: Db,
  input: { amountP?: bigint; priceKrw?: number; isActive?: boolean; sortOrder?: number } = {},
): Promise<TestPackage> {
  const amountP = input.amountP ?? 10_000n;
  const priceKrw = input.priceKrw ?? 9_700;
  const [row] = await db
    .insert(schema.chargePackages)
    .values({
      amountP,
      priceKrw,
      isActive: input.isActive ?? true,
      sortOrder: input.sortOrder ?? 0,
    })
    .returning();
  if (!row) throw new Error('failed to insert a charge package');
  return { id: row.id, amountP: row.amountP, priceKrw: row.priceKrw };
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
  /** Value for the `Cookie` request header of an authenticated request. */
  cookie: string;
}

let counter = 0;

/**
 * The whole sign-up of ADR-0024, as a browser would run it: register the address (no
 * password), follow the verification link from the in-memory mailer (which verifies and
 * signs the user in), then set the first password. The "user" trigger creates profile and
 * balance on registration.
 */
export async function signUpTestUser(
  t: Pick<TestApp, 'app' | 'auth' | 'mailer'>,
  overrides: { email?: string; password?: string } = {},
): Promise<TestUser> {
  counter += 1;
  const email = overrides.email ?? `user${String(counter)}-${String(Date.now())}@test.local`;
  const password = overrides.password ?? 'password-1234';

  const registered = await t.app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: { email },
  });
  if (registered.statusCode !== 200) {
    throw new Error(`register failed: ${String(registered.statusCode)} ${registered.body}`);
  }

  const token = tokenFromLink(verificationLinkFor(t.mailer, email));
  const { headers } = await t.auth.api.verifyEmail({ query: { token }, returnHeaders: true });
  const cookie = headers
    .getSetCookie()
    .map((entry) => entry.split(';')[0]!)
    .join('; ');
  if (!cookie.includes('session_token=')) throw new Error('verify-email did not sign in');
  const session = await t.auth.api.getSession({ headers: new Headers({ cookie }) });
  if (!session) throw new Error('verify-email did not sign in');
  const id = session.user.id;

  await t.auth.api.setPassword({
    body: { newPassword: password },
    headers: new Headers({ cookie }),
  });
  return { id, email, password, cookie };
}
