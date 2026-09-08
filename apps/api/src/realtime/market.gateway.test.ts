/**
 * The `/ws` gateway against the docker `test` profile (TEST_DATABASE_URL / TEST_REDIS_URL),
 * driven by a real socket.io-client over a really listening port: `app.inject()` cannot perform
 * a WebSocket upgrade, so `createTestApp({ listen: true })` is what these need.
 *
 * There is no `subscribe` ack (MERGE-NOTES R8): the handler answers only when it refuses. So
 * the ordering barrier every test needs is `roundTrip()` — a deliberately invalid payload whose
 * `exception` proves the gateway has already applied everything this socket sent before it.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type AddressInfo, type Socket as NetSocket } from 'node:net';
import {
  REALTIME_NAMESPACE,
  REALTIME_ROOMS_MAX,
  REALTIME_SUBSCRIBE_MAX,
  RESYNC_EVENT,
  errorEnvelopeSchema,
  marketChannel,
  marketTickEventSchema,
  userBalanceEventSchema,
  type MarketTickEvent,
  type UserBalanceEvent,
} from '@buddha/shared';
import { Redis } from 'ioredis';
import {
  io,
  type ManagerOptions,
  type Socket as ClientSocket,
  type SocketOptions,
} from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Auth } from '../auth/auth.js';
import { AppError } from '../common/errors/app-error.js';
import {
  REDIS_ADAPTER_SUBSCRIBER,
  REDIS_SUBSCRIBER,
  createRedisClient,
} from '../infra/redis/redis.provider.js';
import { createTestApp, signUpTestUser, type TestApp } from '../test/app.js';
import { hasTestInfra } from '../test/setup-env.js';
import { sleep, waitForMessages } from '../test/wait.js';
import { MarketPublisher } from './market-publisher.js';
import { ARM_RETRY_MS, MarketGateway, SESSION_LOOKUP_ATTEMPTS } from './market.gateway.js';
import { REALTIME_EXCEPTION_EVENT, RealtimeExceptionFilter } from './realtime-exception.filter.js';

/** setup-env.ts fixes WEB_ORIGIN to this, so it is the one Origin the handshake accepts. */
const TRUSTED_ORIGIN = 'http://localhost:3000';

type ClientOptions = Partial<ManagerOptions & SocketOptions>;

function tickEvent(marketId: string, tradeCount = 1): MarketTickEvent {
  return {
    type: 'market:tick',
    marketId,
    pYesBp: 5200,
    lastPrice: 52,
    traderCount: 3,
    volumeP: '5125',
    tradeCount,
    ts: new Date().toISOString(),
  };
}

function balanceEvent(ledgerEntryId = '2'): UserBalanceEvent {
  return {
    type: 'user:balance',
    availableP: '4875',
    lockedP: '0',
    ledgerEntryId,
    ts: new Date().toISOString(),
  };
}

/** Every payload the socket receives for `event`, in arrival order. */
function collect<T>(socket: ClientSocket, event: string): T[] {
  const received: T[] = [];
  socket.on(event, (payload: T) => received.push(payload));
  return received;
}

function nextSocketEvent<T>(socket: ClientSocket, event: string, limitMs = 5_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`no "${event}" within ${String(limitMs)}ms`));
    }, limitMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

/**
 * One round trip through the gateway. `marketIds: []` fails `subscribeBodySchema.min(1)`, and
 * the gateway handles one socket's messages in order, so when its `exception` arrives every
 * earlier `subscribe` on that socket has been applied — and on a fresh socket the connection
 * handler (which joins `user:<id>`) has run. A bounded barrier, never a sleep.
 */
async function roundTrip(socket: ClientSocket): Promise<void> {
  const answered = nextSocketEvent(socket, REALTIME_EXCEPTION_EVENT);
  socket.emit('subscribe', { marketIds: [] });
  await answered;
}

function uuids(count: number): string[] {
  return Array.from({ length: count }, () => randomUUID());
}

/** `waitForMessages` for a condition instead of a length: a bounded poll, never a fixed sleep. */
async function waitUntil(ready: () => boolean, what: string): Promise<void> {
  const started = Date.now();
  while (!ready()) {
    if (Date.now() - started > 5_000) throw new Error(`${what}: still waiting`);
    await sleep(20);
  }
}

