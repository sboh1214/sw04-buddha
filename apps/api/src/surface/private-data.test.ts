/**
 * #113 at run time, against the docker `test` profile. Account A's private data is in the
 * database — email, nickname, real name and phone, password and session, a balance and a ledger
 * memo, orders and the fill one of them got against another account's resting order, a position
 * with its PnL, a payment. Then:
 * - every registered public route (registry.ts) is called anonymously, as another account B and
 *   as A itself, and no answer may hold one of A's values or a field PRIVATE_DATA names, nor a
 *   field naming an excluded feature;
 * - every registered owner-only route is called as B, aimed at A wherever it takes an id or an
 *   account, and no answer may hold A's values; the same request as A shows them, so the check
 *   is not blind (N04 §7 "다른 사용자가 비공개 자산·주문을 조회할 수 없어야 한다");
 * - the market room is listened to, anonymously and as B, while A's own events are published and
 *   smuggled onto the market channel and the API publishes a real market event.
 *
 * The routes come from the registry, which registry.test.ts holds to the module graph; this file
 * only knows how to call them. A route whose parameters or body it does not know fails the run
 * until a case is written here.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { schema } from '@buddha/db';
import { createMarket, createUser } from '@buddha/db/test';
import {
  REALTIME_EVENT_REGISTRY,
  REALTIME_EXCEPTION_EVENT,
  REALTIME_NAMESPACE,
  findExcludedIdentifier,
  findPrivateField,
  marketChannel,
  type UserRealtimeEvent,
} from '@buddha/shared';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { io, type Socket as ClientSocket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminGuard } from '../auth/admin.guard.js';
import { MarketPublisher } from '../realtime/market-publisher.js';
import { createTestApp, signUpTestUser, type TestApp, type TestUser } from '../test/app.js';
import { discoverRoutes, type DiscoveredRoute } from '../test/routes.js';
import { hasTestInfra } from '../test/setup-env.js';
import { sleep } from '../test/wait.js';
import { OWNER_ROUTES, PUBLIC_ROUTES } from './registry.js';

/** setup-env.ts fixes WEB_ORIGIN to this. */
const ORIGIN = 'http://localhost:3000';

type MarketRow = typeof schema.markets.$inferSelect;

/**
 * One of A's values. `text` is looked for anywhere in an answer (ids, addresses, names, keys);
 * `amount` is a number, and matches a JSON value equal to it, so a uuid that happens to hold
 * its digits is not a leak.
 */
interface Sentinel {
  readonly label: string;
  readonly value: string;
  readonly kind: 'text' | 'amount';
}

interface Fixture {
  a: TestUser;
  b: TestUser;
  admin: TestUser;
  /** Open; A holds a position in it, has two orders in it and one fill. */
  market: MarketRow;
  paymentId: string;
  sentinels: readonly Sentinel[];
}

/** Letters only, so the value passes the real-name rule as typed by a person would. */
function letters(count: number): string {
  return Array.from({ length: count }, () => String.fromCharCode(97 + randomInt(26))).join('');
}

const AMOUNTS = {
  available: 7_654_321n,
  locked: 1_234_567n,
  positionQty: 86_421,
  costBasis: 2_718_281n,
  realizedPnl: 3_141_593n,
} as const;

/** The fill everyone may see: anonymous, so its numbers are public (N01 §5). */
const PUBLIC_FILL = { qty: 13, amountCoin: 793n, priceAvgBp: 6_100 } as const;

const routes = discoverRoutes();

function routeOf(key: string): DiscoveredRoute {
  const route = routes.find((candidate) => candidate.key === key);
  if (!route) throw new Error(`${key} is registered but not served (registry.test.ts says so)`);
  return route;
}

// ---- reading an answer ------------------------------------------------------------------

function walk(value: unknown, visit: (key: string | null, scalar: unknown) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      visit(key, undefined);
      walk(item, visit);
    }
  } else {
    visit(null, value);
  }
}

