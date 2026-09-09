/**
 * The worker's publish path, and the ONE property the jobs depend on that nothing pinned before:
 * a publish is bounded. `market-close.test.ts` and `market-finalize.test.ts` are both skipped
 * without the docker `test` profile, so this suite deliberately needs no infrastructure — a
 * `node:net` server standing in for Redis, the way `health.test.ts` uses one for the probe.
 *
 * `parseResp` and `listenStalledRedis` are copies of `apps/api/src/realtime/market-publisher.test.ts`'s:
 * apps/worker may not import from apps/api (PLAN 4.1), and a test fixture is not a contract
 * between the two processes to hoist into @buddha/shared.
 */
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { marketChannel, userChannel, type MarketStatusEvent } from '@buddha/shared';
import { type Redis } from 'ioredis';
import { pino, type Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import { BULLMQ_REDIS_OPTIONS } from './queues.js';
import {
  REDIS_PUBLISH_COMMAND_TIMEOUT_MS,
  REDIS_PUBLISH_SOCKET_TIMEOUT_MS,
  createPublisher,
  createPublisherRedis,
} from './realtime.js';

const MARKET_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const statusEvent: MarketStatusEvent = {
  type: 'market:status',
  marketId: MARKET_ID,
  status: 'closed',
  resolvedResult: null,
  disputeUntil: null,
  statusEventId: '7',
  ts: '2026-09-09T00:00:00.000Z',
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const silent = (): Logger => pino({ level: 'silent' });

/** Collects the publisher's warn lines, so "logged and swallowed" is checkable. */
function recording(): { logger: Logger; lines: { msg?: string; channel?: string }[] } {
  const lines: { msg?: string; channel?: string }[] = [];
  const logger = pino(
    { level: 'warn' },
    { write: (line: string) => lines.push(JSON.parse(line) as { msg?: string }) },
  );
  return { logger, lines };
}

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

interface FakeRedis {
  url: string;
  publishes: string[];
  connections: () => number;
  close(): Promise<void>;
}

/**
 * A Redis that completes the handshake and then answers nothing from the first PUBLISH on — a
 * live server that stopped serving, which is the failure `commandTimeout` exists for. With
 * `handshake: false` it answers nothing at all, so a command never becomes writable and parks in
 * ioredis's offline queue instead: the other half of the same hazard.
 */
function listenFakeRedis(options: { handshake?: boolean } = {}): Promise<FakeRedis> {
  const handshake = options.handshake ?? true;
  const publishes: string[] = [];
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let buffer: Buffer = Buffer.alloc(0);
    let stalled = false;
    socket.on('data', (chunk: Buffer) => {
      const parsed = parseResp(Buffer.concat([buffer, chunk]));
      buffer = parsed.rest;
      if (!handshake) return;
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
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `redis://127.0.0.1:${String(port)}`,
        publishes,
        connections: () => connections,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      });
    }),
  );
}

/** One client event as a promise; not `events.once`, which turns ioredis's `error` into a throw. */
function nextEvent(client: Redis, event: 'ready' | 'close'): Promise<void> {
  return new Promise((resolve) => client.once(event, () => resolve()));
}

describe('createPublisherRedis', () => {
  it('carries the production bounds, and never the BullMQ connection’s options', () => {
    const redis = createPublisherRedis('redis://127.0.0.1:1', silent());
    try {
      expect(redis.options.commandTimeout).toBe(REDIS_PUBLISH_COMMAND_TIMEOUT_MS);
      expect(redis.options.socketTimeout).toBe(REDIS_PUBLISH_SOCKET_TIMEOUT_MS);
      // The default would resend the outstanding queue on reconnect, republishing events that
      // already timed out; with it false ioredis drops them when the socket goes.
      expect(redis.options.autoResendUnfulfilledCommands).toBe(false);
      // The one option that must NOT be shared with the BullMQ connection: `null` there is what
      // makes a queued command unrejectable, and a number here is what fails one fast.
      expect(redis.options.maxRetriesPerRequest).not.toBeNull();
      expect(BULLMQ_REDIS_OPTIONS.maxRetriesPerRequest).toBeNull();
    } finally {
      redis.disconnect();
    }
  });

  it('keeps the socket bound strictly above the command bound', () => {
    // A merely slow reply must fail on the caller's own bound and leave the connection up; only
    // total silence for twice that may take the socket down (A-M3-28).
    expect(REDIS_PUBLISH_SOCKET_TIMEOUT_MS).toBeGreaterThan(REDIS_PUBLISH_COMMAND_TIMEOUT_MS);
  });
});

