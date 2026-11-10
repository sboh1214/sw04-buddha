import { randomUUID } from 'node:crypto';
import { readMarketMakerRuntime, runMarketMakerCycle, schema } from '@buddha/db';
import {
  completeOnboarding,
  createOpenedMarket,
  createStartGrant,
  createUser,
  openOrderIntake,
} from '@buddha/db/test';
import { placeOrderResultSchema } from '@buddha/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketJobs } from '../jobs/market-jobs.service.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { OrderService } from './order.service.js';

describe.skipIf(!hasTestInfra)('member fill maker trigger (#129)', () => {
  let t: TestApp;
  let member: TestUser;
  let marketId: string;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t?.close();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  beforeEach(async () => {
    await t.reset();
    const adminId = (await createUser(t.db, { role: 'admin' })).user.id;
    await openOrderIntake(t.db, { adminId });
    member = await signUpTestUser(t);
    await completeOnboarding(t.db, { userId: member.id });
    await createStartGrant(t.db, { userId: member.id, amountCoin: 1_000n });
    const { market } = await createOpenedMarket(t.db, {
      liquiditySettings: {
        budgetCoin: 10_000n,
        maxLossCoin: 5_000n,
        b: 100_000,
        levels: 3,
        quantity: 10,
        safetyTicks: 1,
      },
    });
    marketId = market.id;
    await t.db.transaction((tx) => runMarketMakerCycle(tx, { marketId }));
  });
  const send = (requestId = randomUUID(), price = 52) =>
    t.app.inject({
      method: 'POST',
      url: `/api/v1/markets/${marketId}/orders`,
      headers: {
        origin: 'http://localhost:3000',
        cookie: member.cookie,
        'content-type': 'application/json',
        'idempotency-key': requestId,
      },
      payload: JSON.stringify({
        expectedAccountId: member.id,
        outcome: 'YES',
        side: 'buy',
        timeInForce: 'ioc',
        limitPriceCoin: price,
        qty: 1,
      }),
    });

  it('enqueues only the committed MM fill generation; replay and an unfilled intake do not enqueue', async () => {
    const enqueue = vi
      .spyOn(t.app.get(MarketJobs), 'refreshMarketMaker')
      .mockImplementation(async (id, generation) => {
        expect(await readMarketMakerRuntime(t.db, id)).toMatchObject({
          generation,
          completedGeneration: 1n,
        });
        expect(await t.db.select().from(schema.fills)).toHaveLength(1);
      });
    const requestId = randomUUID();
    const response = await send(requestId);
    expect(response.statusCode, response.body).toBe(200);
    const data = response.json<{ data: unknown }>().data;
    expect(data).toEqual(placeOrderResultSchema.parse(data));
    expect(data).toMatchObject({ replayed: false, order: { filledQty: 1 } });
    expect(response.body).not.toMatch(/marketMakerGeneration|desiredEnabled|configVersion/);
    expect(enqueue).toHaveBeenCalledExactlyOnceWith(marketId, 2n);
    expect((await send(requestId)).statusCode).toBe(200);
    expect((await send(randomUUID(), 1)).statusCode).toBe(200);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('rolls back the fill and generation without any enqueue or event if the response snapshot fails', async () => {
    const service = t.app.get(OrderService);
    const enqueue = vi
      .spyOn(t.app.get(MarketJobs), 'refreshMarketMaker')
      .mockResolvedValue(undefined);
    const publishMarket = vi
      .spyOn(t.app.get(MarketPublisher), 'publishMarket')
      .mockResolvedValue(undefined);
    const publishUser = vi
      .spyOn(t.app.get(MarketPublisher), 'publishUser')
      .mockResolvedValue(undefined);
    const before = await readMarketMakerRuntime(t.db, marketId);
    // This projection is inside the real economic transaction, after placeOrder changed rows.
    vi.spyOn(
      service as unknown as { marketRef: () => Promise<never> },
      'marketRef',
    ).mockRejectedValueOnce(new Error('fixture snapshot failure'));
    expect((await send()).statusCode).toBe(500);
    expect(await t.db.select().from(schema.fills)).toEqual([]);
    expect(await readMarketMakerRuntime(t.db, marketId)).toEqual(before);
    expect(enqueue).not.toHaveBeenCalled();
    expect(publishMarket).not.toHaveBeenCalled();
    expect(publishUser).not.toHaveBeenCalled();
  });
});