describe.skipIf(!hasTestInfra)('MarketGateway (integration)', () => {
  let t: TestApp;
  let publisher: MarketPublisher;
  const clients: ClientSocket[] = [];

  async function open(options: ClientOptions = {}): Promise<ClientSocket> {
    // forceNew: socket.io-client multiplexes one Manager per URL, so without it every test in
    // this file would share one connection (and one handshake).
    const socket = io(`${t.url!}${REALTIME_NAMESPACE}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      ...options,
    });
    clients.push(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('socket did not connect'));
      }, 5_000);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('connect_error', (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return socket;
  }

  beforeAll(async () => {
    t = await createTestApp({ listen: true });
    publisher = t.app.get(MarketPublisher);
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
  });
  afterEach(() => {
    for (const socket of clients.splice(0)) socket.disconnect();
  });

  it('delivers a market:tick to a subscribed anonymous socket in the shared DTO shape', async () => {
    const marketId = randomUUID();
    const socket = await open();
    const ticks = collect<unknown>(socket, 'market:tick');
    socket.emit('subscribe', { marketIds: [marketId] });
    await roundTrip(socket);

    const event = tickEvent(marketId);
    await publisher.publishMarket(marketId, event);
    await waitForMessages(ticks, 1, 'market:tick');
    // The gateway re-emits the event it parsed, so the wire format is the DTO end to end.
    expect(marketTickEventSchema.parse(ticks[0])).toEqual(event);
  });

  it('fans out locally: the Redis adapter carries nothing while an event is delivered', async () => {
    // THE CRUX. Every emit driven by the domain subscription must be `.local`; a
    // `namespace.to(room)` there would republish through @socket.io/redis-adapter and deliver
    // the event once per instance. That is silent in single-instance dev, so it is pinned here
    // directly and this test must not be deleted.
    const marketId = randomUUID();
    const watcher = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    const adapterMessages: string[] = [];
    try {
      watcher.on('pmessage', (_pattern, channel) => adapterMessages.push(channel));
      await watcher.psubscribe('socket.io#*');

      const socket = await open();
      const ticks = collect<unknown>(socket, 'market:tick');
      socket.emit('subscribe', { marketIds: [marketId] });
      await roundTrip(socket);
      await publisher.publishMarket(marketId, tickEvent(marketId));
      await waitForMessages(ticks, 1, 'market:tick');

      // Redis is single-threaded and this PING is issued after the delivery, so any adapter
      // PUBLISH made on the way would already have been pushed to this connection.
      expect(await watcher.ping()).toBe('PONG');
      expect(adapterMessages).toEqual([]);
    } finally {
      await watcher.quit();
    }
  });

  it('delivers to the subscribed socket only', async () => {
    const marketId = randomUUID();
    const subscribed = await open();
    const bystander = await open();
    const mine = collect<unknown>(subscribed, 'market:tick');
    const theirs = collect<unknown>(bystander, 'market:tick');
    subscribed.emit('subscribe', { marketIds: [marketId] });
    await roundTrip(subscribed);
    await roundTrip(bystander);

    await publisher.publishMarket(marketId, tickEvent(marketId));
    await waitForMessages(mine, 1, 'market:tick');
    // One synchronous `to(room).emit(...)` reaches every member, so the bystander would already
    // hold it if it were in the room: no settle window is needed.
    expect(theirs).toEqual([]);
  });

  it('joins user:<id> from the handshake session, and only that account receives it', async () => {
    const mine = await signUpTestUser(t);
    const theirs = await signUpTestUser(t);
    const own = await open({ extraHeaders: { cookie: mine.cookie, origin: TRUSTED_ORIGIN } });
    const other = await open({ extraHeaders: { cookie: theirs.cookie, origin: TRUSTED_ORIGIN } });
    await roundTrip(own);
    await roundTrip(other);
    const ownBalances = collect<unknown>(own, 'user:balance');
    const otherBalances = collect<unknown>(other, 'user:balance');

    const event = balanceEvent();
    await publisher.publishUser(mine.id, event);
    await waitForMessages(ownBalances, 1, 'user:balance');
    expect(userBalanceEventSchema.parse(ownBalances[0])).toEqual(event);
    // The private room is derived from the session, never requested, so no payload can reach it.
    expect(otherBalances).toEqual([]);
  });

  it('drops a user event published on a market channel (per-family parsing is the check)', async () => {
    const marketId = randomUUID();
    const socket = await open();
    const balances = collect<unknown>(socket, 'user:balance');
    const ticks = collect<unknown>(socket, 'market:tick');
    socket.emit('subscribe', { marketIds: [marketId] });
    await roundTrip(socket);

    const raw = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    try {
      await raw.publish(marketChannel(marketId), JSON.stringify(balanceEvent()));
    } finally {
      await raw.quit();
    }
    // Issued after the smuggled one and delivered on the same subscriber connection, so its
    // arrival proves the earlier message was already processed — and dropped.
    await publisher.publishMarket(marketId, tickEvent(marketId));
    await waitForMessages(ticks, 1, 'market:tick');
    expect(balances).toEqual([]);
  });

  it('canonicalises an UPPER-CASE market id into the room the publisher writes to (A-M3-17)', async () => {
    const marketId = randomUUID();
    const socket = await open();
    const ticks = collect<unknown>(socket, 'market:tick');
    socket.emit('subscribe', { marketIds: [marketId.toUpperCase()] });
    await roundTrip(socket);

    await publisher.publishMarket(marketId, tickEvent(marketId));
    await waitForMessages(ticks, 1, 'market:tick');
  });

  it('refuses a payload with a non-uuid and joins none of its ids', async () => {
    const wanted = randomUUID();
    const sentinel = randomUUID();
    const socket = await open();
    const ticks = collect<MarketTickEvent>(socket, 'market:tick');

    const refused = nextSocketEvent<unknown>(socket, REALTIME_EXCEPTION_EVENT);
    socket.emit('subscribe', { marketIds: [wanted, 'not-a-uuid'] });
    const envelope = errorEnvelopeSchema.parse(await refused);
    expect(envelope.error.code).toBe('VALIDATION_ERROR');
    expect(envelope.error.details).toEqual([{ path: ['marketIds', 1], message: 'must be a uuid' }]);

    // The whole payload is rejected before any join, so the valid id in it joined nothing.
    socket.emit('subscribe', { marketIds: [sentinel] });
    await roundTrip(socket);
    await publisher.publishMarket(wanted, tickEvent(wanted));
    await publisher.publishMarket(sentinel, tickEvent(sentinel));
    await waitForMessages(ticks, 1, 'market:tick');
    expect(ticks.map((event) => event.marketId)).toEqual([sentinel]);
  });

  it(`refuses more than ${String(REALTIME_SUBSCRIBE_MAX)} ids in one message`, async () => {
    const socket = await open();
    const refused = nextSocketEvent<unknown>(socket, REALTIME_EXCEPTION_EVENT);
    socket.emit('subscribe', { marketIds: uuids(REALTIME_SUBSCRIBE_MAX + 1) });
    expect(errorEnvelopeSchema.parse(await refused).error.code).toBe('VALIDATION_ERROR');
  });

  it(`caps a socket at ${String(REALTIME_ROOMS_MAX)} rooms, and a repeat costs no slot`, async () => {
    const socket = await open();
    const failures = collect<unknown>(socket, REALTIME_EXCEPTION_EVENT);
    const first = uuids(REALTIME_SUBSCRIBE_MAX);
    socket.emit('subscribe', { marketIds: first });
    // Re-sending ids the socket already holds must cost nothing: the gateway counts a dedicated
    // Set and skips a room it already has BEFORE it looks at the cap.
    socket.emit('subscribe', { marketIds: first });
    socket.emit('subscribe', { marketIds: uuids(REALTIME_SUBSCRIBE_MAX) });
    await roundTrip(socket);
    // The barrier's own refusal is the only one, and it is the barrier's: had the repeat
    // consumed slots, the third message would have hit the cap first and said so.
    expect(failures).toHaveLength(1);
    expect(errorEnvelopeSchema.parse(failures[0]).error.message).toBe('Request validation failed');

    // Exactly at the cap now, so one more id is refused.
    const refused = nextSocketEvent<unknown>(socket, REALTIME_EXCEPTION_EVENT);
    socket.emit('subscribe', { marketIds: [randomUUID()] });
    const envelope = errorEnvelopeSchema.parse(await refused);
    expect(envelope.error.code).toBe('VALIDATION_ERROR');
    expect(envelope.error.details).toEqual([
      { path: ['marketIds'], message: 'subscription limit reached' },
    ]);
  });

  it('stops delivery after unsubscribe, and a publish after disconnect is a no-op', async () => {
    const marketId = randomUUID();
    const sentinel = randomUUID();
    const socket = await open();
    const ticks = collect<MarketTickEvent>(socket, 'market:tick');
    socket.emit('subscribe', { marketIds: [marketId, sentinel] });
    await roundTrip(socket);
    await publisher.publishMarket(marketId, tickEvent(marketId));
    await waitForMessages(ticks, 1, 'market:tick');

    socket.emit('unsubscribe', { marketIds: [marketId] });
    await roundTrip(socket);
    await publisher.publishMarket(marketId, tickEvent(marketId, 2));
    await publisher.publishMarket(sentinel, tickEvent(sentinel));
    await waitForMessages(ticks, 2, 'sentinel market:tick');
    expect(ticks.filter((event) => event.marketId === marketId)).toHaveLength(1);

    socket.disconnect();
    // Nothing to fan out to and no Redis bookkeeping to undo: the room simply stopped existing.
    await expect(
      publisher.publishMarket(marketId, tickEvent(marketId, 3)),
    ).resolves.toBeUndefined();
  });

  it('refuses a foreign Origin at the engine level but admits a handshake with none', async () => {
    const foreign = io(`${t.url!}${REALTIME_NAMESPACE}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      extraHeaders: { origin: 'https://evil.example' },
    });
    clients.push(foreign);
    const error = await new Promise<Error>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('the foreign Origin was neither refused nor connected'));
      }, 5_000);
      foreign.once('connect_error', (cause: Error) => {
        clearTimeout(timer);
        resolve(cause);
      });
      foreign.once('connect', () => {
        clearTimeout(timer);
        reject(new Error('a foreign Origin completed the handshake'));
      });
    });
    expect(error).toBeInstanceOf(Error);

    // The `cors` option would have let both through (it omits the header, it does not abort),
    // so this pair is what proves the gate is `allowRequest`.
    const anonymous = await open();
    expect(anonymous.connected).toBe(true);
  });

  it('narrows the payload with the schema before the global pipe walks it', async () => {
    // The pipe runs before the handler either way, so what it is handed is the whole question.
    // With no schema on @MessageBody() it passes the value through and its NUL sweep — the one
    // walk in this app over an unvalidated, attacker-shaped structure — recurses the payload,
    // copying the path array at every level (quadratic in depth: ~33 ms of blocked event loop
    // for 4 KB of nesting, against ~0.02 ms for a legitimate 100-uuid body). With
    // `@MessageBody({ schema })` the schema strips this junk first, so the sweep only ever sees
    // the ids that survived it, and the subscription the junk rode along with is applied.
    // Unschema'd, the sweep instead finds the NUL at the bottom and refuses the whole message.
    const marketId = randomUUID();
    const socket = await open();
    const ticks = collect<unknown>(socket, 'market:tick');
    const failures = collect<unknown>(socket, REALTIME_EXCEPTION_EVENT);
    let junk: unknown = '\u0000';
    for (let depth = 0; depth < 200; depth += 1) junk = [junk];
    socket.emit('subscribe', { marketIds: [marketId], junk });
    await roundTrip(socket);

    await publisher.publishMarket(marketId, tickEvent(marketId));
    await waitForMessages(ticks, 1, 'market:tick');
    // The barrier's own refusal is the only one: the junk key cost the message nothing.
    expect(failures).toHaveLength(1);
  });
});