function parse(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

/** The labels of the values an answer holds. */
function leakedValues(body: string, sentinels: readonly Sentinel[]): string[] {
  const scalars = new Set<string>();
  walk(parse(body), (key, scalar) => {
    if (key === null && (typeof scalar === 'string' || typeof scalar === 'number')) {
      scalars.add(String(scalar));
    }
  });
  return sentinels
    .filter((sentinel) =>
      sentinel.kind === 'text' ? body.includes(sentinel.value) : scalars.has(sentinel.value),
    )
    .map((sentinel) => sentinel.label);
}

/** The fields of an answer that carry private data or name an excluded feature. */
function forbiddenFields(body: string): string[] {
  const keys = new Set<string>();
  walk(parse(body), (key) => {
    if (key !== null) keys.add(key);
  });
  return [...keys].flatMap((key) => [
    ...findPrivateField(key).map((hit) => `${key}: ${hit.item}`),
    ...findExcludedIdentifier(key, 'api').map((hit) => `${key}: ${hit.feature}`),
  ]);
}

// ---- the cases ---------------------------------------------------------------------------

/** Path parameters of the public routes, by name: A's market. */
const PUBLIC_PARAMS: Readonly<Record<string, (fixture: Fixture) => string>> = {
  id: (fixture) => fixture.market.id,
  idOrSlug: (fixture) => fixture.market.slug,
};

/** Bodies of the public routes that take one: A's own address, the request most about A. */
const PUBLIC_BODIES: Readonly<Record<string, (fixture: Fixture) => unknown>> = {
  'POST /auth/register': (fixture) => ({ email: fixture.a.email }),
};

interface OwnerCase {
  /** Path parameters by name, naming A's records. */
  params?: Readonly<Record<string, (fixture: Fixture) => string>>;
  /** What B sends: A's account wherever the body names one. */
  body?: (fixture: Fixture) => unknown;
  /** B's answer. */
  status: number;
  /**
   * A's values the same request shows A: proof they were there to leak. Left out for a
   * write, which would change A.
   */
  own?: readonly string[];
}

const OWNER_CASES: Readonly<Record<string, OwnerCase>> = {
  'GET /me': {
    status: 200,
    own: ['email', 'nickname', 'real name', 'phone', 'available balance', 'locked balance'],
  },
  'PATCH /me': { body: () => ({ nickname: `b_${letters(8)}` }), status: 200 },
  'POST /me/password': {
    body: (fixture) => ({ newPassword: 'another-password-1', expectedAccountId: fixture.a.id }),
    status: 403,
  },
  'PUT /me/contact': {
    body: (fixture) => ({
      realName: '다른사람',
      phone: '01012345678',
      expectedAccountId: fixture.a.id,
    }),
    status: 403,
  },
  'GET /me/ledger': { status: 200, own: ['ledger memo'] },
  'GET /me/payments': { status: 200, own: ['payment id'] },
  'GET /me/payments/:id': {
    params: { id: (fixture) => fixture.paymentId },
    status: 404,
    own: ['payment id'],
  },
  'GET /me/positions': {
    status: 200,
    own: ['position qty', 'cost basis', 'realized pnl'],
  },
  'GET /me/orders': { status: 200, own: ['filled order id', 'open order id'] },
  'POST /payments/charge': {
    body: (fixture) => ({
      packageId: randomUUID(),
      expectedAmountCoin: '10000',
      expectedPriceKrw: 9_700,
      expectedAccountId: fixture.a.id,
    }),
    status: 404,
  },
  'POST /coupons/redeem': {
    body: (fixture) => ({ code: 'LEAK-CHECK', expectedAccountId: fixture.a.id }),
    status: 404,
  },
};

const SAFE_METHODS = new Set(['GET', 'HEAD']);

/** The parameter names of a route: `id` of `/me/payments/:id`. */
const paramsOf = (route: DiscoveredRoute) => [...route.url.matchAll(/:(\w+)/g)].map((m) => m[1]!);

/** Each parameter's value for this fixture. */
function valuesOf(
  params: Readonly<Record<string, (fixture: Fixture) => string>> | undefined,
  fixture: Fixture,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params ?? {}).map(([name, value]) => [name, value(fixture)]),
  );
}

