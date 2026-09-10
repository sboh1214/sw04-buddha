// Helpers for HTTP-level integration tests against the real test Postgres/Redis.
import { randomUUID } from 'node:crypto';
import { VersioningType } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { schema, type Db } from '@buddha/db';
import { connectTestDb, type TestDb } from '@buddha/db/test';
import { type Redis } from 'ioredis';
import { DEFAULT_RATE_LIMITS, type RateLimits } from '@buddha/shared';
import { AppModule } from '../app.module.js';
import { AUTH, type Auth } from '../auth/auth.js';
import { uncountedPeers } from '../config/env.js';
import { DB } from '../infra/db/db.provider.js';
import { MAX_PARAM_LENGTH } from '../infra/http/fastify-options.js';
import { registerSecurityHeaders } from '../infra/http/security-headers.js';
import { MAILER } from '../mail/mail.provider.js';
import { REDIS } from '../infra/redis/redis.provider.js';
import { installAddressLimit } from '../rate-limit/address-limit.js';
import { RATE_LIMITS } from '../rate-limit/rate-limit.limits.js';
import { RATE_LIMIT_KEY_PREFIX } from '../rate-limit/redis-throttler.storage.js';
import { UNCOUNTED_PEERS } from '../rate-limit/uncounted-peers.js';
import { RealtimeIoAdapter } from '../realtime/realtime-io.adapter.js';
import { createMemoryMailer, type MemoryMailer } from './memory-mailer.js';

export interface TestApp {
  app: NestFastifyApplication;
  /** The app's own buddha_app handle (DATABASE_URL was mapped to TEST_DATABASE_URL). */
  db: Db;
  auth: Auth;
  mailer: MemoryMailer;
  /** `http://127.0.0.1:<port>`, only with `{ listen: true }`. */
  url?: string;
  /** Truncates every table (owner role, via the packages/db harness). Call in beforeEach. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export interface CreateTestAppOptions {
  /**
   * Bind an ephemeral port on 127.0.0.1 and fill in `url`. Needed only by the socket suites:
   * `app.inject()` cannot perform a WebSocket upgrade. Off by default so the HTTP suites keep
   * running without a listening socket.
   */
  listen?: boolean;
  /**
   * Raises (or lowers) PLAN 7.5's limits for this app only. Needed by the suites that prove a
   * concurrency invariant PLAN itself specifies above the shipped limit — twenty concurrent
   * charges by one account (PLAN M2 AC 2) against `/payments/charge`'s 10/min/user — and by any
   * test that wants a bound it can reach quickly. Left out, the app runs PLAN's own numbers,
   * which is what `rate-limit.controller.test.ts` measures the acceptance criterion against.
   */
  rateLimits?: Partial<RateLimits>;
  /**
   * RATE_LIMIT_UNCOUNTED_PEERS for this app only (config/env.ts): peers whose requests the
   * per-address limit does not count. `inject()` presents a loopback peer, which is never
   * counted, so a suite that wants to prove the list works names a routable one here and
   * presents it with `remoteAddress`.
   */
  uncountedPeers?: string;
}

/**
 * Boots AppModule exactly like main.ts (prefix, versioning, bodyParser: false, the realtime
 * WebSocket adapter) with the in-memory mailer, and by default without listening. Holds the
 * packages/db test-file lock until close().
 */
export async function createTestApp(options: CreateTestAppOptions = {}): Promise<TestApp> {
  const harness: TestDb = await connectTestDb();
  const mailer = createMemoryMailer();
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAILER)
    .useValue(mailer)
    .overrideProvider(RATE_LIMITS)
    .useValue({ ...DEFAULT_RATE_LIMITS, ...options.rateLimits })
    .overrideProvider(UNCOUNTED_PEERS)
    .useValue(uncountedPeers({ RATE_LIMIT_UNCOUNTED_PEERS: options.uncountedPeers }))
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ routerOptions: { maxParamLength: MAX_PARAM_LENGTH } }),
    { bodyParser: false, logger: false },
  );
  // Exactly as in main.ts, and for the same reason the adapter below is: a bound the suites do
  // not see is a bound nothing proves.
  await registerSecurityHeaders(app);
  installAddressLimit(app);
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  // Must be installed before init, exactly as in main.ts: without it the suites would exercise
  // Nest's default IoAdapter — no Origin gate, no Redis adapter, no message bound — and pass
  // while production behaves differently.
  app.useWebSocketAdapter(new RealtimeIoAdapter(app));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  let url: string | undefined;
  if (options.listen) {
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
  }
  return {
    app,
    db: app.get<Db>(DB),
    auth: app.get<Auth>(AUTH),
    mailer,
    url,
    reset: async () => {
      await harness.reset();
      await clearRateLimitBuckets(app.get<Redis>(REDIS));
    },
    close: async () => {
      await app.close();
      await harness.close();
    },
  };
}

/**
 * Drops every rate-limit bucket, as part of the per-test reset.
 *
 * Postgres is truncated between tests and Redis is not, so without this a suite that uses FIXED
 * addresses — `auth.test.ts` does — carries its spent `email` buckets into the next run and
 * starts failing with 429 whenever the whole suite is run twice inside one 60-second window.
 * Scoped to the `rl:` prefix by SCAN rather than FLUSHDB: `market-jobs.service.test.ts` inspects
 * `bull:*` keys and would lose them.
 */
async function clearRateLimitBuckets(redis: Redis): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(
      cursor,
      'MATCH',
      `${RATE_LIMIT_KEY_PREFIX}:*`,
      'COUNT',
      500,
    );
    cursor = next;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
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