// --- the subscription's own lifecycle (Q-M3-7), driven without a socket server ---

type GatewayNamespace = Parameters<MarketGateway['afterInit']>[0];
/** Same trick as above: the socket shape the gateway itself declares, never a copy of it. */
type GatewaySocket = Parameters<MarketGateway['handleConnection']>[0];

interface RoomEmit {
  room: string;
  event: string;
  payload: unknown;
  volatile: boolean;
}

/**
 * The slice of a Socket.IO Namespace the gateway touches. Building it by hand keeps these tests
 * on the subscriber alone: no port, no client, no adapter.
 */
function fakeNamespace(rooms: readonly string[]) {
  const emits: RoomEmit[] = [];
  const control: string[] = [];
  const broadcast = (room: string, isVolatile: boolean) => ({
    emit: (event: string, payload: unknown) => {
      emits.push({ room, event, payload, volatile: isVolatile });
    },
  });
  // The handshake middleware is CAPTURED rather than dropped, so a test can drive the real one
  // `afterInit` registers instead of a copy of it — the wiring is half of what these pin.
  const middlewares: ((socket: GatewaySocket, next: (error?: Error) => void) => void)[] = [];
  const namespace = {
    adapter: { rooms: new Map(rooms.map((room) => [room, new Set<string>()])) },
    local: {
      emit: (event: string) => control.push(event),
      to: (room: string) => broadcast(room, false),
      volatile: { to: (room: string) => broadcast(room, true) },
    },
    use: (middleware: (socket: GatewaySocket, next: (error?: Error) => void) => void) => {
      middlewares.push(middleware);
    },
    server: { of: () => ({ use: () => undefined }) },
  };
  return { namespace: namespace as unknown as GatewayNamespace, emits, control, middlewares };
}

