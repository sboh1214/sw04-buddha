/**
 * 방문 기록 (#151, ADR-0170; owner answers 151-3, 151-4; ADR-0167 결정 6) through
 * `POST /me/market-visits` against the docker `test` profile. Pinned: a signed-in, onboarded
 * member's open of a public market's detail is one row of the account, the market and the
 * database clock's Korean date, a repeat merged (95-4); the answer is 204 with no body whether or
 * not a row was written — an admin by its grant record (96-10) and an operating account (#115)
 * write nothing; a restricted account is recorded (95-1); the onboarding (and a re-consent a
 * revision asks for) is required, by the route's guard; the session, the Origin and the expected
 * account are checked as on every write (ADR-0092); a market that is not public is NOT_FOUND; and
 * the public detail read writes nothing. Statically: the one route #151 adds carries no path
 * parameter (the request log line names no market), the writer is imported by this module's
 * service alone, and nothing but the allowed files names the two tables (결정 6 "지표에만 쓴다").
 * Skips when TEST_* are unset.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { schema } from '@buddha/db';
import {
  completeOnboarding,
  createConsents,
  createMarket,
  createMarketMakerAccount,
  createModerationAction,
  createUser,
  grantAdminAt,
  readVisits,
} from '@buddha/db/test';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SessionGuard } from '../auth/session.guard.js';
import { clockTimestamp } from '../infra/db/clock.js';
import { OnboardedGuard } from '../onboarding/onboarded.guard.js';
import { OWNER_ROUTES, PUBLIC_ROUTES } from '../surface/registry.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { SRC } from '../test/program.js';
import { discoverRoutes, guardsOf } from '../test/routes.js';
import { hasTestInfra } from '../test/setup-env.js';
import { MarketVisitsService } from './market-visits.service.js';

/** setup-env.ts fixes WEB_ORIGIN to this. */
const TRUSTED_ORIGIN = 'http://localhost:3000';

const URL = '/api/v1/me/market-visits';
const ROUTE = 'POST /me/market-visits';

const HOUR_MS = 60 * 60 * 1_000;

/** The repository root: every app's and package's sources are below it. */
const ROOT = path.resolve(SRC, '../../..');

/** Every non-test source file of every app and package (`apps/*\/src`, `packages/*\/src`). */
function sourceFiles(): string[] {
  const skip = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage', 'generated']);
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (skip.has(entry.name)) return [];
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return /\.(ts|tsx|mts|js|mjs)$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name)
        ? [full]
        : [];
    });
  return ['apps', 'packages'].flatMap((top) =>
    readdirSync(path.join(ROOT, top), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(ROOT, top, entry.name, 'src'))
      .filter((dir) => existsSync(dir))
      .flatMap((dir) => walk(dir)),
  );
}
const relative = (file: string) => path.relative(ROOT, file).split(path.sep).join('/');

describe('the route #151 adds (static)', () => {
  it('is the one write, with no path parameter, so the request log line names no market', () => {
    const added = discoverRoutes().filter((route) => /visit/.test(route.key));
    expect(added.map((route) => route.key)).toEqual([ROUTE]);
    // The log line every request leaves carries the path and the route (logger.ts): the market
    // travels in the body (결정 6 — no time or address is kept with a visit).
    expect(added[0]!.path).not.toContain(':');
    expect(guardsOf(added[0]!)).toEqual([SessionGuard, OnboardedGuard]);
    expect(OWNER_ROUTES[ROUTE]).toMatchObject({ onboarded: true });
    expect(PUBLIC_ROUTES[ROUTE]).toBeUndefined();
  });

  it('leaves the writer `recordMarketVisit` to this module’s service alone', () => {
    // Imports of packages/db's writer: from the package, or within it from its own module (a
    // client-side sender of the web may share the name; it imports from elsewhere).
    const importsWriter =
      /import\s*(type\s*)?\{[^}]*\brecordMarketVisit\b[^}]*\}\s*from\s*'(@buddha\/db|\.\/market-visits\.js)'/;
    const importers = sourceFiles()
      .filter((file) => importsWriter.test(readFileSync(file, 'utf8')))
      .map(relative)
      .sort();
    expect(importers).toEqual(['apps/api/src/market-visits/market-visits.service.ts']);
  });

  it('lets only the schema, the writer, the reader, the purge and the test fixtures name the two tables (결정 6 쓰임, no relations)', () => {
    // The drizzle identifiers, and the SQL table names where a statement names a table — the bare
    // `market_visits` is also the purge kind, the period and the setting key, left alone.
    const identifier = /\b(marketVisits|marketVisitCollection)\b/;
    const table = /\b(FROM|JOIN|INTO|UPDATE|TABLE)\s+"?market_visit(s|_collection)\b/i;
    const allowed = [
      'apps/worker/src/jobs/retention-purge.ts',
      'packages/db/src/market-visits.ts',
      'packages/db/src/observation-metrics.ts',
      'packages/db/src/schema/index.ts',
      'packages/db/src/schema/market-visits.ts',
      'packages/db/src/test/visits.ts',
    ];
    const naming = sourceFiles()
      .filter((file) => {
        const text = readFileSync(file, 'utf8');
        return identifier.test(text) || table.test(text);
      })
      .map(relative)
      .sort();
    expect(naming.filter((file) => !allowed.includes(file))).toEqual([]);
    // Not vacuous: the definition, the one writer and the one reader are found.
    for (const file of [
      'packages/db/src/schema/market-visits.ts',
      'packages/db/src/market-visits.ts',
      'packages/db/src/observation-metrics.ts',
    ]) {
      expect(naming).toContain(file);
    }
    // No drizzle relation makes a visit reachable from an account or a market (`with: {…}`).
    expect(naming).not.toContain('packages/db/src/schema/relations.ts');
  });
});