describe('private data cases (static)', () => {
  // So a route nobody wrote a case for fails without a database too.
  it('knows how to call every registered public route', () => {
    const missing = Object.keys(PUBLIC_ROUTES).flatMap((key) => {
      const route = routeOf(key);
      return [
        ...paramsOf(route)
          .filter((name) => !(name in PUBLIC_PARAMS))
          .map((name) => `${key} :${name}`),
        ...(SAFE_METHODS.has(route.method) || key in PUBLIC_BODIES ? [] : [`${key} body`]),
      ];
    });
    expect(missing).toEqual([]);
  });

  it('has a cross-account case for every registered owner-only route', () => {
    expect(Object.keys(OWNER_CASES).sort()).toEqual(Object.keys(OWNER_ROUTES).sort());
    const missing = Object.entries(OWNER_CASES).flatMap(([key, ownerCase]) => {
      const route = routeOf(key);
      return [
        ...paramsOf(route)
          .filter((name) => !(name in (ownerCase.params ?? {})))
          .map((name) => `${key} :${name}`),
        ...(SAFE_METHODS.has(route.method) || ownerCase.body ? [] : [`${key} body`]),
      ];
    });
    expect(missing).toEqual([]);
  });
});

describe.skipIf(!hasTestInfra)('private data in public and owner-only answers (#113)', () => {
  let t: TestApp;
  let f: Fixture;
  const sockets: ClientSocket[] = [];

  beforeAll(async () => {
    // Listening: the realtime case needs a real socket.io handshake; inject() serves the rest.
    t = await createTestApp({ listen: true });
  });
  afterAll(async () => {
    await t?.close(); // undefined when beforeAll timed out waiting for the file lock
  });
  beforeEach(async () => {
    await t.reset();
    f = await seed();
  });
  afterEach(() => {
    for (const socket of sockets.splice(0)) socket.disconnect();
  });

  async function seed(): Promise<Fixture> {
    const tag = randomUUID().replaceAll('-', '').slice(0, 10);
    const a = await signUpTestUser(t, {
      email: `leak-a-${tag}@test.local`,
      password: `pw-${tag}-secret`,
    });
    const b = await signUpTestUser(t);
    const admin = await signUpTestUser(t);
    await t.db
      .update(schema.profiles)
      .set({ role: 'admin' })
      .where(eq(schema.profiles.userId, admin.id));
    await t.app.get(AdminGuard).invalidate(admin.id);

    const nickname = `leak_${tag}`;
    await t.db.update(schema.profiles).set({ nickname }).where(eq(schema.profiles.userId, a.id));
    const realName = `숨김${letters(8)}`;
    const phone = `010${String(randomInt(10_000_000, 100_000_000))}`;
    await t.db.insert(schema.userContacts).values({ userId: a.id, realName, phone });

    // The balance as the books would have it: the change is an ADMIN_ADJUST entry.
    const [before] = await t.db
      .select()
      .from(schema.balances)
      .where(eq(schema.balances.userId, a.id));
    const memo = `leak-memo-${tag}`;
    await t.db
      .update(schema.balances)
      .set({ availableCoin: AMOUNTS.available, lockedCoin: AMOUNTS.locked })
      .where(eq(schema.balances.userId, a.id));
    await t.db.insert(schema.ledgerEntries).values({
      userId: a.id,
      type: 'ADMIN_ADJUST',
      amountCoin: AMOUNTS.available - before!.availableCoin,
      balanceAfterCoin: AMOUNTS.available,
      memo,
    });

    const market = await createMarket(t.db, {
      createdBy: admin.id,
      lastPrice: 61,
      volumeCoin: PUBLIC_FILL.amountCoin,
      tradeCount: 1,
    });
    // The other side of A's fill: a resting order of a third account (the counterparty).
    const maker = await createUser(t.db);
    const order = (values: {
      userId: string;
      side: 'buy' | 'sell';
      type: 'limit' | 'market';
      qty: number;
      filledQty?: number;
      key: string;
    }) =>
      t.db
        .insert(schema.orders)
        .values({
          userId: values.userId,
          marketId: market.id,
          outcome: 'YES',
          side: values.side,
          type: values.type,
          limitPrice: values.type === 'limit' ? (values.side === 'sell' ? 61 : 40) : null,
          qty: values.qty,
          filledQty: values.filledQty ?? 0,
          status: values.filledQty === values.qty ? 'filled' : 'open',
          timeInForce: values.type === 'limit' ? 'gtc' : 'ioc',
          idempotencyKey: values.key,
        })
        .returning()
        .then((rows) => rows[0]!);
    const makerKey = `leak-maker-${tag}`;
    const filledKey = `leak-filled-${tag}`;
    const openKey = `leak-open-${tag}`;
    const resting = await order({
      userId: maker.user.id,
      side: 'sell',
      type: 'limit',
      qty: 1_000,
      key: makerKey,
    });
    const filled = await order({
      userId: a.id,
      side: 'buy',
      type: 'market',
      qty: PUBLIC_FILL.qty,
      filledQty: PUBLIC_FILL.qty,
      key: filledKey,
    });
    const open = await order({ userId: a.id, side: 'buy', type: 'limit', qty: 21, key: openKey });
    await t.db.insert(schema.fills).values({
      marketId: market.id,
      orderId: filled.id,
      counterpartyType: 'order',
      counterpartyOrderId: resting.id,
      outcome: 'YES',
      side: 'buy',
      qty: PUBLIC_FILL.qty,
      amountCoin: PUBLIC_FILL.amountCoin,
      priceAvgBp: PUBLIC_FILL.priceAvgBp,
    });
    await t.db.insert(schema.positions).values({
      userId: a.id,
      marketId: market.id,
      outcome: 'YES',
      qty: AMOUNTS.positionQty,
      costBasisCoin: AMOUNTS.costBasis,
      realizedPnlCoin: AMOUNTS.realizedPnl,
    });

    const paymentKey = `leak-payment-${tag}`;
    const [payment] = await t.db
      .insert(schema.payments)
      .values({
        userId: a.id,
        amountCoin: 10_000n,
        priceKrw: 9_700,
        provider: 'mock',
        status: 'succeeded',
        approvedAt: new Date(),
        idempotencyKey: paymentKey,
      })
      .returning();

    const [session] = await t.db
      .select({ token: schema.session.token })
      .from(schema.session)
      .where(eq(schema.session.userId, a.id));

    const text = (label: string, value: string): Sentinel => ({ label, value, kind: 'text' });
    const amount = (label: string, value: bigint | number): Sentinel => ({
      label,
      value: String(value),
      kind: 'amount',
    });
    return {
      a,
      b,
      admin,
      market,
      paymentId: payment!.id,
      sentinels: [
        text('user id', a.id),
        text('email', a.email),
        text('nickname', nickname),
        text('real name', realName),
        text('phone', phone),
        text('password', a.password),
        text('session token', session!.token),
        text('ledger memo', memo),
        text('filled order id', filled.id),
        text('open order id', open.id),
        text('filled order key', filledKey),
        text('open order key', openKey),
        text('counterparty user id', maker.user.id),
        text('counterparty email', maker.user.email),
        text('counterparty order id', resting.id),
        text('counterparty order key', makerKey),
        text('payment id', payment!.id),
        text('payment key', paymentKey),
        amount('available balance', AMOUNTS.available),
        amount('locked balance', AMOUNTS.locked),
        amount('position qty', AMOUNTS.positionQty),
        amount('cost basis', AMOUNTS.costBasis),
        amount('realized pnl', AMOUNTS.realizedPnl),
      ],
    };
  }

  function call(
    route: DiscoveredRoute,
    input: { params?: Record<string, string>; body?: unknown; cookie?: string },
  ) {
    const url = route.url.replaceAll(/:(\w+)/g, (_, name: string) => {
      const value = input.params?.[name];
      if (value === undefined) {
        throw new Error(`no value for :${name} of ${route.key}: add it to this file's cases`);
      }
      return encodeURIComponent(value);
    });
    const safe = SAFE_METHODS.has(route.method);
    if (!safe && input.body === undefined) {
      throw new Error(`no body for ${route.key}: add it to this file's cases`);
    }
    return t.app.inject({
      method: route.method as 'GET',
      url,
      headers: {
        origin: ORIGIN,
        ...(safe ? {} : { 'content-type': 'application/json' }),
        ...(input.cookie ? { cookie: input.cookie } : {}),
      },
      ...(safe ? {} : { payload: JSON.stringify(input.body) }),
    });
  }

  /** The labels of A's values an answer holds. */
  const leaked = (body: string) => leakedValues(body, f.sentinels);

  // ---- public routes ----------------------------------------------------------------------

  it('answers every public route without A’s private data, whoever asks', async () => {
    const answers: { route: string; caller: string; status: number; leaks: string[] }[] = [];
    const bodies = new Map<string, string>();
    for (const key of Object.keys(PUBLIC_ROUTES)) {
      for (const [caller, cookie] of [
        ['anonymous', undefined],
        ['B', f.b.cookie],
        ['A', f.a.cookie],
      ] as const) {
        const res = await call(routeOf(key), {
          params: valuesOf(PUBLIC_PARAMS, f),
          body: PUBLIC_BODIES[key]?.(f),
          cookie,
        });
        if (caller === 'anonymous') bodies.set(key, res.body);
        answers.push({
          route: key,
          caller,
          // Kept paid code answers 404 while paid Coin is off; everything else answers, so
          // the check below read a real answer and not an error.
          status: res.statusCode,
          leaks: [...leaked(res.body), ...forbiddenFields(res.body)],
        });
      }
    }
    expect(answers).toEqual(
      answers.map(({ route, caller }) => ({
        route,
        caller,
        status: PUBLIC_ROUTES[route]!.preservedPaid ? 404 : 200,
        leaks: [],
      })),
    );
    // The answers held A's market and A's fill — anonymously — so there was something to leak.
    expect(bodies.get('GET /markets')).toContain(f.market.id);
    const fills = parse(bodies.get('GET /markets/:id/fills')!) as { data: object[] };
    expect(fills.data).toEqual([
      expect.objectContaining({
        qty: PUBLIC_FILL.qty,
        amountCoin: String(PUBLIC_FILL.amountCoin),
        priceAvgBp: PUBLIC_FILL.priceAvgBp,
      }),
    ]);
  });

  it('answers better-auth’s session reads with the caller’s own session only', async () => {
    // /api/auth/* is outside Nest (OUTSIDE_NEST_ROUTES); these are the calls that read a
    // session and answer about an account.
    const read = (url: string, cookie?: string) =>
      t.app.inject({ method: 'GET', url, headers: cookie ? { cookie } : {} });
    const anonymous = await read('/api/auth/get-session');
    expect(anonymous.statusCode).toBe(200);
    expect(leaked(anonymous.body)).toEqual([]);
    for (const url of ['/api/auth/get-session', '/api/auth/list-sessions']) {
      const asB = await read(url, f.b.cookie);
      expect({ url, status: asB.statusCode, leaks: leaked(asB.body) }).toEqual({
        url,
        status: 200,
        leaks: [],
      });
    }
    expect((await read('/api/auth/get-session', f.b.cookie)).body).toContain(f.b.email);
  });

  // ---- owner-only routes ------------------------------------------------------------------

  it('never answers B with A’s data on an owner-only route, and A’s data is there', async () => {
    const password = () =>
      t.db
        .select({ hash: schema.account.password })
        .from(schema.account)
        .where(eq(schema.account.userId, f.a.id))
        .then((rows) => rows.map((row) => row.hash));
    const passwordBefore = await password();
    const answers: { route: string; status: number; leaks: string[] }[] = [];
    const shown: { route: string; status: number; missing: string[] }[] = [];
    for (const key of Object.keys(OWNER_ROUTES)) {
      const ownerCase = OWNER_CASES[key];
      if (!ownerCase) continue; // the case above names it
      const route = routeOf(key);
      const params = valuesOf(ownerCase.params, f);
      const res = await call(route, { params, body: ownerCase.body?.(f), cookie: f.b.cookie });
      answers.push({ route: key, status: res.statusCode, leaks: leaked(res.body) });
      if (ownerCase.own) {
        const own = await call(route, { params, cookie: f.a.cookie });
        const held = leaked(own.body);
        shown.push({
          route: key,
          status: own.statusCode,
          missing: ownerCase.own.filter((label) => !held.includes(label)),
        });
      }
    }
    expect(answers).toEqual(
      answers.map(({ route }) => ({ route, status: OWNER_CASES[route]!.status, leaks: [] })),
    );
    expect(shown).toEqual(shown.map(({ route }) => ({ route, status: 200, missing: [] })));

    // B's refused writes changed nothing of A's.
    const [contact] = await t.db
      .select()
      .from(schema.userContacts)
      .where(eq(schema.userContacts.userId, f.a.id));
    const sentinel = (label: string) => f.sentinels.find((s) => s.label === label)!.value;
    expect(contact).toMatchObject({ realName: sentinel('real name'), phone: sentinel('phone') });
    expect(passwordBefore).toHaveLength(1);
    expect(await password()).toEqual(passwordBefore);
  });

  // ---- the market room --------------------------------------------------------------------

  async function openSocket(cookie?: string): Promise<ClientSocket> {
    const socket = io(`${t.url!}${REALTIME_NAMESPACE}`, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
      ...(cookie ? { extraHeaders: { cookie, origin: ORIGIN } } : {}),
    });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('socket did not connect')), 5_000);
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

  /**
   * Subscribes and waits until the gateway has applied it: `marketIds: []` is refused, and the
   * gateway handles one socket's messages in order (market.gateway.test.ts `roundTrip`).
   */
  async function subscribe(socket: ClientSocket, marketId: string): Promise<void> {
    socket.emit('subscribe', { marketIds: [marketId] });
    const refused = new Promise<void>((resolve) => {
      socket.once(REALTIME_EXCEPTION_EVENT, () => resolve());
    });
    socket.emit('subscribe', { marketIds: [] });
    await refused;
  }

  it('keeps the market room public: none of A’s events, values or fields reach it', async () => {
    const watchers = { anonymous: await openSocket(), B: await openSocket(f.b.cookie) };
    const received: { watcher: string; event: string; payload: unknown }[] = [];
    for (const [watcher, socket] of Object.entries(watchers)) {
      await subscribe(socket, f.market.id);
      socket.onAny((event: string, payload: unknown) => {
        received.push({ watcher, event, payload });
      });
    }

    // A's own events: published to A's room as the API does, and smuggled onto the market's.
    const ts = new Date().toISOString();
    const own = {
      'user:balance': {
        type: 'user:balance',
        availableCoin: String(AMOUNTS.available),
        lockedCoin: String(AMOUNTS.locked),
        ledgerEntryId: '1',
        ts,
      },
      'user:position': {
        type: 'user:position',
        marketId: f.market.id,
        outcome: 'YES',
        qty: AMOUNTS.positionQty,
        costBasisCoin: String(AMOUNTS.costBasis),
        realizedPnlCoin: String(AMOUNTS.realizedPnl),
        settled: false,
        version: 1,
        ts,
      },
    } satisfies { [K in UserRealtimeEvent['type']]: Extract<UserRealtimeEvent, { type: K }> };
    const publisher = t.app.get(MarketPublisher);
    const raw = new Redis(process.env.TEST_REDIS_URL!, { maxRetriesPerRequest: 1 });
    try {
      for (const event of Object.values(own)) {
        await publisher.publishUser(f.a.id, event);
        await raw.publish(marketChannel(f.market.id), JSON.stringify(event));
      }
    } finally {
      await raw.quit();
    }
    // Then a real public event, published after them: the admin closes the market.
    const closed = await t.app.inject({
      method: 'POST',
      url: `/api/v1/admin/markets/${f.market.id}/close`,
      headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: f.admin.cookie },
      payload: '{}',
    });
    expect(closed.statusCode).toBe(200);
    const started = Date.now();
    while (received.filter((entry) => entry.event === 'market:status').length < 2) {
      if (Date.now() - started > 5_000) throw new Error('market:status did not reach both');
      await sleep(20);
    }

    // Delivered in publish order on one subscriber connection, so everything A's events could
    // have caused has arrived by now.
    expect(received.map(({ watcher, event }) => `${watcher} ${event}`).sort()).toEqual([
      'B market:status',
      'anonymous market:status',
    ]);
    for (const { event, payload } of received) {
      const registered = REALTIME_EVENT_REGISTRY[event as keyof typeof REALTIME_EVENT_REGISTRY];
      expect({ event, channel: registered?.channel }).toEqual({ event, channel: 'market' });
      const body = JSON.stringify(payload);
      expect({ event, leaks: [...leaked(body), ...forbiddenFields(body)] }).toEqual({
        event,
        leaks: [],
      });
    }
  });
});