/** Republishes until the gateway has forwarded one, so the test never guesses at the arm. */
async function publishUntilForwarded(
  client: Redis,
  channel: string,
  message: string,
  forwarded: RoomEmit[],
): Promise<void> {
  const started = Date.now();
  while (forwarded.length === 0) {
    await client.publish(channel, message);
    if (forwarded.length > 0) return;
    if (Date.now() - started > 5_000) throw new Error(`nothing forwarded from ${channel}`);
    await sleep(20);
  }
}

/** What Redis answers a PSUBSCRIBE with: one confirmation per pattern, each with the count. */
function psubscribeConfirmations(patterns: readonly string[]): string {
  return patterns
    .map((pattern, index) => {
      const bytes = String(Buffer.byteLength(pattern));
      return `*3\r\n$10\r\npsubscribe\r\n$${bytes}\r\n${pattern}\r\n:${String(index + 1)}\r\n`;
    })
    .join('');
}

/** What the fake server writes back for the `nth` PSUBSCRIBE; `undefined` keeps it silent. */
type PsubscribeAnswer = (nth: number, patterns: string[]) => string | undefined;

/** A live-but-silent server: the case `ready` alone cannot recover from. */
const neverAnswers: PsubscribeAnswer = () => undefined;

/**
 * `-LOADING` for the first PSUBSCRIBE, a confirmation for every later one: a Redis that is up
 * and refusing, so the arm rejects with the command REMOVED from ioredis's queue and the next
 * one can succeed on the same connection (a rejection on `commandTimeout` leaves its entry in
 * the queue instead, and only a reconnect clears it — see redis.provider.ts).
 */