describe('createPublisher', () => {
  it('bounds a publish parked in the offline queue (Redis accepts TCP and never answers)', async () => {
    // THE REGRESSION. On the shared BullMQ connection this publish never settles: ioredis pushes
    // a non-blocking command onto the offline queue with no timer of its own, and flushes that
    // queue with an error only when `maxRetriesPerRequest` is a NUMBER — which `null` is not. The
    // job that awaits it has already COMMITted, `runScan` is sequential and the queue is
    // `concurrency: 1`, so every market and every later close/settlement job stops behind it.
    const server = await listenFakeRedis({ handshake: false });
    const redis = createPublisherRedis(server.url, silent(), {
      commandTimeoutMs: 300,
      // High, so this case measures the command bound alone.
      socketTimeoutMs: 5_000,
    });
    const { logger, lines } = recording();
    const publish = createPublisher(redis, logger);
    const started = Date.now();
    try {
      // Resolves, never rejects: the transaction has committed, so the failure is swallowed.
      await expect(publish(marketChannel(MARKET_ID), statusEvent)).resolves.toBeUndefined();
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(3_000);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        msg: 'realtime publish failed',
        channel: marketChannel(MARKET_ID),
      });
    } finally {
      redis.disconnect();
      await server.close();
    }
  });

  it('costs one bound for a whole batch, in call order (the settlement shape)', async () => {
    // What `finalizeMarket` relies on: the status event and one pair per holder are issued back
    // to back and awaited together, so a Redis that stops answering costs one command timeout
    // for the batch rather than one per account.
    const server = await listenFakeRedis();
    const redis = createPublisherRedis(server.url, silent(), {
      commandTimeoutMs: 300,
      socketTimeoutMs: 5_000,
    });
    const publish = createPublisher(redis, silent());
    await nextEvent(redis, 'ready');
    const started = Date.now();
    try {
      await Promise.all([
        publish(marketChannel(MARKET_ID), statusEvent),
        publish(userChannel('user-a'), statusEvent as never),
        publish(userChannel('user-b'), statusEvent as never),
      ]);
      expect(Date.now() - started).toBeLessThan(900);
      expect(server.publishes).toEqual([
        marketChannel(MARKET_ID),
        userChannel('user-a'),
        userChannel('user-b'),
      ]);
    } finally {
      redis.disconnect();
      await server.close();
    }
  });

  it('drops the stalled backlog with the socket instead of republishing it', async () => {
    // `commandTimeout` frees the caller but not the queue entry — that leaves `commandQueue`
    // only on a reply or a close — so a connection that answers the handshake and then goes
    // silent would accumulate one entry per publish. `socketTimeout` closes it, and
    // `autoResendUnfulfilledCommands: false` makes ioredis DROP those entries rather than
    // resend them on the next `ready`: a settled market must never republish a payout event.
    const server = await listenFakeRedis();
    const redis = createPublisherRedis(server.url, silent(), {
      commandTimeoutMs: 200,
      socketTimeoutMs: 600,
    });
    const publish = createPublisher(redis, silent());
    await nextEvent(redis, 'ready');
    try {
      await Promise.all([
        publish(marketChannel(MARKET_ID), statusEvent),
        publish(userChannel('user-a'), statusEvent as never),
      ]);
      await nextEvent(redis, 'close');
      await nextEvent(redis, 'ready');
      expect(server.connections()).toBeGreaterThanOrEqual(2);
      // The second socket carried no repeat of either event.
      expect(server.publishes).toEqual([marketChannel(MARKET_ID), userChannel('user-a')]);
    } finally {
      redis.disconnect();
      await server.close();
    }
  });

  it('leaves an idle connection alone', async () => {
    // The socket bound is armed only while a command is outstanding, so the publisher — which
    // idles a full minute between scans — must not be torn down for being quiet.
    const server = await listenFakeRedis();
    const redis = createPublisherRedis(server.url, silent(), {
      commandTimeoutMs: 200,
      socketTimeoutMs: 300,
    });
    try {
      await nextEvent(redis, 'ready');
      await sleep(900);
      expect(redis.status).toBe('ready');
      expect(server.connections()).toBe(1);
    } finally {
      redis.disconnect();
      await server.close();
    }
  });

  it('never throws when the connection is refused outright', async () => {
    // The warn-and-swallow contract, on the deployed option set rather than a hand-rolled
    // client: a throw here would put a finished close or settlement in the failed set, and the
    // retry would find the market already closed and never republish anyway.
    const redis = createPublisherRedis('redis://127.0.0.1:1', silent());
    const { logger, lines } = recording();
    const publish = createPublisher(redis, logger);
    try {
      await expect(publish(marketChannel(MARKET_ID), statusEvent)).resolves.toBeUndefined();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ msg: 'realtime publish failed' });
    } finally {
      redis.disconnect();
    }
  });
});
