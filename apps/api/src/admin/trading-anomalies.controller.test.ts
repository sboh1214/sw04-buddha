import { schema } from '@buddha/db';
import {
  completeOnboarding,
  createMarket,
  createFillRecord,
  createUser,
  setReleaseSetting,
} from '@buddha/db/test';
import { TRADING_ANOMALY_SETTINGS, tradingAnomalyReportSchema } from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

const BASE = '/api/v1/admin/trading-anomalies';
describe.skipIf(!hasTestInfra)('private trading anomaly report API', () => {
  let t: TestApp;
  let admin: TestUser;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });
  beforeEach(async () => {
    await t.reset();
    admin = await signUpTestUser(t);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, admin.id));
    await completeOnboarding(t.db, { userId: admin.id });
    await t.app.get(AdminGuard).invalidate(admin.id);
  });
  const get = (url = BASE) =>
    t.app.inject({ method: 'GET', url, headers: { cookie: admin.cookie } });
  async function configure() {
    for (const [key, definition] of Object.entries(TRADING_ANOMALY_SETTINGS))
      await setReleaseSetting(t.db, {
        adminId: admin.id,
        key: definition.key,
        status: 'test',
        value: key.endsWith('Count') ? 2 : key.endsWith('Window') ? 10 : 60,
      });
  }
  async function fixture() {
    const market = await createMarket(t.db);
    const a = (await createUser(t.db)).user.id,
      b = (await createUser(t.db)).user.id;
    const first = await createFillRecord(t.db, {
      marketId: market.id,
      incomingOwnerId: a,
      restingOwnerId: b,
    });
    const second = await createFillRecord(t.db, {
      marketId: market.id,
      incomingOwnerId: b,
      restingOwnerId: a,
    });
    return { market, a, b, first, second };
  }
  it('refuses anonymous, member, and unfinished-admin access before any report', async () => {
    expect((await t.app.inject({ method: 'GET', url: BASE })).statusCode).toBe(401);
    const member = await signUpTestUser(t);
    expect(
      (await t.app.inject({ method: 'GET', url: BASE, headers: { cookie: member.cookie } }))
        .statusCode,
    ).toBe(403);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, member.id));
    await t.app.get(AdminGuard).invalidate(member.id);
    expect(
      (await t.app.inject({ method: 'GET', url: BASE, headers: { cookie: member.cookie } }))
        .statusCode,
    ).toBe(409);
  });
  it('returns explicit undecided signals and no invented settings, writes or candidate queue', async () => {
    const before = await t.db.select().from(schema.adminActions);
    const res = await get();
    expect(res.statusCode, res.body).toBe(200);
    const report = tradingAnomalyReportSchema.parse(res.json<{ data: unknown }>().data);
    expect(report.signals.map((row) => row.status)).toEqual(['undecided', 'undecided']);
    expect(report.source.complete).toBe(false);
    expect(report.candidates).toEqual([]);
    expect(await t.db.select().from(schema.adminActions)).toEqual(before);
    expect(await t.db.select().from(schema.releaseSettings)).toEqual([]);
  });
  it('returns actual fill evidence through an exact private allowlist without modifying economic records', async () => {
    await configure();
    const f = await fixture();
    const before = {
      audit: await t.db.select().from(schema.adminActions),
      orders: await t.db.select().from(schema.orders),
      fills: await t.db.select().from(schema.fills),
      ledger: await t.db.select().from(schema.ledgerEntries),
      balances: await t.db.select().from(schema.balances),
    };
    const res = await get();
    expect(res.statusCode, res.body).toBe(200);
    const report = tradingAnomalyReportSchema.parse(res.json<{ data: unknown }>().data);
    expect(report.candidates).toHaveLength(1);
    const row = report.candidates[0]!;
    expect(row).toMatchObject({ kind: 'human_pair', count: '2', market: { id: f.market.id } });
    expect(row.evidence.map((e) => e.first.fillId).sort()).toEqual(
      [String(f.first.fill.id), String(f.second.fill.id)].sort(),
    );
    expect(Object.keys(row).sort()).toEqual(
      [
        'id',
        'kind',
        'market',
        'actors',
        'outcome',
        'count',
        'quantity',
        'windowStartedAt',
        'windowEndedAt',
        'evidenceTotal',
        'evidenceTruncated',
        'evidence',
      ].sort(),
    );
    expect(Object.keys(row.evidence[0]!.first).sort()).toEqual(
      ['fillId', 'orderId', 'userId', 'at', 'outcome', 'side', 'priceCoin', 'qty'].sort(),
    );
    expect(Object.keys(row.actors[0]!).sort()).toEqual(['nickname', 'userId']);
    for (const forbidden of [
      'email',
      'phone',
      'ipAddress',
      'device',
      'clientAddress',
      'balanceCoin',
      'ledgerCoin',
      'adminId',
      'role',
    ])
      expect(res.body).not.toContain(`"${forbidden}"`);
    expect({
      audit: await t.db.select().from(schema.adminActions),
      orders: await t.db.select().from(schema.orders),
      fills: await t.db.select().from(schema.fills),
      ledger: await t.db.select().from(schema.ledgerEntries),
      balances: await t.db.select().from(schema.balances),
    }).toEqual(before);
  });
  it('filters a market without changing the source fills and distinguishes a ready empty report', async () => {
    await configure();
    await fixture();
    const other = await createMarket(t.db);
    const res = await get(`${BASE}?marketId=${other.id}`);
    expect(res.statusCode, res.body).toBe(200);
    const report = tradingAnomalyReportSchema.parse(res.json<{ data: unknown }>().data);
    expect(report).toMatchObject({
      marketId: other.id,
      source: { complete: true, scannedFills: 0 },
      candidates: [],
    });
  });
  it.each(['marketId=invalid', 'email=person@example.test', 'cursor=other-snapshot'])(
    'refuses unsupported query %s',
    async (query) => {
      expect((await get(`${BASE}?${query}`)).statusCode).toBe(400);
    },
  );
});