const loadingThenReady: PsubscribeAnswer = (nth, patterns) =>
  nth === 1
    ? '-LOADING Redis is loading the dataset in memory\r\n'
    : psubscribeConfirmations(patterns);

/**
 * RESP arrays → argv (the shape of market-publisher.test.ts's mock Redis, trimmed): answers the
 * ioredis handshake with +OK, records every PSUBSCRIBE, and writes back whatever `answer` makes
 * of it (`undefined` = stay silent). In-process, so a reply is written before the test's next
 * `psubscribes` observation returns.
 */
function listenFakeRedis(answer: PsubscribeAnswer): Promise<{
  port: number;
  psubscribes: string[][];
  close(): Promise<void>;
}> {
  const psubscribes: string[][] = [];
  const sockets = new Set<NetSocket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    let buffer: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const lineEnd = buffer.indexOf('\r\n');
        if (lineEnd < 0) break;
        const count = Number(buffer.toString('latin1', 1, lineEnd));
        let pos = lineEnd + 2;
        const args: string[] = [];
        let complete = true;
        for (let i = 0; i < count; i += 1) {
          const lenEnd = buffer.indexOf('\r\n', pos);
          if (lenEnd < 0) {
            complete = false;
            break;
          }
          const length = Number(buffer.toString('latin1', pos + 1, lenEnd));
          const start = lenEnd + 2;
          if (buffer.length < start + length + 2) {
            complete = false;
            break;
          }
          args.push(buffer.toString('utf8', start, start + length));
          pos = start + length + 2;
        }
        if (!complete) break;
        buffer = buffer.subarray(pos);
        if ((args[0] ?? '').toUpperCase() === 'PSUBSCRIBE') {
          psubscribes.push(args);
          const reply = answer(psubscribes.length, args.slice(1));
          if (reply !== undefined) socket.write(reply);
        } else socket.write('+OK\r\n');
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: (server.address() as AddressInfo).port,
        psubscribes,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      }),
    ),
  );
}