describe.skipIf(!hasTestInfra)('/api/v1/me/market-visits (integration)', () => {
  let t: TestApp;
  let member: TestUser;
  let market: Awaited<ReturnType<typeof createMarket>>;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    member = await onboarded();
    market = await createMarket(t.db);
  });

  async function onboarded(): Promise<TestUser> {
    const user = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: user.id });
    return user;
  }

  const send = (
    payload: unknown,
    who: TestUser | null = member,
    headers: Record<string, string> = { origin: TRUSTED_ORIGIN },
  ) =>
    t.app.inject({
      method: 'POST',
      url: URL,
      headers: {
        'content-type': 'application/json',
        ...(who ? { cookie: who.cookie } : {}),
        ...headers,
      },
      payload: JSON.stringify(payload),
    });
  const visit = (who: TestUser = member, marketId: string = market.id) =>
    send({ expectedAccountId: who.id, marketId }, who);
  const codeOf = (res: { json: <T>() => T }) => res.json<{ error: { code: string } }>().error.code;

  /** The database clock's Korean date (ADR-0063), as a visit row holds it. */
  async function today(): Promise<string> {
    const { rows } = await t.db.execute<{ d: string }>(
      sql`SELECT to_char((now() AT TIME ZONE 'Asia/Seoul')::date, 'YYYY-MM-DD') AS d`,
    );
    return rows[0]!.d;
  }

  it('records the account, the market and the database clock’s Korean date, nothing else, with 204 and no body; a repeat the same day is merged (95-4)', async () => {
    const date = await today();
    const res = await visit();
    expect(res.statusCode, res.body).toBe(204);
    expect(res.body).toBe('');
    expect(await readVisits(t.db)).toEqual([{ userId: member.id, marketId: market.id, date }]);
    // The row's columns: the account, the market and the date — no time, address or device.
    const [row] = await t.db.select().from(schema.marketVisits);
    expect(Object.keys(row!).sort()).toEqual(['marketId', 'userId', 'visitDate']);

    // Again — a reload, Back, another tab — and the same market in upper case: one row.
    expect((await visit()).statusCode).toBe(204);
    expect(
      (await send({ expectedAccountId: member.id, marketId: market.id.toUpperCase() })).statusCode,
    ).toBe(204);
    expect(await readVisits(t.db)).toEqual([{ userId: member.id, marketId: market.id, date }]);

    // Another market, and another member: a row each.
    const other = await createMarket(t.db, { status: 'closed' });
    const second = await onboarded();
    expect((await visit(member, other.id)).statusCode).toBe(204);
    expect((await visit(second)).statusCode).toBe(204);
    expect(await readVisits(t.db)).toHaveLength(3);
  });

  it('answers 401 without a session and writes nothing', async () => {
    const res = await send({ expectedAccountId: member.id, marketId: market.id }, null);
    expect(res.statusCode).toBe(401);
    expect(codeOf(res)).toBe('UNAUTHENTICATED');
    expect(await readVisits(t.db)).toEqual([]);
  });

  it('refuses a foreign Origin (403) and lets a request without one through, as every write (SessionGuard)', async () => {
    const body = { expectedAccountId: member.id, marketId: market.id };
    const foreign = await send(body, member, { origin: 'https://evil.example' });
    expect(foreign.statusCode).toBe(403);
    expect(codeOf(foreign)).toBe('FORBIDDEN');
    expect(await readVisits(t.db)).toEqual([]);
    // No Origin: a server or a test, never a browser's cross-site form (session.guard.ts).
    const without = await send(body, member, {});
    expect(without.statusCode, without.body).toBe(204);
    expect(await readVisits(t.db)).toHaveLength(1);
  });

  it('refuses an expectedAccountId that is not the session’s account (403), writing nobody’s row', async () => {
    const other = await onboarded();
    const res = await send({ expectedAccountId: other.id, marketId: market.id });
    expect(res.statusCode).toBe(403);
    expect(codeOf(res)).toBe('FORBIDDEN');
    expect(await readVisits(t.db)).toEqual([]);
  });

  it('refuses a body that is not exactly { expectedAccountId, marketId } with a uuid (400)', async () => {
    for (const body of [
      { expectedAccountId: member.id, marketId: 'not-a-uuid' },
      { expectedAccountId: member.id },
      { marketId: market.id },
      { expectedAccountId: member.id, marketId: market.id, visitDate: '2026-01-01' },
    ]) {
      const res = await send(body);
      expect({ body, status: res.statusCode, code: codeOf(res) }).toEqual({
        body,
        status: 400,
        code: 'VALIDATION_ERROR',
      });
    }
    expect(await readVisits(t.db)).toEqual([]);
  });

  it('answers NOT_FOUND for a market that does not exist or is not public (DRAFT, REVIEW), as every public read', async () => {
    const draft = await createMarket(t.db, { status: 'draft' });
    const review = await createMarket(t.db, { status: 'review' });
    for (const marketId of ['00000000-0000-4000-8000-000000000000', draft.id, review.id]) {
      const res = await visit(member, marketId);
      expect({ marketId, status: res.statusCode, code: codeOf(res) }).toEqual({
        marketId,
        status: 404,
        code: 'NOT_FOUND',
      });
    }
    expect(await readVisits(t.db)).toEqual([]);
  });

  it('keeps no visit of an admin by its grant record, answering 204 all the same; an account with the role and no record is a member (151-3, 96-10)', async () => {
    const now = await clockTimestamp(t.db);
    const admin = await signUpTestUser(t);
    await grantAdminAt(t.db, admin.id, new Date(now.getTime() - HOUR_MS));
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, admin.id));
    await completeOnboarding(t.db, { userId: admin.id });
    const res = await visit(admin);
    expect(res.statusCode, res.body).toBe(204);
    expect(res.body).toBe('');
    expect(await readVisits(t.db)).toEqual([]);

    // The role alone, no grant record: a member for the metrics, so its visit is kept (96-10).
    const unrecorded = await onboarded();
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, unrecorded.id));
    expect((await visit(unrecorded)).statusCode).toBe(204);
    expect((await readVisits(t.db)).map((row) => row.userId)).toEqual([unrecorded.id]);
  });

  it('keeps no visit of an operating account, answering as for any other (151-3, #115)', async () => {
    // The market maker never signs in; its id reaching the service writes nothing and throws
    // nothing — the SQL filter leaves it out before the trigger would refuse it.
    const bot = await createMarketMakerAccount(t.db);
    await expect(t.app.get(MarketVisitsService).record(bot, market.id)).resolves.toBeUndefined();
    expect(await readVisits(t.db)).toEqual([]);
  });

  it('records a restricted member’s visit (95-1)', async () => {
    const operator = (await createUser(t.db, { role: 'admin' })).user.id;
    await createModerationAction(t.db, {
      userId: member.id,
      createdBy: operator,
      type: 'account_restriction',
      approvedBy: (await createUser(t.db, { role: 'admin' })).user.id,
    });
    expect((await visit()).statusCode).toBe(204);
    expect((await readVisits(t.db)).map((row) => row.userId)).toEqual([member.id]);
  });

  it('refuses an account that has not finished the onboarding, or whose consent a revision asks again, with ONBOARDING_REQUIRED and no row (151-4)', async () => {
    const fresh = await signUpTestUser(t);
    const notOnboarded = await visit(fresh);
    expect(notOnboarded.statusCode).toBe(409);
    expect(codeOf(notOnboarded)).toBe('ONBOARDING_REQUIRED');

    // Onboarded, then a revision that changed members' rights left its terms agreement behind.
    await t.db.delete(schema.consentRecords).where(eq(schema.consentRecords.userId, member.id));
    await createConsents(t.db, { userId: member.id, versions: { terms: 'draft-1999-01-01' } });
    const reconsent = await visit();
    expect(reconsent.statusCode).toBe(409);
    expect(reconsent.json<{ error: { code: string; details: unknown } }>().error).toMatchObject({
      code: 'ONBOARDING_REQUIRED',
      details: { steps: ['consent'] },
    });
    expect(await readVisits(t.db)).toEqual([]);
  });

  it('writes nothing on the public detail read, anonymous or signed in (a GET writes nothing)', async () => {
    for (const cookie of [undefined, member.cookie]) {
      for (const key of [market.id, market.slug]) {
        const res = await t.app.inject({
          method: 'GET',
          url: `/api/v1/markets/${key}`,
          headers: cookie ? { cookie } : {},
        });
        expect(res.statusCode, res.body).toBe(200);
      }
    }
    expect(await readVisits(t.db)).toEqual([]);
  });
});
