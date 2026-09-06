/**
 * MarketPublisher against the docker `test` profile Redis (TEST_REDIS_URL). A second ioredis
 * client subscribes exactly the way the M4 gateway will, so this pins the channel names and
 * the wire format (JSON of the @buddha/shared event schemas).
 */
import { marketChannel, realtimeEventSchema, userChannel } from '@buddha/shared';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { MarketPublisher } from './market-publisher.js';

const MARKET_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

describe.skipIf(!hasTestInfra)('MarketPublisher (integration)', () => {
  let t: TestApp;
  let subscriber: Redis;

  beforeAll(async () => {
    t = await createTestApp();
    subscriber = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    await subscriber.subscribe(marketChannel(MARKET_ID), userChannel('user-1'));
  });
  afterAll(async () => {
    await subscriber?.quit();
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });

  it('publishes market and user events as JSON on the PLAN 8 channels', async () => {
    const received: { channel: string; message: string }[] = [];
    subscriber.on('message', (channel, message) => received.push({ channel, message }));
    const publisher = t.app.get(MarketPublisher);
    const ts = new Date().toISOString();

    await publisher.publishMarket(MARKET_ID, {
      type: 'market:tick',
      marketId: MARKET_ID,
      pYesBp: 5200,
      lastPrice: 52,
      volumeP: '5125',
      tradeCount: 1,
      ts,
    });
    await publisher.publishUser('user-1', {
      type: 'user:balance',
      availableP: '4875',
      lockedP: '0',
      ts,
    });

    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const poll = () => {
        if (received.length >= 2) return resolve();
        if (Date.now() - started > 5_000) return reject(new Error('events not received'));
        setTimeout(poll, 20);
      };
      poll();
    });

    expect(received.map((r) => r.channel)).toEqual([
      marketChannel(MARKET_ID),
      userChannel('user-1'),
    ]);
    // The gateway and the browser parse with the shared schema: the wire format is the DTO.
    for (const { message } of received) {
      expect(realtimeEventSchema.safeParse(JSON.parse(message)).success).toBe(true);
    }
    expect(JSON.parse(received[0]!.message)).toMatchObject({ type: 'market:tick', lastPrice: 52 });
  });

  it('never throws after the transaction has committed: a dead Redis is logged, not raised', async () => {
    const dead = new Redis('redis://127.0.0.1:1', {
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      lazyConnect: true,
    });
    dead.on('error', () => undefined);
    const publisher = new MarketPublisher(dead);
    await expect(
      publisher.publishUser('user-2', {
        type: 'user:balance',
        availableP: '1',
        lockedP: '0',
        ts: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined();
    dead.disconnect();
  });
});