describe.skipIf(!hasTestInfra)('MarketGateway subscription lifecycle', () => {
  it('re-arms after a reconnect and tells clients to re-snapshot (Q-M3-7)', async () => {
    const marketId = randomUUID();
    const channel = marketChannel(marketId);
    const subscriber = createRedisClient(process.env.TEST_REDIS_URL!);
    const publisher = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    const { namespace, emits, control } = fakeNamespace([channel]);
    // Only the subscriber is exercised; the handshake session path is never reached.
    const gateway = new MarketGateway({} as unknown as Auth, subscriber);
    try {
      gateway.afterInit(namespace);
      const message = JSON.stringify(tickEvent(marketId));
      await publishUntilForwarded(publisher, channel, message, emits);
      expect(control).toEqual([]); // the first arm is not a gap

      // A dropped connection, not a shutdown: ioredis reconnects and emits `ready` again.
      subscriber.disconnect(true);
      await waitForMessages(control, 1, RESYNC_EVENT);
      expect(control).toEqual([RESYNC_EVENT]);

      // And the patterns really are live again, not merely reported so.
      emits.splice(0);
      await publishUntilForwarded(publisher, channel, message, emits);
      expect(emits[0]).toMatchObject({ room: channel, event: 'market:tick', volatile: true });
    } finally {
      gateway.onApplicationShutdown();
      await subscriber.quit();
      await publisher.quit();
    }
  });

  it('retries a failed session lookup before it admits a signed-in socket as anonymous', async () => {
    // THE HAZARD: the handshake reads the session ONCE and `handleConnection` joins `user:<id>`
    // from that reading alone, so a socket admitted anonymous stays anonymous for its whole
    // life — `onChannelMessage` drops every balance and position event for it, the client opens
    // one handshake per IDENTITY and so never rebuilds, and the tab goes on looking connected
    // while it is no longer told about its own money.
    //
    // Only a COOKIE-BEARING handshake can reach that catch: better-auth reads the session cookie
    // first and returns null without touching the adapter when there is none, so this retry is
    // never paid by a visitor who is not signed in.
    const subscriber = createRedisClient(process.env.TEST_REDIS_URL!);
    const { namespace, middlewares } = fakeNamespace([]);
    let calls = 0;
    const flaky = {
      api: {
        getSession: () => {
          calls += 1;
          if (calls < SESSION_LOOKUP_ATTEMPTS) return Promise.reject(new Error('store is down'));
          return Promise.resolve({ user: { id: 'u1' } });
        },
      },
    } as unknown as Auth;
    const gateway = new MarketGateway(flaky, subscriber);
    try {
      gateway.afterInit(namespace);
      const socket = { handshake: { headers: {} }, data: {} } as unknown as GatewaySocket;
      await new Promise<void>((resolve) => {
        // The middleware the gateway itself registered, so the registration is under test too.
        middlewares[0]!(socket, () => {
          resolve();
        });
      });

      expect(calls).toBe(SESSION_LOOKUP_ATTEMPTS);
      expect(socket.data.userId).toBe('u1');
    } finally {
      gateway.onApplicationShutdown();
      await subscriber.quit();
    }
  });

  it('still admits the socket when every attempt fails, rather than killing its public feed', async () => {
    // The degradation stays, and it is not timidity. `next(error)` on a NAMESPACE middleware is
    // a CONNECT_ERROR, and socket.io-client answers one with `destroy()` — "clean subscriptions
    // to avoid reconnections" — so refusing would cost the tab its public ticks too,
    // permanently and with no retry of its own. A silent partial loss is not worth trading for
    // a silent total one; PLAN 8 admits anonymous sockets and this keeps that true.
    const subscriber = createRedisClient(process.env.TEST_REDIS_URL!);
    const { namespace, middlewares } = fakeNamespace([]);
    let calls = 0;
    const down = {
      api: {
        getSession: () => {
          calls += 1;
          return Promise.reject(new Error('store is down'));
        },
      },
    } as unknown as Auth;
    const gateway = new MarketGateway(down, subscriber);
    try {
      gateway.afterInit(namespace);
      const socket = { handshake: { headers: {} }, data: {} } as unknown as GatewaySocket;
      const refusal = await new Promise<Error | undefined>((resolve) => {
        middlewares[0]!(socket, resolve);
      });

      expect(refusal).toBeUndefined();
      expect(calls).toBe(SESSION_LOOKUP_ATTEMPTS);
      expect(socket.data.userId).toBeUndefined();
      // And the socket is usable: `marketRooms` is what every subscribe counts against.
      expect(socket.data.marketRooms).toEqual(new Set());
    } finally {
      gateway.onApplicationShutdown();
      await subscriber.quit();
    }
  });

  it('retries a psubscribe that never gets an answer', async () => {
    // `ready` alone is not enough: commandTimeout rejects this PSUBSCRIBE and no later `ready`
    // follows, so without the bounded retry the gateway would stay deaf for good.
    const server = await listenFakeRedis(neverAnswers);
    const subscriber = createRedisClient(`redis://127.0.0.1:${String(server.port)}`, {
      commandTimeoutMs: 300,
      socketTimeoutMs: 5_000,
    });
    const { namespace } = fakeNamespace([]);
    const gateway = new MarketGateway({} as unknown as Auth, subscriber);
    try {
      gateway.afterInit(namespace);
      await waitForMessages(server.psubscribes, 2, 'a retried PSUBSCRIBE');
      expect(server.psubscribes[1]?.slice(1)).toEqual(['market:*', 'user:*']);
    } finally {
      gateway.onApplicationShutdown();
      subscriber.disconnect();
      await server.close();
    }
  });

  it('resyncs after a failed FIRST arm, not only after a re-arm', async () => {
    // The gap that matters is "an arm has failed since the last successful one", not "an arm has
    // ever succeeded". `afterInit` runs inside `app.init()`, which returns either way, and
    // `app.listen()` follows at once — so sockets connect and take their REST snapshots during
    // the retry window, and they are precisely the ones that missed events. Keying the resync on
    // the earlier arm's success suppresses it for exactly those clients.
    const server = await listenFakeRedis(loadingThenReady);
    const subscriber = createRedisClient(`redis://127.0.0.1:${String(server.port)}`);
    const { namespace, control } = fakeNamespace([]);
    const gateway = new MarketGateway({} as unknown as Auth, subscriber);
    try {
      gateway.afterInit(namespace);
      await waitForMessages(control, 1, RESYNC_EVENT);
      expect(control).toEqual([RESYNC_EVENT]);
      expect(server.psubscribes).toHaveLength(2);
    } finally {
      gateway.onApplicationShutdown();
      subscriber.disconnect();
      await server.close();
    }
  });

  it('drops the queued retry when an intervening re-arm succeeds', async () => {
    // A retry that outlives the arm it was queued for psubscribes a second time, and the gateway
    // is armed by then — so it announces a gap the re-arm already closed, and every connected
    // browser resnapshots twice. Measured as arms, not as resyncs: one reconnect must cost
    // exactly one PSUBSCRIBE.
    const server = await listenFakeRedis(loadingThenReady);
    const subscriber = createRedisClient(`redis://127.0.0.1:${String(server.port)}`);
    const { namespace, control } = fakeNamespace([]);
    const gateway = new MarketGateway({} as unknown as Auth, subscriber);
    try {
      gateway.afterInit(namespace);
      await waitForMessages(server.psubscribes, 1, 'the first PSUBSCRIBE');
      // The server is in this process and answered synchronously, so the boot arm has already
      // been rejected and its retry queued. Whether `ready` then re-armed inside this window is
      // an ioredis ordering detail (see the `arming` guard), so count rather than assume.
      await sleep(100);
      const armsBeforeReconnect = server.psubscribes.length;

      subscriber.disconnect(true);
      await waitForMessages(control, 1, RESYNC_EVENT);
      // Proving a timer does NOT fire needs a window rather than a barrier: wait past the moment
      // the queued retry was due.
      await sleep(ARM_RETRY_MS + 300);
      expect(server.psubscribes).toHaveLength(armsBeforeReconnect + 1);
    } finally {
      gateway.onApplicationShutdown();
      subscriber.disconnect();
      await server.close();
    }
  });

  it('schedules no retry once shutdown has run', async () => {
    // Clearing the timer is not enough on its own: the arm outstanding here rejects AFTER the
    // shutdown, and an unguarded catch would then psubscribe a connection RedisModule has quit —
    // which ioredis rejects synchronously, scheduling another. One warn per ARM_RETRY_MS for the
    // life of the process, which this file's own retry test above used to leave behind.
    const commandTimeoutMs = 300;
    const server = await listenFakeRedis(neverAnswers);
    const subscriber = createRedisClient(`redis://127.0.0.1:${String(server.port)}`, {
      commandTimeoutMs,
      socketTimeoutMs: 5_000,
    });
    const { namespace } = fakeNamespace([]);
    const gateway = new MarketGateway({} as unknown as Auth, subscriber);
    try {
      gateway.afterInit(namespace);
      await waitForMessages(server.psubscribes, 1, 'the first PSUBSCRIBE');
      gateway.onApplicationShutdown();
      // Past the rejection AND past the retry it would have queued.
      await sleep(commandTimeoutMs + ARM_RETRY_MS + 500);
      expect(server.psubscribes).toHaveLength(1);
    } finally {
      subscriber.disconnect();
      await server.close();
    }
  });
});

