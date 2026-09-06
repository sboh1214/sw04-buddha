/**
 * MarketPublisher against the docker `test` profile Redis (TEST_REDIS_URL). A second ioredis
 * client subscribes exactly the way the M4 gateway will, so this pins the channel names and
 * the wire format (JSON of the @buddha/shared event schemas).
 */
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { marketChannel, realtimeEventSchema, userChannel } from '@buddha/shared';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  REDIS,
  REDIS_COMMAND_TIMEOUT_MS,
  createRedisClient,
} from '../infra/redis/redis.provider.js';
import { createTestApp, type TestApp } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { MarketPublisher } from './market-publisher.js';

const MARKET_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

/** RESP arrays → argv; enough for the ioredis handshake and PUBLISH. */
function parseResp(buffer: Buffer): { commands: string[][]; rest: Buffer } {
  const commands: string[][] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf('\r\n', offset);
    if (lineEnd < 0) break;
    const count = Number(buffer.toString('latin1', offset + 1, lineEnd));
    let pos = lineEnd + 2;
    const args: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const lenEnd = buffer.indexOf('\r\n', pos);
      if (lenEnd < 0) return { commands, rest: buffer.subarray(offset) };
      const len = Number(buffer.toString('latin1', pos + 1, lenEnd));
      const start = lenEnd + 2;
      if (buffer.length < start + len + 2) return { commands, rest: buffer.subarray(offset) };
      args.push(buffer.toString('utf8', start, start + len));
      pos = start + len + 2;
    }
    commands.push(args);
    offset = pos;
  }
  return { commands, rest: buffer.subarray(offset) };
}

/**
 * A Redis that completes the handshake (+OK to HELLO, CLIENT SETINFO and the INFO ready check)
 * and then answers nothing from the first PUBLISH on — a live server that stopped serving.
 * Records the channels it was asked to publish on, in wire order.
 */
function listenStalledRedis(): Promise<{
  port: number;
  publishes: string[];
  close(): Promise<void>;
}> {
  const publishes: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let buffer: Buffer = Buffer.alloc(0);
    let stalled = false;
    socket.on('data', (chunk: Buffer) => {
      const parsed = parseResp(Buffer.concat([buffer, chunk]));
      buffer = parsed.rest;
      for (const [name = '', channel = ''] of parsed.commands) {
        if (name.toUpperCase() === 'PUBLISH') {
          stalled = true;
          publishes.push(channel);
        } else if (!stalled) {
          socket.write('+OK\r\n');
        }
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as AddressInfo).port,
        publishes,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      }),
    ),
  );
}

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

  it('bounds the wait when Redis keeps the connection but stops answering (commandTimeout)', async () => {
    // A server that accepts and never replies — not even to the ready check — so the PUBLISH
    // sits in the offline queue: the bound covers that queue as well as a reply that never
    // comes on a ready connection. Neither connectTimeout nor maxRetriesPerRequest ends this
    // wait; before commandTimeout the publish (and the HTTP response behind it) hung forever.
    const server = createServer((socket) => socket.on('data', () => undefined));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const stalled = createRedisClient(`redis://127.0.0.1:${String(port)}`, {
      commandTimeoutMs: 300,
    });
    const publisher = new MarketPublisher(stalled);
    const started = Date.now();
    try {
      await expect(
        publisher.publishUser('user-3', {
          type: 'user:balance',
          availableP: '1',
          lockedP: '0',
          ts: new Date().toISOString(),
        }),
      ).resolves.toBeUndefined();
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(250); // the timer, not an immediate rejection
      expect(elapsed).toBeLessThan(2_000);
    } finally {
      stalled.disconnect();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // The app's shared client carries the production bound.
    expect(t.app.get<Redis>(REDIS).options.commandTimeout).toBe(REDIS_COMMAND_TIMEOUT_MS);
  });

  it('bounds a PUBLISH whose reply never comes on a ready connection, once per batch', async () => {
    // The connection stays 'ready' (a timeout rejects the caller, not the socket), and the
    // services' shape — events issued back to back, awaited together — pays one bound for
    // the batch while the wire keeps the call order.
    const server = await listenStalledRedis();
    const stalled = createRedisClient(`redis://127.0.0.1:${String(server.port)}`, {
      commandTimeoutMs: 300,
    });
    try {
      await new Promise<void>((resolve) => stalled.once('ready', resolve));
      const publisher = new MarketPublisher(stalled);
      const ts = new Date().toISOString();
      const balance = { type: 'user:balance' as const, availableP: '1', lockedP: '0', ts };

      let started = Date.now();
      await expect(publisher.publishUser('user-3', balance)).resolves.toBeUndefined();
      let elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(1_500);
      expect(stalled.status).toBe('ready');

      started = Date.now();
      await Promise.all([
        publisher.publishMarket(MARKET_ID, {
          type: 'market:tick',
          marketId: MARKET_ID,
          pYesBp: 5200,
          lastPrice: 52,
          volumeP: '5125',
          tradeCount: 1,
          ts,
        }),
        publisher.publishUser('user-3', balance),
        publisher.publishUser('user-4', balance),
      ]);
      elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(700); // one bound, not three
      expect(server.publishes).toEqual([
        userChannel('user-3'),
        marketChannel(MARKET_ID),
        userChannel('user-3'),
        userChannel('user-4'),
      ]);
    } finally {
      stalled.disconnect();
      await server.close();
    }
  });
});
