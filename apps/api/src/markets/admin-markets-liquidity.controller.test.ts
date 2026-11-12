/** #72: versions, review exclusion and opening through the real admin routes. */
import { schema } from '@buddha/db';
import {
  completeOnboarding,
  createMarket,
  createMarketInReview,
  prepareMarketMakerOpening,
  TEST_PRICE_PROTECTION_TICKS,
} from '@buddha/db/test';
import { MARKET_REVIEW_CHECKLIST, type AdminMarket } from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';

const headers = { origin: 'http://localhost:3000', 'content-type': 'application/json' };
// Explicit fixture values; none is a launch default.
const settings = {
  budgetCoin: '10000',
  maxLossCoin: '2000',
  b: 100,
  levels: 3,
  quantity: 5,
  safetyTicks: 1,
};
type Response = { statusCode: number; json: <T>() => T };
const detail = (response: Response) => response.json<{ data: AdminMarket }>().data;
const error = (response: Response) =>
  response.json<{
    error: { code: string; details?: { path: (string | number)[]; message: string }[] };
  }>().error;

describe.skipIf(!hasTestInfra)('admin market liquidity (integration)', () => {
  let t: TestApp;
  let creator: TestUser;
  let editor: TestUser;
  let reviewer: TestUser;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });
  async function makeAdmin() {
    const user = await signUpTestUser(t);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, user.id));
    await completeOnboarding(t.db, { userId: user.id });
    await t.app.get(AdminGuard).invalidate(user.id);
    return user;
  }
  beforeEach(async () => {
    await t.reset();
    creator = await makeAdmin();
    editor = await makeAdmin();
    reviewer = await makeAdmin();
  });
  const url = (id: string) => `/api/v1/admin/markets/${id}`;
  const get = (id: string) =>
    t.app.inject({ method: 'GET', url: url(id), headers: { cookie: creator.cookie } });
  const post = (path: string, user: TestUser, payload: Record<string, unknown> = {}) =>
    t.app.inject({
      method: 'POST',
      url: path,
      headers: { ...headers, cookie: user.cookie },
      payload: { expectedAccountId: user.id, ...payload },
    });
  const save = (id: string, payload: Record<string, unknown> = {}, user = editor) =>
    post(`${url(id)}/liquidity-settings`, user, {
      settings,
      baseVersion: null,
      reason: '예산과 손실 한도를 검토했다',
      ...payload,
    });
  const draft = (overrides: Parameters<typeof createMarket>[1] = {}) =>
    createMarket(t.db, {
      status: 'draft',
      createdBy: creator.id,
      tags: ['유동성'],
      priceProtectionTicks: TEST_PRICE_PROTECTION_TICKS,
      ...overrides,
    });
  const versions = (id: string) =>
    t.db
      .select()
      .from(schema.marketLiquidityVersions)
      .where(eq(schema.marketLiquidityVersions.marketId, id));
  const submit = (id: string) => post(`${url(id)}/submit`, creator);
  const approve = (market: AdminMarket, user = reviewer) =>
    post(`${url(market.id)}/approve`, user, {
      requestId: market.review.pending!.requestId,
      checklist: [...MARKET_REVIEW_CHECKLIST],
      reason: '규칙과 예산을 독립 검수했다',
    });

  it('requires explicit liquidity before review and stores exact Coin strings without moving funds', async () => {
    const market = await draft();
    expect(detail(await get(market.id)).liquidity).toEqual({
      current: null,
      openedVersion: null,
      history: [],
    });
    expect(error(await submit(market.id))).toMatchObject({
      code: 'OPEN_ITEMS_MISSING',
      details: [{ path: ['liquidity'], message: 'required' }],
    });
    const balances = await t.db.select().from(schema.balances);
    const ledger = await t.db.select().from(schema.ledgerEntries);
    const response = await save(market.id, {
      settings: { ...settings, budgetCoin: '1000000000000000' },
    });
    expect(response.statusCode).toBe(200);
    expect(detail(response).liquidity.current).toMatchObject({
      ...settings,
      budgetCoin: '1000000000000000',
      version: 1,
      createdBy: { id: editor.id },
    });
    expect(detail(response).missingOpenItems).not.toContain('liquidity');
    expect(await t.db.select().from(schema.balances)).toEqual(balances);
    expect(await t.db.select().from(schema.ledgerEntries)).toEqual(ledger);
  });

  it('appends history and audit with the prior version; rejects unchanged and stale forms', async () => {
    const market = await draft();
    expect((await save(market.id)).statusCode).toBe(200);
    const second = await save(market.id, {
      baseVersion: 1,
      settings: { ...settings, b: 150 },
      reason: '곡선 기울기를 다시 검토했다',
    });
    expect(second.statusCode).toBe(200);
    expect(detail(second).liquidity.history.map((row) => [row.version, row.b])).toEqual([
      [2, 150],
      [1, 100],
    ]);
    expect(error(await save(market.id, { baseVersion: 1 }))).toMatchObject({
      details: [{ path: ['baseVersion'], message: 'stale' }],
    });
    expect(
      error(await save(market.id, { baseVersion: 2, settings: { ...settings, b: 150 } })),
    ).toMatchObject({ details: [{ path: ['settings'], message: 'unchanged' }] });
    expect(await versions(market.id)).toHaveLength(2);
    const audit = await t.db
      .select()
      .from(schema.adminActions)
      .where(eq(schema.adminActions.targetId, market.id));
    expect(audit.map((row) => row.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          liquidity: { beforeVersion: 1, afterVersion: 2, settings: { ...settings, b: 150 } },
          reason: '곡선 기울기를 다시 검토했다',
        }),
      ]),
    );
  });

  it('serializes competing first saves so exactly one version and audit survive', async () => {
    const market = await draft();
    const responses = await Promise.all([
      save(market.id),
      save(market.id, { settings: { ...settings, b: 200 } }, reviewer),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 400]);
    expect(error(responses.find((response) => response.statusCode === 400)!)).toMatchObject({
      details: [{ path: ['baseVersion'], message: 'stale' }],
    });
    expect(await versions(market.id)).toHaveLength(1);
    expect(
      await t.db
        .select()
        .from(schema.adminActions)
        .where(eq(schema.adminActions.targetId, market.id)),
    ).toHaveLength(1);
  });

  it.each([
    ['budgetCoin', '0'],
    ['maxLossCoin', '10001'],
    ['budgetCoin', 10000],
    ['b', 0],
    ['b', 1e308],
    ['levels', 0],
    ['quantity', 1.5],
    ['safetyTicks', -1],
  ])('rejects invalid %s without a version or audit', async (key, value) => {
    const market = await draft();
    const response = await save(market.id, { settings: { ...settings, [key]: value } });
    expect(response.statusCode).toBe(400);
    expect(error(response).code).toBe('VALIDATION_ERROR');
    expect(await versions(market.id)).toEqual([]);
    expect(
      await t.db
        .select()
        .from(schema.adminActions)
        .where(eq(schema.adminActions.targetId, market.id)),
    ).toEqual([]);
  });

  it('rejects an account switch, a non-admin and a missing reason before writing', async () => {
    const market = await draft();
    const switched = await save(market.id, { expectedAccountId: creator.id });
    expect(switched.statusCode).toBe(403);
    expect(error(switched).details?.[0]?.path).toEqual(['expectedAccountId']);
    const user = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: user.id });
    expect((await save(market.id, {}, user)).statusCode).toBe(403);
    expect((await save(market.id, { reason: ' ' })).statusCode).toBe(400);
    expect(await versions(market.id)).toEqual([]);
  });

  it('counts a liquidity editor as an excluded reviewer and freezes the exact version at opening', async () => {
    const market = await draft();
    expect((await save(market.id)).statusCode).toBe(200);
    const submitted = await submit(market.id);
    expect(submitted.statusCode).toBe(200);
    const excluded = await approve(detail(submitted), editor);
    expect(excluded.statusCode).toBe(409);
    expect(error(excluded).code).toBe('APPROVAL_NOT_ALLOWED');
    expect(
      (await save(market.id, { baseVersion: 1, settings: { ...settings, b: 200 } })).statusCode,
    ).toBe(400);
    await prepareMarketMakerOpening(t.db, market.id);
    const opened = await approve(detail(submitted));
    expect(opened.statusCode).toBe(200);
    expect(detail(opened)).toMatchObject({
      status: 'open',
      liquidity: { openedVersion: 1, current: { version: 1, b: 100 } },
    });
    expect(
      (await save(market.id, { baseVersion: 1, settings: { ...settings, b: 200 } })).statusCode,
    ).toBe(400);
    expect(await versions(market.id)).toHaveLength(1);
    const publicDetail = await t.app.inject({ method: 'GET', url: `/api/v1/markets/${market.id}` });
    expect(publicDetail.statusCode).toBe(200);
    const publicMarket = publicDetail.json<{ data: Record<string, unknown> }>().data;
    for (const field of [
      'liquidity',
      'currentLiquidityVersion',
      'openedLiquidityVersion',
      'budgetCoin',
      'maxLossCoin',
    ])
      expect(publicMarket).not.toHaveProperty(field);
  });

  it('keeps scheduled settings locked until an explicit revert followed by new review', async () => {
    const market = await draft({
      scheduledOpenAt: new Date(Math.floor(Date.now() / 60_000) * 60_000 + 86_400_000),
    });
    await save(market.id);
    const submitted = detail(await submit(market.id));
    const scheduled = detail(await approve(submitted));
    expect(scheduled.status).toBe('scheduled');
    expect(scheduled.liquidity.openedVersion).toBeNull();
    expect(
      (await save(market.id, { baseVersion: 1, settings: { ...settings, b: 150 } })).statusCode,
    ).toBe(400);
    expect(
      (
        await post(`${url(market.id)}/revert`, creator, {
          reason: '개장 전에 예산을 다시 검토한다',
        })
      ).statusCode,
    ).toBe(200);
    const changed = await save(market.id, { baseVersion: 1, settings: { ...settings, b: 150 } });
    expect(changed.statusCode).toBe(200);
    expect(detail(changed)).toMatchObject({
      status: 'draft',
      liquidity: { current: { version: 2, b: 150 }, openedVersion: null },
    });
  });

  it('rechecks the liquidity gate when approving a legacy review without settings', async () => {
    const { market } = await createMarketInReview(t.db, {
      createdBy: creator.id,
      withoutLiquidity: true,
    });
    const before = detail(await get(market.id));
    const response = await approve(before);
    expect(response.statusCode).toBe(422);
    expect(error(response)).toMatchObject({
      code: 'OPEN_ITEMS_MISSING',
      details: [{ path: ['liquidity'], message: 'required' }],
    });
    const after = detail(await get(market.id));
    expect(after.status).toBe('review');
    expect(after.review.pending).toEqual(before.review.pending);
    expect(after.liquidity).toEqual({ current: null, openedVersion: null, history: [] });
  });

  it('serializes a setting edit with review submission without changing the submitted version later', async () => {
    const market = await draft();
    expect((await save(market.id)).statusCode).toBe(200);
    const [edited, submitted] = await Promise.all([
      save(market.id, { baseVersion: 1, settings: { ...settings, b: 150 } }),
      submit(market.id),
    ]);
    expect(submitted.statusCode).toBe(200);
    expect([200, 400]).toContain(edited.statusCode);
    if (edited.statusCode === 400) {
      expect(error(edited).details?.[0]?.path).toEqual(['status']);
    }
    const version = edited.statusCode === 200 ? 2 : 1;
    expect(detail(submitted)).toMatchObject({
      status: 'review',
      liquidity: { current: { version, b: version === 2 ? 150 : 100 } },
    });
    expect(detail(await get(market.id)).liquidity).toEqual(detail(submitted).liquidity);
    expect(await versions(market.id)).toHaveLength(version);
  });
});