describe.skipIf(!hasTestInfra)('MarketGateway shutdown', () => {
  it('closes the socket server and both subscriber connections with a client attached', async () => {
    const t = await createTestApp({ listen: true });
    const socket = io(`${t.url!}${REALTIME_NAMESPACE}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    const subscriber = t.app.get<Redis>(REDIS_SUBSCRIBER);
    const adapterSubscriber = t.app.get<Redis>(REDIS_ADAPTER_SUBSCRIBER);
    try {
      await nextSocketEvent(socket, 'connect');
      // Nest closes the Socket.IO server (which closes every client) before the HTTP adapter,
      // and RedisModule.onApplicationShutdown runs after both — so this must not hang.
      await t.close();
      // `quit()` resolves on the +OK; the status settles when the socket then closes.
      await waitUntil(() => subscriber.status === 'end', 'the gateway subscriber to close');
      await waitUntil(() => adapterSubscriber.status === 'end', 'the adapter subscriber to close');
      expect(subscriber.status).toBe('end');
      expect(adapterSubscriber.status).toBe('end');
    } finally {
      socket.disconnect();
    }
  });
});

describe('RealtimeExceptionFilter', () => {
  function hostFor(emitted: { event: string; payload: unknown }[]) {
    const client = {
      emit: (event: string, payload: unknown) => emitted.push({ event, payload }),
    };
    return { switchToWs: () => ({ getClient: () => client }) } as unknown as Parameters<
      RealtimeExceptionFilter['catch']
    >[1];
  }

  it('renders an AppError as the PLAN 7 envelope, code and details intact', () => {
    const emitted: { event: string; payload: unknown }[] = [];
    new RealtimeExceptionFilter().catch(
      new AppError('VALIDATION_ERROR', {
        message: 'nope',
        details: [{ path: ['x'], message: 'y' }],
      }),
      hostFor(emitted),
    );
    expect(emitted).toEqual([
      {
        event: REALTIME_EXCEPTION_EVENT,
        payload: {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'nope',
            details: [{ path: ['x'], message: 'y' }],
          },
        },
      },
    ]);
  });

  it('renders anything else as INTERNAL without leaking the message', () => {
    const emitted: { event: string; payload: unknown }[] = [];
    new RealtimeExceptionFilter().catch(new Error('secret internal detail'), hostFor(emitted));
    expect(emitted).toEqual([
      {
        event: REALTIME_EXCEPTION_EVENT,
        payload: { error: { code: 'INTERNAL', message: 'Internal server error' } },
      },
    ]);
  });
});
